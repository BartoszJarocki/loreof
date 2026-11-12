import { UnsupportedRepositoryError } from './errors';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { boundText } from '../lib/text';
import type { Author, Commit, FileTrack } from '../lib/schema';

export type TreeEntry = { path: Buffer; mode: string; oid: string; track: number };
export type Track = Omit<FileTrack, 'position' | 'directory'>;
export type History = {
  totalCommits: number;
  commits: Commit[];
  authors: Author[];
  tracks: Track[];
  tags: { name: string; sha: string }[];
  titles?: Map<string, string>;
  credits: string[][];
};
export type ExtractionOptions = {
  directory: string;
  head: string;
  maxCommits: number;
  maxTracks: number;
  onTree?: (commit: Commit, tree: ReadonlyMap<string, TreeEntry>) => void | Promise<void>;
};

// Only what git needs to run. The operator's environment and Git configuration
// must not change how a repository is read.
const gitEnvironment: Record<string, string | undefined> = {
  ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
  ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_NO_LAZY_FETCH: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
};

export async function gitBuffer(
  directory: string,
  args: string[],
  maxBytes = 16 * 1024 * 1024,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  await gitStream(directory, args, (chunk) => {
    bytes += chunk.length;
    if (bytes > maxBytes)
      throw new UnsupportedRepositoryError(`Git output exceeds ${maxBytes} bytes`);
    chunks.push(chunk);
  });
  return Buffer.concat(chunks);
}

async function gitStream(
  directory: string,
  args: string[],
  consume: (chunk: Buffer) => void | Promise<void>,
  input?: string,
) {
  const child = spawn('git', ['-C', directory, ...args], {
    env: gitEnvironment as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
  });
  const completion = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve();
      if (stderr.includes('exceeded maximum allowed tree depth'))
        return reject(new UnsupportedRepositoryError('Repository exceeds the maximum tree depth'));
      reject(new Error(`Git exited ${code}: ${stderr}`));
    });
  });
  completion.catch(() => {});
  try {
    for await (const chunk of child.stdout) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Git stream was not binary');
      await consume(chunk);
    }
    await completion;
  } catch (error) {
    child.kill('SIGTERM');
    await completion.catch(() => {});
    throw error;
  }
}

type Change = {
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
  status: string;
  path: Buffer;
};
const kind = (mode: string): FileTrack['kind'] =>
  mode === '160000' ? 'submodule' : mode === '120000' ? 'symlink' : 'file';
const absent = (mode: string) => mode === '000000';
const YEAR = 365 * 86400;
const HANDLE =
  /^(?:\d+\+)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)@users\.noreply\.github\.com$/i;
const PR_AUTHOR =
  /^(?:Merge pull request #\d+ from ([A-Za-z0-9-]+)\/|(?:Auto|Rollup) merge of #\d+ - ([A-Za-z0-9-]+):|auto merge of #\d+ : ([A-Za-z0-9-]+)\/)/i;

function isBot(email: string, name: string) {
  return (
    /\[bot\]$/i.test(name) ||
    /\[bot\]@users\.noreply\.github\.com$/i.test(email) ||
    /^(dependabot|renovate)(?:\[bot\])?$/i.test(name) ||
    /^(dependabot|renovate)(?:@|\[bot\]@)/i.test(email)
  );
}
const MERGE_BOT = /^(?:bors|homu|k8s-ci-robot|k8s-merge-robot)$/i;
function isMergeBot(email: string, name: string) {
  return MERGE_BOT.test(name) || MERGE_BOT.test(email.split('@')[0].replace(/^\d+\+/, ''));
}
function prAuthor(subject: string): string | undefined {
  const handle = PR_AUTHOR.exec(subject)?.slice(1).find(Boolean);
  return handle && !isBot('', handle) ? `@${handle.toLowerCase()}` : undefined;
}
function identityKey(email: string, name: string) {
  return createHash('sha256')
    .update(email.toLowerCase() || name)
    .digest('hex');
}
function identity(email: string, name: string) {
  const handle = HANDLE.exec(email)?.[1];
  return handle ? `@${handle.toLowerCase()}` : identityKey(email, name);
}

export async function extractHistory(options: ExtractionOptions): Promise<History> {
  const { directory, head, maxCommits, maxTracks, onTree } = options;
  if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error('History head must be a full object ID');
  const commits: Commit[] = [];
  const authors: Author[] = [];
  const authorIds = new Map<string, number>();
  const tracks: Track[] = [];
  const tree = new Map<string, TreeEntry>();
  const authorTouches: Map<number, number>[] = [];
  const mergers: string[][] = [];
  const handles: (string | undefined)[] = [];
  const secondParents = new Map<number, string>();
  let metadata: string[] = [];
  let changes: Change[] = [];
  let pendingDescriptor: string | undefined;
  let expectingMetadata = 0;
  let pending = Buffer.alloc(0);
  let active = false;

  async function finishCommit() {
    if (!active) return;
    if (pendingDescriptor !== undefined || metadata.length !== 7)
      throw new Error('Incomplete Git record');
    if (commits.length >= maxCommits)
      throw new UnsupportedRepositoryError(
        `Unsupported repository: first-parent history exceeds ${maxCommits} commits`,
      );
    const [sha, parents, authored, committed, email, rawName, rawSubject] = metadata;
    if (
      !sha ||
      authored === undefined ||
      committed === undefined ||
      email === undefined ||
      rawName === undefined ||
      rawSubject === undefined
    )
      throw new Error('Missing commit metadata');
    const name = boundText(rawName, 100);
    const subject = boundText(rawSubject, 300);
    const authorKey = identityKey(email, name);
    let author = authorIds.get(authorKey);
    if (author === undefined) {
      author = authors.length;
      authorIds.set(authorKey, author);
      const handle = HANDLE.exec(email)?.[1];
      const bot = isBot(email, name);
      authors.push(
        bot
          ? { kind: 'bot', id: author, label: `Bot ${author + 1}` }
          : handle
            ? { kind: 'github', id: author, handle }
            : { kind: 'anonymous', id: author, label: `Contributor ${author + 1}` },
      );
    }
    const index = commits.length;
    const removed = new Map<string, Change[]>();
    const added = new Map<string, Change[]>();
    const signature = (mode: string, oid: string) => `${kind(mode)}:${oid}`;
    for (const change of changes) {
      if (absent(change.newMode)) {
        const key = signature(change.oldMode, change.oldOid);
        const group = removed.get(key);
        if (group) group.push(change);
        else removed.set(key, [change]);
      }
      if (absent(change.oldMode)) {
        const key = signature(change.newMode, change.newOid);
        const group = added.get(key);
        if (group) group.push(change);
        else added.set(key, [change]);
      }
    }
    const renames = new Map<string, TreeEntry>();
    const movedFrom = new Set<string>();
    for (const [key, deletions] of removed) {
      const additions = added.get(key);
      if (deletions.length !== 1 || additions?.length !== 1) continue;
      const entry = tree.get(deletions[0].path.toString('hex'));
      if (!entry) throw new UnsupportedRepositoryError('Rename source is missing');
      renames.set(additions[0].path.toString('hex'), entry);
      movedFrom.add(deletions[0].path.toString('hex'));
    }
    let created = 0;
    let deleted = 0;
    const touched = new Set<number>();
    for (const change of changes) {
      const key = change.path.toString('hex');
      const previous = tree.get(key);
      const typeChanged =
        previous !== undefined &&
        kind(previous.mode) !== kind(change.newMode) &&
        !absent(change.newMode);
      if (absent(change.newMode) || typeChanged) {
        if (!previous) throw new UnsupportedRepositoryError(`Deletion source is missing at ${sha}`);
        tree.delete(key);
        if (!movedFrom.has(key)) {
          tracks[previous.track].died = index;
          touched.add(previous.track);
          deleted++;
        }
      }
      if (absent(change.newMode)) continue;
      const moved = renames.get(key);
      let track: number;
      if (moved) {
        track = moved.track;
        tracks[track].paths.push([index, change.path.toString('utf8')]);
        tracks[track].path = change.path.toString('utf8');
      } else if (previous && !typeChanged) {
        track = previous.track;
      } else {
        if (tracks.length >= maxTracks)
          throw new UnsupportedRepositoryError(
            `Unsupported repository: lifecycle exceeds ${maxTracks} tracks`,
          );
        track = tracks.length;
        tracks.push({
          id: track,
          path: change.path.toString('utf8'),
          kind: kind(change.newMode),
          born: index,
          died: null,
          paths: [[index, change.path.toString('utf8')]],
          touches: [],
          authors: [],
        });
        authorTouches.push(new Map());
        created++;
      }
      tree.set(key, { path: change.path, mode: change.newMode, oid: change.newOid, track });
      touched.add(track);
    }
    for (const track of touched) {
      tracks[track].touches.push(index);
      const counts = authorTouches[track];
      counts.set(author, (counts.get(author) ?? 0) + 1);
    }
    const authoredAt = Number(authored);
    const shown = authoredAt > Number(committed) + YEAR ? Number(committed) : authoredAt;
    const time = Math.max(shown, commits.at(-1)?.time ?? shown);
    if (
      !Number.isSafeInteger(authoredAt) ||
      !Number.isSafeInteger(time) ||
      !Number.isFinite(new Date(time * 1000).getTime())
    )
      throw new UnsupportedRepositoryError('Invalid Git timestamp');
    const second = parents?.split(' ')[1];
    if (second) secondParents.set(index, second);
    mergers.push(
      authors[author].kind === 'bot' || (second && isMergeBot(email, name)) ? [] : [`#${author}`],
    );
    handles.push(prAuthor(subject));
    const commit: Commit = {
      sha,
      time,
      authoredAt,
      subject,
      author,
      files: touched.size,
      created,
      deleted,
      merge: (parents?.split(' ').length ?? 0) > 1,
      bulk: touched.size > 256,
    };
    commits.push(commit);
    await onTree?.(commit, tree);
    metadata = [];
    changes = [];
  }

  async function token(value: Buffer) {
    if (expectingMetadata > 0) {
      metadata.push(value.toString('utf8'));
      expectingMetadata--;
      return;
    }
    if (pendingDescriptor !== undefined) {
      const match = /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([A-Z])\d*$/.exec(pendingDescriptor);
      if (!match) throw new Error(`Invalid Git raw descriptor ${pendingDescriptor}`);
      if (changes.length >= maxTracks * 2)
        throw new UnsupportedRepositoryError(
          `Unsupported repository: commit delta exceeds ${maxTracks * 2} entries`,
        );
      changes.push({
        oldMode: match[1],
        newMode: match[2],
        oldOid: match[3],
        newOid: match[4],
        status: match[5],
        path: Buffer.from(value),
      });
      pendingDescriptor = undefined;
      return;
    }
    const text = value.toString('ascii').replace(/^\n+/, '');
    if (text === 'LORE-COMMIT') {
      await finishCommit();
      active = true;
      expectingMetadata = 7;
      return;
    }
    if (text.startsWith(':')) {
      pendingDescriptor = text;
      return;
    }
    if (text !== '') throw new Error(`Unexpected Git raw token ${text.slice(0, 80)}`);
  }

  await gitStream(
    directory,
    [
      'log',
      '--first-parent',
      '--reverse',
      '--root',
      '--diff-merges=first-parent',
      '--raw',
      '-z',
      '--no-renames',
      '--no-abbrev',
      '--format=%x00LORE-COMMIT%x00%H%x00%P%x00%at%x00%ct%x00%ae%x00%an%x00%s%x00',
      head,
      '--',
    ],
    async (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      let start = 0;
      for (let end = pending.indexOf(0, start); end !== -1; end = pending.indexOf(0, start)) {
        await token(pending.subarray(start, end));
        start = end + 1;
      }
      pending = Buffer.from(pending.subarray(start));
      if (pending.length > 1024 * 1024)
        throw new UnsupportedRepositoryError('Git token exceeds 1 MiB');
    },
  );
  if (pending.length && pending.toString().trim()) throw new Error('Unterminated Git token');
  await finishCommit();
  if (!commits.length) throw new Error('Repository has no commits');
  tracks.forEach((track, index) => {
    track.authors = [...authorTouches[index]]
      .map(([id, touches]) => ({ id, touches }))
      .sort((a, b) => b.touches - a.touches || a.id - b.id);
  });
  const tagOutput = await gitBuffer(directory, [
    'for-each-ref',
    '--format=%(refname:short)%00%(*objectname)%00%(objectname)',
    'refs/tags',
  ]);
  const tags = tagOutput
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const [raw, peeled, object] = line.split('\0');
      const name = boundText(raw, 200);
      if (!name || name !== raw) return [];
      return [{ name, sha: peeled || object }];
    });
  const totalCommits = Number(
    (await gitBuffer(directory, ['rev-list', '--count', head])).toString().trim(),
  );
  if (!Number.isSafeInteger(totalCommits) || totalCommits < commits.length)
    throw new Error('Invalid reachable commit count');
  const titles = await mergeTitles(directory, head);
  for (const commit of commits) {
    const title = titles.get(commit.sha);
    if (title && commit.merge) commit.mergeTitle = title;
  }
  const branches = await mergedBranches(directory, secondParents);
  const known = new Map<string, string>();
  for (const [key, id] of authorIds) known.set(key, `#${id}`);
  for (const author of authors)
    if (author.kind === 'github' && !known.has(`@${author.handle.toLowerCase()}`))
      known.set(`@${author.handle.toLowerCase()}`, `#${author.id}`);
  const paired = new Map<string, Map<string, number>>();
  for (const [tick, sha] of secondParents) {
    const handle = handles[tick];
    const branch = branches.get(sha)?.author;
    if (!handle || !branch) continue;
    const counts = paired.get(handle) ?? new Map<string, number>();
    paired.set(handle, counts.set(branch, (counts.get(branch) ?? 0) + 1));
  }
  // A person's merged branches are mostly theirs; an organization's branch prefix has no majority author.
  for (const [handle, counts] of paired) {
    const [branch, count] = [...counts].sort((a, b) => b[1] - a[1])[0];
    const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
    if (count * 2 > total && !known.has(handle)) known.set(handle, known.get(branch) ?? branch);
  }
  const credits = mergers.map((names, tick) => {
    const branch = branches.get(secondParents.get(tick) ?? '');
    const all = [...names, branch?.author ?? handles[tick], branch?.handle];
    return [
      ...new Set(all.filter((name) => name !== undefined).map((name) => known.get(name) ?? name)),
    ];
  });
  return {
    totalCommits,
    commits,
    authors,
    tracks,
    tags,
    titles,
    credits,
  };
}

async function mergedBranches(directory: string, parents: Map<number, string>) {
  const branches = new Map<string, { author?: string; handle?: string }>();
  if (!parents.size) return branches;
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const record = (line: string) => {
    const [sha, email, name, subject] = line.split('\0');
    if (!sha || email === undefined || name === undefined || subject === undefined) return;
    branches.set(sha, {
      author: isBot(email, name) || isMergeBot(email, name) ? undefined : identity(email, name),
      handle: prAuthor(subject),
    });
  };
  await gitStream(
    directory,
    ['log', '--no-walk=unsorted', '--stdin', '--format=%H%x00%ae%x00%an%x00%s'],
    (chunk) => {
      const lines = (pending + decoder.write(chunk)).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) record(line);
    },
    `${[...new Set(parents.values())].join('\n')}\n`,
  );
  record(pending);
  return branches;
}

export function mergeTitleFromBody(subject: string, body: string): string | undefined {
  if (!/^Merge pull request #\d+ from \S+/.test(subject)) return undefined;
  const lines = body.split('\n');
  const first = lines.findIndex((line) => line.trim());
  if (first < 0) return undefined;
  return boundText(lines[first].trim(), 300);
}

async function mergeTitles(directory: string, head: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const record = (text: string) => {
    const split = text.indexOf('\x01');
    if (split !== 40 && split !== 64) return;
    const rest = text.slice(split + 1);
    const subjectEnd = rest.indexOf('\x01');
    if (subjectEnd < 0) return;
    const title = mergeTitleFromBody(rest.slice(0, subjectEnd), rest.slice(subjectEnd + 1));
    if (title) titles.set(text.slice(0, split), title);
  };
  await gitStream(
    directory,
    ['log', '--first-parent', '--merges', '--no-abbrev', '--format=%x00%H%x01%s%x01%b', head, '--'],
    (chunk) => {
      const parts = (pending + decoder.write(chunk)).split('\0');
      pending = parts.pop() ?? '';
      if (pending.length > 1024 * 1024) pending = pending.slice(0, 1024 * 1024);
      for (const part of parts) record(part);
    },
  );
  record(pending);
  return titles;
}
