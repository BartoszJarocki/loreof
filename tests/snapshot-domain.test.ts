import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSnapshot } from '../src/lib/snapshot';
import { snapshotFixture } from './fixtures/snapshot';

function historyFixture() {
  const snapshot = snapshotFixture();
  snapshot.commits.push(
    { ...snapshot.commits[0], sha: 'b'.repeat(40), time: 2, created: 0 },
    { ...snapshot.commits[0], sha: 'c'.repeat(40), time: 3, created: 0 },
  );
  snapshot.repository.head = 'c'.repeat(40);
  snapshot.endTime = 3;
  snapshot.coverage.totalCommits = 3;
  snapshot.coverage.analyzedCommits = 3;
  snapshot.files[0].touches = [0, 1, 2];
  snapshot.files[0].authors[0].touches = 3;
  snapshot.eras[0].end = 2;
  snapshot.eras[0].endTime = 2;
  snapshot.eras.push({
    ...structuredClone(snapshot.eras[0]),
    id: 1,
    start: 2,
    end: 3,
    startTime: 3,
    endTime: 3,
    title: 'Chapter 2',
    created: 0,
    facts: [],
    beats: [],
  });
  return snapshot;
}

test('snapshot parsing rejects unordered touches used by playback binary search', () => {
  const snapshot = historyFixture();
  assert.deepEqual(parseSnapshot(snapshot).files[0].touches, [0, 1, 2]);
  snapshot.files[0].touches.reverse();
  assert.throws(() => parseSnapshot(snapshot), /touch/);
});

test('snapshot parsing requires chapters to partition all commits', () => {
  const snapshot = historyFixture();
  assert.equal(parseSnapshot(snapshot).eras[1].start, 2);
  snapshot.eras[1].start = 1;
  assert.throws(() => parseSnapshot(snapshot), /partition/);
});

test('snapshot parsing keeps fact evidence inside its chapter', () => {
  const snapshot = historyFixture();
  assert.deepEqual(parseSnapshot(snapshot).eras[0].facts[0].commits, ['a'.repeat(40)]);
  snapshot.eras[0].facts[0].commits = ['c'.repeat(40)];
  assert.throws(() => parseSnapshot(snapshot), /chapter/);
});

test('snapshot contributors stay between non-merge authors and three credits per commit', () => {
  const snapshot = historyFixture();
  snapshot.authors.push({ kind: 'github', id: 1, handle: 'merger' });
  snapshot.commits[1].author = 1;
  snapshot.commits[1].merge = true;
  const counted = (contributors: number) => {
    const value = structuredClone(snapshot);
    value.eras[0].contributors = contributors;
    return parseSnapshot(value).eras[0].contributors;
  };
  assert.equal(counted(1), 1);
  assert.equal(counted(6), 6);
  assert.throws(() => counted(0), /totals/);
  assert.throws(() => counted(7), /totals/);
  assert.throws(() => counted(1e9), /totals/);
});

test('snapshot boundaries reject inconsistent coverage, authors, paths, dates, and claims', () => {
  const valid = historyFixture();
  assert.deepEqual(parseSnapshot(valid), valid);
  const cases: { mutate: (value: typeof valid) => void; message: RegExp }[] = [
    {
      mutate: (value) => {
        value.coverage.analyzedCommits = 2;
      },
      message: /coverage/,
    },
    {
      mutate: (value) => {
        value.coverage.displayedFiles = 2;
      },
      message: /coverage/,
    },
    {
      mutate: (value) => {
        value.coverage.totalFiles = 0;
      },
      message: /coverage/,
    },
    {
      mutate: (value) => {
        value.coverage.selectedGraphCommits = 2;
      },
      message: /coverage/,
    },
    {
      mutate: (value) => {
        value.coverage.filesSampled = true;
      },
      message: /coverage/,
    },
    {
      mutate: (value) => {
        value.files[0].authors[0].id = 9;
      },
      message: /author/,
    },
    {
      mutate: (value) => {
        value.commits[1].author = 9;
      },
      message: /author/,
    },
    {
      mutate: (value) => {
        value.authors.push(value.authors[0]);
      },
      message: /duplicate/,
    },
    {
      mutate: (value) => {
        value.files[0].paths.push([1, 'new.md']);
      },
      message: /path intervals/,
    },
    {
      mutate: (value) => {
        value.files[0].paths.push([0, 'readme.md']);
      },
      message: /path intervals/,
    },
    {
      mutate: (value) => {
        value.files[0].died = 3;
      },
      message: /lifetime/,
    },
    {
      mutate: (value) => {
        value.eras[0].created = 2;
      },
      message: /totals/,
    },
    {
      mutate: (value) => {
        value.eras[0].contributors = 0;
      },
      message: /totals/,
    },
    {
      mutate: (value) => {
        const beat = value.eras[0].beats[0];
        if (beat.kind === 'fact') beat.text = 'unsupported';
      },
      message: /factual caption/,
    },
    {
      mutate: (value) => {
        const beat = value.eras[0].beats[0];
        if (beat.kind === 'fact') beat.ref = 'missing';
      },
      message: /factual caption/,
    },
    {
      mutate: (value) => {
        value.eras[0].sheet.push({
          id: 'r1',
          kind: 'release',
          text: 'v1.0.0',
          time: 1,
          commits: [value.commits[0].sha],
        });
        value.eras[0].title = 'The v99.0.0 tag';
      },
      message: /release tag/,
    },
    {
      mutate: (value) => {
        value.eras[0].facts.push(value.eras[0].facts[0]);
      },
      message: /duplicate fact/,
    },
    {
      mutate: (value) => {
        value.commits[1].time = 0;
      },
      message: /dates/,
    },
  ];
  for (const { mutate, message } of cases) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    assert.throws(() => parseSnapshot(invalid), message);
  }
  const deleted = historyFixture();
  deleted.files[0].died = 2;
  assert.deepEqual(parseSnapshot(deleted).files[0].touches, [0, 1, 2]);
});

test('an emptied current fact sheet still checks every factual title', () => {
  const snapshot = historyFixture();
  for (const era of snapshot.eras) {
    era.narration = 'facts';
    era.sheet = [];
    delete era.headline;
    era.beats = [];
  }
  for (const [index, title] of [
    [0, 'Chapter 42'],
    [1, 'The first chapter'],
    [0, 'Jan 1999 to Dec 2001'],
    [0, '99,999 non-bot integration commits'],
    [0, 'The v99.0.0 tag'],
  ] as const) {
    const changed = structuredClone(snapshot);
    changed.eras[index].title = title;
    assert.throws(() => parseSnapshot(changed), /factual chapter/);
  }
  const trueTitle = structuredClone(snapshot);
  trueTitle.eras[1].title = 'Chapter 2';
  assert.equal(parseSnapshot(trueTitle).eras[1].title, 'Chapter 2');
});

test('legacy chapters follow the snapshot pipeline version, not a missing sheet', () => {
  const snapshot = snapshotFixture();
  const era = {
    ...snapshot.eras[0],
    beats: undefined,
    sheet: undefined,
    headline: undefined,
    title: 'The v99.0.0 tag',
    titleOptions: ['The first chapter', 'The v99.0.0 tag'],
    summary: 'One file was created.',
    narration: 'model-selected',
    claims: [{ text: 'One file was created.', factId: 'f1', commits: ['a'.repeat(40)] }],
  };
  assert.throws(
    () => parseSnapshot({ ...snapshot, eras: [era] }),
    /not a release tag in this chapter/,
  );
  const legacy = parseSnapshot({ ...snapshot, pipelineVersion: 'lore-2', eras: [era] });
  assert.equal(legacy.eras[0].title, 'The v99.0.0 tag');
});

test('validation CLI uses the same semantic boundary as stored and browser snapshots', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const directory = await mkdtemp(join(tmpdir(), 'lore-snapshot-'));
  const filename = join(directory, 'snapshot.json');
  try {
    const snapshot = historyFixture();
    await writeFile(filename, JSON.stringify(snapshot));
    const verified = await run(process.execPath, [
      '--import',
      'tsx',
      resolve('scripts/validate-snapshot.ts'),
      filename,
    ]);
    const report = JSON.parse(verified.stdout);
    assert.equal(report.result, 'VERIFIED');
    assert.equal(report.commits, 3);
    snapshot.files[0].touches.reverse();
    await writeFile(filename, JSON.stringify(snapshot));
    await assert.rejects(
      run(process.execPath, ['--import', 'tsx', resolve('scripts/validate-snapshot.ts'), filename]),
      /unordered.*touches/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a model chapter title is derived from its headline commit', () => {
  const snapshot = historyFixture();
  const [first, second] = snapshot.commits;
  snapshot.eras[0] = {
    ...snapshot.eras[0],
    narration: 'model',
    headline: 'c1',
    title: 'Initial commit',
    sheet: [
      { id: 'c1', kind: 'commit', text: first.subject, time: first.time, commits: [first.sha] },
      { id: 'c2', kind: 'commit', text: second.subject, time: second.time, commits: [second.sha] },
    ],
    beats: [
      {
        kind: 'commit',
        ref: 'c1',
        sha: first.sha.slice(0, 9),
        date: new Date(first.time * 1000).toISOString().slice(0, 10),
        subject: first.subject,
      },
      {
        kind: 'commit',
        ref: 'c2',
        sha: second.sha.slice(0, 9),
        date: new Date(second.time * 1000).toISOString().slice(0, 10),
        subject: second.subject,
      },
    ],
  };
  assert.equal(parseSnapshot(snapshot).eras[0].title, 'Initial commit');
  const changed = structuredClone(snapshot);
  changed.eras[0].title = 'A rewritten title';
  assert.throws(() => parseSnapshot(changed), /does not match its headline/);
});

test('a model chapter cannot carry a factual-shaped title', () => {
  const snapshot = historyFixture();
  const [first, second] = snapshot.commits;
  snapshot.commits[0].subject = 'Chapter 2';
  snapshot.eras[0] = {
    ...snapshot.eras[0],
    narration: 'model',
    headline: 'c1',
    title: 'Chapter 2',
    sheet: [
      { id: 'c1', kind: 'commit', text: 'Chapter 2', time: first.time, commits: [first.sha] },
      { id: 'c2', kind: 'commit', text: second.subject, time: second.time, commits: [second.sha] },
    ],
    beats: [
      {
        kind: 'commit',
        ref: 'c1',
        sha: first.sha.slice(0, 9),
        date: new Date(first.time * 1000).toISOString().slice(0, 10),
        subject: 'Chapter 2',
      },
      {
        kind: 'commit',
        ref: 'c2',
        sha: second.sha.slice(0, 9),
        date: new Date(second.time * 1000).toISOString().slice(0, 10),
        subject: second.subject,
      },
    ],
  };
  assert.throws(() => parseSnapshot(snapshot), /factual-shaped/);
});

test('a stored chapter that fails grounding loads as factual captions', () => {
  const snapshot = historyFixture();
  const [first, second] = snapshot.commits;
  snapshot.eras[0] = {
    ...snapshot.eras[0],
    narration: 'model',
    title: 'Hooks arrive',
    sheet: [
      { id: 'c1', kind: 'commit', text: first.subject, time: first.time, commits: [first.sha] },
      { id: 'c2', kind: 'commit', text: second.subject, time: second.time, commits: [second.sha] },
    ],
    beats: [
      {
        kind: 'commit',
        ref: 'c1',
        sha: first.sha.slice(0, 9),
        date: new Date(first.time * 1000).toISOString().slice(0, 10),
        subject: first.subject,
      },
      {
        kind: 'commit',
        ref: 'c2',
        sha: second.sha.slice(0, 9),
        date: new Date(second.time * 1000).toISOString().slice(0, 10),
        subject: second.subject,
      },
    ],
  };
  const era = parseSnapshot(snapshot).eras[0];
  assert.equal(era.narration, 'facts');
  assert.equal(era.title, 'Jan 1970 to Jan 1970');
  assert.deepEqual(era.beats, [{ kind: 'fact', ref: 'f1', text: 'One file was created.' }]);
});

test('a stored chapter from the old beat shape loads as factual captions', () => {
  const snapshot = snapshotFixture();
  snapshot.eras[0] = {
    ...snapshot.eras[0],
    narration: 'model',
    title: 'Hooks arrive',
    beats: [{ text: 'Hooks arrive.', refs: ['f1'] }],
  } as unknown as (typeof snapshot.eras)[0];
  const era = parseSnapshot(snapshot).eras[0];
  assert.equal(era.narration, 'facts');
  assert.deepEqual(era.beats, [{ kind: 'fact', ref: 'f1', text: 'One file was created.' }]);
});
