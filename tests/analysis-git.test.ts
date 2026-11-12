import { parseSnapshot } from '../src/lib/snapshot';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractHistory, mergeTitleFromBody } from '../src/analysis/git';
import { UnsupportedRepositoryError } from '../src/analysis/errors';
import { buildGraph } from '../src/analysis/graph';
import { analyzeRepository, defaultLimits } from '../src/analysis';
import { analysisFailure } from '../src/workflows/analysis-protocol';

async function git(
  directory: string,
  args: string[],
  input?: Buffer | string,
  date = '2022-01-01T00:00:00Z',
  bot = false,
) {
  const child = spawn('git', ['-C', directory, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: bot ? 'fixture[bot]' : 'Fixture Person',
      GIT_AUTHOR_EMAIL: bot ? 'fixture[bot]@users.noreply.github.com' : 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture Person',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
      GIT_NO_LAZY_FETCH: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const chunks: Buffer[] = [];
  let error = '';
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => {
    error += chunk.toString();
  });
  const completed = new Promise<Buffer>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(error)),
    );
  });
  child.stdin.end(input);
  return completed;
}

test('only a GitHub pull request merge takes its body line as the title', () => {
  for (const subject of [
    'Auto merge of #29929 - user:branch, r=reviewer',
    'Rollup merge of #40000 - user:branch, r=reviewer',
  ]) {
    assert.equal(mergeTitleFromBody(subject, 'A PR title\n\n'), undefined, subject);
  }
  const pull = (number: number) => `Merge pull request #${number} from user/branch`;
  assert.equal(
    mergeTitleFromBody(pull(280), 'Replace React with Vue\n\n'),
    'Replace React with Vue',
  );
  assert.equal(
    mergeTitleFromBody(pull(280), '\n\nReplace React with Vue\n'),
    'Replace React with Vue',
  );
  assert.equal(mergeTitleFromBody(pull(280), '\n\n'), undefined);
});

test('first-parent deltas reconstruct every tree without fetching blobs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lore-git-'));
  const repo = join(root, 'origin.git');
  await git(root, ['init', '--bare', repo]);
  const blob = async (text: string) =>
    (await git(repo, ['hash-object', '-w', '--stdin'], text)).toString().trim();
  const a = await blob('one\n');
  const b = await blob('two\n');
  const link = await blob('target');
  const unique = await blob('exact unique');
  const edited = await blob('before edit');
  const afterEdit = await blob('after edit');
  type Entry = { path: Buffer; mode: string; oid: string };
  const entries = new Map<string, Entry>();
  function set(path: string | Buffer, oid: string, mode = '100644') {
    const bytes = Buffer.isBuffer(path) ? path : Buffer.from(path);
    entries.set(bytes.toString('hex'), { path: bytes, mode, oid });
  }
  function del(path: string) {
    entries.delete(Buffer.from(path).toString('hex'));
  }
  async function commit(subject: string, parents: string[], date?: string) {
    const input = Buffer.concat(
      [...entries.values()].map((entry) =>
        Buffer.concat([
          Buffer.from(
            `${entry.mode} ${entry.mode === '160000' ? 'commit' : 'blob'} ${entry.oid}\t`,
          ),
          entry.path,
          Buffer.from([0]),
        ]),
      ),
    );
    const tree = (await git(repo, ['mktree', '-z'], input)).toString().trim();
    return (
      await git(
        repo,
        ['commit-tree', tree, ...parents.flatMap((sha) => ['-p', sha])],
        `${subject}\n`,
        date,
        subject === 'bulk lifecycle',
      )
    )
      .toString()
      .trim();
  }
  try {
    set('exact-old', unique);
    set('edited-old', edited);
    set('ambiguous-a', b);
    set('ambiguous-b', b);
    set('copy-source', a);
    set('recreated', b);
    set('merge-deleted', a);
    set('script', a, '100755');
    set('link', link, '120000');
    set(Buffer.from([0x77, 0x65, 0x69, 0x72, 0x64, 0xff, 0x09, 0x0a]), a);
    set(Buffer.from([0x77, 0x65, 0x69, 0x72, 0x64, 0xfe, 0x09, 0x0a]), a);
    const first = await commit('root', [], '2022-03-01T00:00:00Z');
    set('submodule', first, '160000');
    set(Buffer.from([0x77, 0x65, 0x69, 0x72, 0x64, 0xff, 0x09, 0x0a]), b);
    del('exact-old');
    set('exact-new', unique, '100755');
    del('edited-old');
    set('edited-new', afterEdit);
    del('ambiguous-a');
    del('ambiguous-b');
    set('ambiguous-new', b);
    set('copy-new', a);
    del('recreated');
    const second = await commit('moves and copies', [first], '2022-01-01T00:00:00Z');
    set('recreated', b);
    set('script', a, '100644');
    const third = await commit('recreation and mode', [second], '2022-02-01T00:00:00Z');
    const saved = new Map(entries);
    set('side-only', b);
    const side = await commit('side branch', [second]);
    entries.clear();
    for (const [key, value] of saved) entries.set(key, value);
    set('merge-only', b);
    del('merge-deleted');
    const merged = await commit('merge-only changes', [third, side]);
    for (let i = 0; i < 270; i++) set(`bulk-${i}`, a);
    const head = await commit('bulk lifecycle', [merged]);
    await git(repo, ['update-ref', 'refs/heads/main', head]);
    await git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    await git(repo, ['tag', 'v1.0.0', second]);
    await git(root, [
      '-c',
      'uploadpack.allowFilter=true',
      '-C',
      repo,
      'config',
      'uploadpack.allowFilter',
      'true',
    ]);
    const clone = join(root, 'clone.git');
    await git(root, ['clone', '--bare', '--filter=blob:none', `file://${repo}`, clone]);
    await rename(repo, join(root, 'unreachable.git'));
    const packDirectory = join(clone, 'objects/pack');
    const packsBefore = await readdir(packDirectory);
    for (const pack of packsBefore.filter((name) => name.endsWith('.idx'))) {
      const listing = (
        await git(clone, ['verify-pack', '-v', join(packDirectory, pack)])
      ).toString();
      assert.equal(/^[a-f0-9]+ blob /m.test(listing), false, 'clone contains no blob objects');
    }
    let compared = 0;
    const history = await extractHistory({
      directory: clone,
      head,
      maxCommits: 100,
      maxTracks: 1000,
      onTree: async (commit, tree) => {
        const actual = await git(clone, ['ls-tree', '-r', '-z', commit.sha]);
        const reconstructed = Buffer.concat(
          [...tree.values()]
            .sort((x, y) => Buffer.compare(x.path, y.path))
            .map((entry) =>
              Buffer.concat([
                Buffer.from(
                  `${entry.mode} ${entry.mode === '160000' ? 'commit' : 'blob'} ${entry.oid}\t`,
                ),
                entry.path,
                Buffer.from([0]),
              ]),
            ),
        );
        assert.deepEqual(reconstructed, actual, `tree at ${commit.subject}`);
        compared++;
      },
    });
    assert.equal(compared, 5);
    assert.equal(history.totalCommits, 6);
    assert.deepEqual(
      history.commits.map((commit) => commit.subject),
      ['root', 'moves and copies', 'recreation and mode', 'merge-only changes', 'bulk lifecycle'],
    );
    assert.equal(history.commits[3].merge, true);
    assert.equal(history.commits[4].bulk, true);
    assert.equal(history.commits[4].created, 270);
    assert.deepEqual(history.tracks.find((track) => track.path === 'exact-new')?.paths, [
      [0, 'exact-old'],
      [1, 'exact-new'],
    ]);
    assert.deepEqual(
      history.tracks
        .filter((track) => track.path === 'recreated')
        .map(({ born, died }) => ({ born, died })),
      [
        { born: 0, died: 1 },
        { born: 2, died: null },
      ],
    );
    assert.equal(history.tracks.find((track) => track.path === 'edited-old')?.died, 1);
    assert.equal(history.tracks.find((track) => track.path === 'edited-new')?.born, 1);
    assert.equal(history.tracks.find((track) => track.path === 'ambiguous-new')?.born, 1);
    assert.equal(history.tracks.find((track) => track.path === 'copy-new')?.born, 1);
    assert.equal(history.tracks.find((track) => track.path === 'merge-only')?.born, 3);
    assert.equal(history.tracks.find((track) => track.path === 'merge-deleted')?.died, 3);
    assert.equal(history.tracks.find((track) => track.path === 'submodule')?.kind, 'submodule');
    assert.equal(history.tracks.find((track) => track.path === 'link')?.kind, 'symlink');
    assert.deepEqual(
      history.tracks
        .filter((track) => track.path === 'weird\uFFFD\t\n')
        .map((track) => track.touches)
        .sort((a, b) => a.length - b.length),
      [[0], [0, 1]],
    );
    assert.deepEqual(history.authors, [
      { id: 0, kind: 'anonymous', label: 'Contributor 1' },
      { id: 1, kind: 'bot', label: 'Bot 2' },
    ]);
    assert.deepEqual(
      history.commits.map((commit) => commit.time),
      [1646092800, 1646092800, 1646092800, 1646092800, 1646092800],
    );
    assert.deepEqual(
      await readdir(packDirectory),
      packsBefore,
      'extraction added no downloaded packs',
    );
    const snapshot = await analyzeRepository({
      directory: clone,
      repository: {
        owner: 'fixture',
        name: 'history',
        slug: 'fixture/history',
        head,
        branch: 'main',
        description: '',
        stars: 0,
      },
      snapshotId: '0123456789abcdef01234567',
      limits: { maxFiles: 5, maxPairs: 1, maxEdges: 1, maxPairsPerCommit: 1, layoutIterations: 4 },
    });
    parseSnapshot(snapshot);
    const stored = {
      ...snapshot,
      coverage: {
        ...snapshot.coverage,
        displayedFiles: history.tracks.length,
        filesSampled: false,
      },
      files: history.tracks.map((track) => ({ ...track, position: [0, 0, 0], directory: '' })),
    };
    assert(
      history.tracks.some((track) => track.died !== null && track.touches.includes(track.died)),
      'Fixture includes a deletion touch',
    );
    assert.equal(parseSnapshot(stored).files.length, history.tracks.length);
    assert.equal(snapshot.files.length, 5);
    assert.equal(snapshot.coverage.totalFiles, 287);
    assert.equal(snapshot.coverage.filesSampled, true);
    assert.equal(snapshot.commits[4].created, 270);
    assert.deepEqual(
      snapshot.eras.map(({ start, end }) => ({ start, end })),
      [{ start: 0, end: 5 }],
    );
    assert.equal(JSON.stringify(snapshot).includes('fixture@example.test'), false);
    assert.equal(snapshot.eras[0].created, 17);
    assert.equal(snapshot.coverage.totalCommits, 6);
    assert.equal(snapshot.coverage.analyzedCommits, 5);
    assert.deepEqual(history.tracks.find((track) => track.path === 'script')?.authors, [
      { id: 0, touches: 2 },
    ]);
    assert.deepEqual(history.tracks.find((track) => track.path === 'bulk-0')?.authors, [
      { id: 1, touches: 1 },
    ]);
    for (const era of snapshot.eras) {
      assert.equal(era.narration, 'facts');
      for (const beat of era.beats) {
        assert.equal(beat.kind, 'fact');
        if (beat.kind === 'fact')
          assert.equal(beat.text, era.facts.find((fact) => fact.id === beat.ref)?.text);
      }
      for (const item of era.sheet.filter((value) => value.kind === 'commit'))
        assert.equal(
          item.text,
          snapshot.commits.find((commit) => commit.sha === item.commits[0])?.subject,
        );
    }
    assert.equal(
      snapshot.eras[0].facts.some((fact) => fact.text.includes('v1.0.0')),
      true,
    );
    const bounded = buildGraph(history, history.tracks, {
      ...defaultLimits,
      maxPairs: 2,
      maxEdges: 1,
      maxPairsPerCommit: 1,
    });
    assert.deepEqual(
      {
        pairs: bounded.coverage.pairUpdates,
        edges: bounded.edges.length,
        eligible: bounded.coverage.eligibleGraphCommits,
        selected: bounded.coverage.selectedGraphCommits,
      },
      { pairs: 2, edges: 1, eligible: 4, selected: 2 },
    );
    assert.deepEqual(
      buildGraph(history, history.tracks, {
        ...defaultLimits,
        maxPairs: 2,
        maxEdges: 1,
        maxPairsPerCommit: 1,
      }),
      bounded,
    );
    await assert.rejects(
      extractHistory({ directory: clone, head, maxCommits: 4, maxTracks: 1000 }),
      /history exceeds 4 commits/,
    );
    await assert.rejects(
      extractHistory({ directory: clone, head, maxCommits: 100, maxTracks: 5 }),
      /Unsupported repository/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('trees deeper than the supported directory nesting are unsupported', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lore-deep-'));
  const repo = join(root, 'repo.git');
  try {
    await git(root, ['init', '--bare', repo]);
    const blob = (await git(repo, ['hash-object', '-w', '--stdin'], 'leaf\n')).toString().trim();
    let tree = (await git(repo, ['mktree'], `100644 blob ${blob}\tfile\n`)).toString().trim();
    for (let depth = 0; depth < 600; depth++)
      tree = (await git(repo, ['mktree'], `040000 tree ${tree}\td\n`)).toString().trim();
    const head = (await git(repo, ['commit-tree', tree], 'Too deep\n')).toString().trim();
    await git(repo, ['update-ref', 'refs/heads/main', head]);
    const repository = {
      owner: 'fixture',
      name: 'deep',
      slug: 'fixture/deep',
      head,
      branch: 'main',
      description: '',
      stars: 0,
    };
    const error = await analyzeRepository({
      directory: repo,
      repository,
      snapshotId: '0123456789abcdef01234567',
    }).then(
      () => null,
      (reason: unknown) => reason,
    );
    assert.ok(error instanceof UnsupportedRepositoryError);
    assert.equal(analysisFailure(error).kind, 'unsupported');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('trees deeper than the git tree limit are unsupported', { timeout: 600_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'lore-max-tree-'));
  const repo = join(root, 'repo.git');
  try {
    await git(root, ['init', '--bare', repo]);
    const blob = (await git(repo, ['hash-object', '-w', '--stdin'], 'leaf\n')).toString().trim();
    let tree = (await git(repo, ['mktree'], `100644 blob ${blob}\tfile\n`)).toString().trim();
    for (let depth = 0; depth < 4096; depth++)
      tree = (await git(repo, ['mktree'], `040000 tree ${tree}\td\n`)).toString().trim();
    const head = (await git(repo, ['commit-tree', tree], 'Too deep\n')).toString().trim();
    await git(repo, ['update-ref', 'refs/heads/main', head]);
    const error = await analyzeRepository({
      directory: repo,
      repository: {
        owner: 'fixture',
        name: 'max-tree',
        slug: 'fixture/max-tree',
        head,
        branch: 'main',
        description: '',
        stars: 0,
      },
      snapshotId: '0123456789abcdef01234567',
    }).then(
      () => null,
      (reason: unknown) => reason,
    );
    assert.ok(error instanceof UnsupportedRepositoryError);
    assert.equal(analysisFailure(error).kind, 'unsupported');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('history credits each merged branch once, skips merge bots, and dates commits by clamped author time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lore-credits-'));
  const repo = join(root, 'repo.git');
  try {
    await git(root, ['init', '--bare', repo]);
    const tree = (await git(repo, ['mktree', '-z'], '')).toString().trim();
    const commit = async (
      subject: string,
      parents: string[],
      who: [string, string],
      authored: string,
      committed: string,
    ) => {
      const child = spawn(
        'git',
        ['-C', repo, 'commit-tree', tree, ...parents.flatMap((sha) => ['-p', sha])],
        {
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: who[0],
            GIT_AUTHOR_EMAIL: who[1],
            GIT_COMMITTER_NAME: 'Committer',
            GIT_COMMITTER_EMAIL: 'committer@example.test',
            GIT_AUTHOR_DATE: authored,
            GIT_COMMITTER_DATE: committed,
          },
        },
      );
      const chunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.stdin.end(`${subject}\n`);
      await new Promise((resolve) => child.on('close', resolve));
      return Buffer.concat(chunks).toString().trim();
    };
    const alice: [string, string] = ['Alice', 'alice@example.test'];
    const first = await commit('root', [], alice, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z');
    const side = await commit(
      'Fix parser',
      [first],
      ['Bob', '12345+bob@users.noreply.github.com'],
      '2020-02-01T00:00:00Z',
      '2020-02-01T00:00:00Z',
    );
    const merged = await commit(
      'Merge pull request #7 from carol/fix',
      [first, side],
      ['Merger', 'merger@example.test'],
      '2020-06-01T00:00:00Z',
      '2020-06-01T00:00:00Z',
    );
    const late = await commit(
      'Land an old patch',
      [merged],
      alice,
      '2016-01-01T00:00:00Z',
      '2020-07-01T00:00:00Z',
    );
    const head = await commit(
      'Commit with a skewed author clock',
      [late],
      ['Dave', 'dave@example.test'],
      '2030-01-01T00:00:00Z',
      '2021-01-01T00:00:00Z',
    );
    const rolled = await commit(
      'Rollup merge of #8 - carol:docs',
      [first],
      ['Erin', 'erin@users.noreply.github.com'],
      '2020-03-01T00:00:00Z',
      '2020-03-01T00:00:00Z',
    );
    const bors = await commit(
      'Auto merge of #9 - erin:rollup-1',
      [head, rolled],
      ['bors', 'bors@rust-lang.org'],
      '2021-02-01T00:00:00Z',
      '2021-02-01T00:00:00Z',
    );
    const branch = async (subject: string, parent: string, who: string) =>
      commit(
        subject,
        [
          parent,
          await commit(
            'Work',
            [first],
            [who, `${who}@users.noreply.github.com`],
            '2020-04-01T00:00:00Z',
            '2020-04-01T00:00:00Z',
          ),
        ],
        ['Merger', 'merger@example.test'],
        '2021-03-01T00:00:00Z',
        '2021-03-01T00:00:00Z',
      );
    const gus = await branch('Merge pull request #10 from acme/a', bors, 'gus');
    const hal = await branch('Merge pull request #11 from acme/b', gus, 'hal');
    const history = await extractHistory({
      directory: repo,
      head: hal,
      maxCommits: 10,
      maxTracks: 10,
    });
    assert.deepEqual(history.credits, [
      ['#0'],
      ['#1', '@bob'],
      ['#0'],
      ['#2'],
      ['@erin', '@bob'],
      ['#1', '@gus'],
      ['#1', '@hal'],
    ]);
    assert.deepEqual(
      history.commits.map((commit) => new Date(commit.time * 1000).toISOString().slice(0, 10)),
      [
        '2020-01-01',
        '2020-06-01',
        '2020-06-01',
        '2021-01-01',
        '2021-02-01',
        '2021-03-01',
        '2021-03-01',
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
