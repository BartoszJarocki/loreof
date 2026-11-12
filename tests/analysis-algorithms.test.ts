import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultLimits } from '../src/analysis';
import { monthlyActivity, segmentEras } from '../src/analysis/eras';
import type { History, Track } from '../src/analysis/git';
import { factSheets, subjectTerms } from '../src/analysis/sheet';
import { buildGraph } from '../src/analysis/graph';
import { layoutTracks } from '../src/analysis/layout';
import type { FileTrack } from '../src/lib/schema';
import { boundText } from '../src/lib/text';

function track(id: number, path: string, touches: number[]): Track {
  return {
    id,
    path,
    born: touches[0] ?? 0,
    died: null,
    paths: [[touches[0] ?? 0, path]],
    kind: 'file',
    touches,
    authors: [{ id: 0, touches: touches.length }],
  };
}
function history(months: number[], tracks: Track[]): History {
  return {
    totalCommits: months.length,
    tracks,
    tags: [],
    authors: [{ id: 0, kind: 'anonymous', label: 'Contributor 1' }],
    credits: months.map(() => ['#0']),
    commits: months.map((month, tick) => ({
      sha: (tick + 1).toString(16).padStart(40, '0'),
      time: Date.UTC(2020, month, 1) / 1000,
      authoredAt: Date.UTC(2020, month, 1) / 1000,
      author: 0,
      subject: `Change ${tick}`,
      files: tracks.filter((track) => track.touches.includes(tick)).length,
      created: tracks.filter((track) => track.born === tick).length,
      deleted: 0,
      merge: false,
      bulk: false,
    })),
  };
}
function files(tracks: Track[]): FileTrack[] {
  return tracks.map((track) => ({
    ...track,
    directory: track.path.split('/')[0],
    position: [track.id * 10, 0, 0],
  }));
}

test('co-change weights retain original commit size when points are omitted', () => {
  const tracks = [track(0, 'a', [0, 1]), track(1, 'b', [0, 1]), track(2, 'c', [1])];
  const source = history([0, 1], tracks);
  assert.deepEqual(buildGraph(source, tracks, defaultLimits).edges, [
    { source: 0, target: 1, weight: 1.5 },
    { source: 0, target: 2, weight: 0.5 },
    { source: 1, target: 2, weight: 0.5 },
  ]);
  assert.deepEqual(buildGraph(source, tracks.slice(0, 2), defaultLimits).edges, [
    { source: 0, target: 1, weight: 1.5 },
  ]);
  const sampled = buildGraph(
    history(
      [0],
      tracks.map((item) => ({ ...item, touches: [0] })),
    ),
    tracks.map((item) => ({ ...item, touches: [0] })),
    { ...defaultLimits, maxPairsPerCommit: 1 },
  );
  assert.equal(sampled.edges.length, 1);
  assert.equal(sampled.edges[0].weight, 1.5);
  assert.equal(sampled.coverage.pairUpdates, 1);
  assert.equal(sampled.coverage.graphSampled, true);
});

test('new directories that last start eras despite a constant commit rate', () => {
  const months = Array.from({ length: 48 }, (_, i) => Math.floor(i / 2));
  const tracks = months.map((month, id) =>
    track(id, `area${Math.floor(month / 6)}/file${id}`, [id]),
  );
  const source = history(months, tracks);
  const eras = segmentEras(source, files(tracks));
  assert.deepEqual(
    eras.map(({ start, end }) => [start, end]),
    [
      [0, 12],
      [12, 24],
      [24, 36],
      [36, 48],
    ],
  );
  assert.deepEqual(
    eras.map((era) => era.directories),
    [0, 1, 2, 3].map((id) => [{ path: `area${id}`, touches: 12 }]),
  );
  assert.deepEqual(
    eras.map((era) => era.centroid),
    [
      [55, 0, 0],
      [175, 0, 0],
      [295, 0, 0],
      [415, 0, 0],
    ],
  );
  for (const era of eras)
    for (const fact of era.facts)
      for (const sha of fact.commits)
        assert.ok(source.commits.slice(era.start, era.end).some((commit) => commit.sha === sha));
});

test('monthly history keeps only months with commits', () => {
  const source = history([0, 2, 12], [track(0, 'src/file', [0, 1, 2])]);
  const months = monthlyActivity(source);
  assert.deepEqual(
    months.map((month) => [month.month - months[0].month, month.commits]),
    [
      [0, 1],
      [2, 1],
      [12, 1],
    ],
  );
  assert.deepEqual(
    segmentEras(source, []).map(({ start, end }) => [start, end]),
    [[0, 3]],
  );
  assert.deepEqual(segmentEras(history([], []), []), []);
  assert.deepEqual(
    segmentEras(history([0], []), []).map(({ start, end }) => [start, end]),
    [[0, 1]],
  );
});

test('bot-only months at either end stay inside the first and last eras', () => {
  const months = [0, ...Array.from({ length: 120 }, (_, i) => 1 + Math.floor(i / 2)), 62];
  const tracks = months.map((month, tick) =>
    track(tick, month < 21 ? `src/core/file${tick}` : `packages/reconciler/file${tick}`, [tick]),
  );
  const source = history(months, tracks);
  source.authors.push({ id: 1, kind: 'bot', label: 'Bot 2' });
  source.commits[0].author = 1;
  source.commits[121].author = 1;
  assert.deepEqual(
    segmentEras(source, files(tracks)).map(({ start, end }) => [start, end]),
    [
      [0, 41],
      [41, 122],
    ],
  );
});

test('an all-bot history is one era', () => {
  const source = history([0, 1, 2, 3, 4, 5, 6, 7], [track(0, 'src/a', [0, 1, 2, 3, 4, 5, 6, 7])]);
  source.authors[0] = { id: 0, kind: 'bot', label: 'Bot 1' };
  assert.deepEqual(
    segmentEras(source, []).map(({ start, end, created }) => [start, end, created]),
    [[0, 8, 0]],
  );
});

test('subject terms skip merge refs, URLs, and conventional-commit types', () => {
  const terms = (text: string) => [...subjectTerms(text).keys()];
  assert.deepEqual(
    terms("Merge tag 'drm-fixes' of git://people.freedesktop.org/~airlied/linux"),
    [],
  );
  assert.deepEqual(terms("Merge branches 'core' and 'irq' into tip"), []);
  assert.deepEqual(terms('Merge master.kernel.org:/pub/scm/linux/kernel/git/davem/net-2.6'), []);
  assert.deepEqual(terms('feat(markdown): serve notes, see https://example.com/notes'), [
    'markdown',
    'serve',
    'note',
    'see',
  ]);
  assert.deepEqual(terms('Merge pull request #12 from user/perf/hooks-build'), ['hook']);
});

test('a GitHub merge title with a component prefix keeps its PR title', () => {
  const source = history([0], [track(0, 'src/codemod', [0])]);
  source.commits[0].subject = 'Merge pull request #3515 from cpojer/fix-class-transform';
  source.commits[0].merge = true;
  source.titles = new Map([
    [source.commits[0].sha, 'npm-react-codemod: Class transform doesn’t need aliases (#3515)'],
  ]);
  const [sheet] = factSheets(source, [0, 1], []);
  assert.deepEqual(
    sheet.filter((item) => item.kind === 'commit').map((item) => item.text),
    ['npm-react-codemod: Class transform doesn’t need aliases (#3515)'],
  );
});

test('a new directory at month 20 and a term burst at month 40 each start an era', () => {
  const months = Array.from({ length: 120 }, (_, i) => Math.floor(i / 2));
  const tracks = months.map((month, tick) =>
    track(tick, month < 20 ? `src/core/file${tick}` : `packages/reconciler/file${tick}`, [tick]),
  );
  const source = history(months, tracks);
  source.commits.forEach((commit, tick) => {
    if (months[tick] >= 40) commit.subject = `Hooks change ${tick}`;
  });
  assert.deepEqual(
    segmentEras(source, files(tracks)).map(({ start, end }) => [months[start], months[end - 1]]),
    [
      [0, 19],
      [20, 39],
      [40, 59],
    ],
  );
});

test('a two-year gap yields no single-month era', () => {
  const months = [
    ...Array.from({ length: 24 }, (_, i) => Math.floor(i / 2)),
    36,
    ...Array.from({ length: 24 }, (_, i) => 61 + Math.floor(i / 2)),
  ];
  const tracks = months.map((month, tick) =>
    track(tick, month <= 36 ? `old/file${tick}` : `new/file${tick}`, [tick]),
  );
  const source = history(months, tracks);
  assert.deepEqual(
    segmentEras(source, files(tracks)).map(({ start, end }) => [months[start], months[end - 1]]),
    [
      [0, 36],
      [61, 72],
    ],
  );
});

test('a burst that fades within a year starts no era', () => {
  const months = Array.from({ length: 120 }, (_, i) => Math.floor(i / 2));
  const tracks = months.map((_, tick) => track(tick, `src/core/file${tick}`, [tick]));
  const source = history(months, tracks);
  source.commits.forEach((commit, tick) => {
    if (months[tick] >= 20 && months[tick] < 26) commit.subject = `Flare change ${tick}`;
  });
  assert.deepEqual(
    segmentEras(source, files(tracks)).map(({ start, end }) => [months[start], months[end - 1]]),
    [[0, 59]],
  );
});

test('nearby tags snap boundaries without empty or inverted eras', () => {
  const tracks = Array.from({ length: 40 }, (_, id) =>
    track(
      id,
      `area${Math.floor(id / 10)}/file${id}`,
      Array.from({ length: 6 }, (_, i) => Math.floor(id / 10) * 6 + i),
    ),
  );
  const source = history(
    Array.from({ length: 24 }, (_, i) => i),
    tracks,
  );
  source.tags = [7, 13, 19, 23].map((tick) => ({
    name: `v${tick}`,
    sha: source.commits[tick].sha,
  }));
  assert.deepEqual(
    segmentEras(source, files(tracks)).map(({ start, end }) => [start, end]),
    [
      [0, 7],
      [7, 13],
      [13, 19],
      [19, 24],
    ],
  );
});

test('era facts exclude bot activity and camera centroid weights actual touches', () => {
  const tracks = [track(0, 'src/a', [0, 1]), track(1, 'src/b', [1]), track(2, 'vendor/bot', [2])];
  const source = history([0, 1, 2], tracks);
  source.authors.push({ id: 1, kind: 'bot', label: 'Bot 2' });
  source.commits[2].author = 1;
  const era = segmentEras(source, files(tracks))[0];
  assert.equal(era.created, 2);
  assert.equal(era.contributors, 1);
  assert.deepEqual(era.directories, [{ path: 'src', touches: 3 }]);
  assert.deepEqual(era.centroid, [10 / 3, 0, 0]);
  assert.equal(era.facts[0].text, '2 first-parent integration commits by non-bot authors.');
  assert.equal(source.tracks.length, 3);
  assert.equal(source.tracks[2].born, 2);
});

test('tree and force layouts preserve nested directories and deterministic finite positions', async () => {
  const tracks = [
    track(0, 'src/left/a', [0]),
    track(1, 'src/left/b', [0]),
    track(2, 'src/right/a', [0]),
    track(3, 'src/right/b', [0]),
    track(4, 'docs/a', [0]),
  ];
  const tree = await layoutTracks(tracks, [], 'tree', 0);
  const distance = (a: number, b: number) =>
    Math.hypot(
      ...tree.files[a].position.map((value, axis) => value - tree.files[b].position[axis]),
    );
  assert.ok(distance(0, 1) < distance(0, 2) / 3);
  for (const method of ['tree', 'force'] as const) {
    const result = await layoutTracks(tracks, [{ source: 0, target: 1, weight: 1 }], method, 40);
    assert.deepEqual(
      await layoutTracks(tracks, [{ source: 0, target: 1, weight: 1 }], method, 40),
      result,
    );
    assert.ok(result.files.every((file) => file.position.every(Number.isFinite)));
    assert.equal(result.files.length, 5);
  }
});

test('spectral landmark approximation retains more than 10000 tracks deterministically', async () => {
  const tracks = Array.from({ length: 10001 }, (_, id) =>
    track(id, `packages/p${id % 20}/f${id}`, [0]),
  );
  const edges = tracks
    .slice(1)
    .map((item) => ({ source: item.id - 1, target: item.id, weight: 1 }));
  const first = await layoutTracks(tracks, edges, 'spectral', 0);
  assert.equal(first.files.length, 10001);
  assert.ok(first.files.every((file) => file.position.every(Number.isFinite)));
  assert.deepEqual(await layoutTracks(tracks, edges, 'spectral', 0), first);
});

test('bounded subjects keep subject terms under five milliseconds', () => {
  const subjects = [
    boundText(`a${'.org:/'.repeat(10_000)}`, 300),
    boundText(`b${', r='.repeat(10_000)}`, 300),
    boundText(`Merge pull request #1 from ${'z'.repeat(50_000)}`, 300),
    boundText('c'.repeat(50_000), 300),
    boundText(' '.repeat(50_000), 300),
  ];
  const before = performance.now();
  for (let round = 0; round < 100; round++)
    for (const subject of subjects) subjectTerms(`${subject} ${subject}`);
  const perSubject = (performance.now() - before) / (100 * subjects.length);
  assert.ok(perSubject < 5, `subjectTerms took ${perSubject.toFixed(2)} ms per subject`);
});

test('subject terms over the narration fixtures are unchanged', () => {
  const directory = join(import.meta.dirname, 'fixtures/narration');
  const subjects: string[] = [];
  for (const name of readdirSync(directory).filter((value) => value.endsWith('.json'))) {
    const snapshot = JSON.parse(readFileSync(join(directory, name), 'utf8'));
    for (const era of snapshot.eras ?? [])
      for (const item of era.sheet ?? []) subjects.push(item.text);
  }
  // Digest of the terms every recorded subject produced before the input cap.
  const terms = subjects.map((subject) => [...subjectTerms(subject)]);
  assert.equal(subjects.length, 1892);
  assert.equal(
    createHash('sha256').update(JSON.stringify(terms)).digest('hex'),
    '12432b81cb5f197b4e295016bd769b1d19d1de7d9d3ecc723b542dfe55cdacf1',
  );
});
