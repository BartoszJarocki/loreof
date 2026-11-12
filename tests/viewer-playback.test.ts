import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chapterAtSeconds,
  commitAtSeconds,
  commitsPerSecond,
  eraIndexAt,
  fileVisible,
  lastTouch,
  pathAt,
  pinnedUrl,
  resolveTimePin,
  secondsAtCommit,
} from '../src/viewer/playback';
import type { Commit } from '../src/lib/schema';

const commit = (time: number): Commit => ({
  sha: 'a'.repeat(40),
  time,
  authoredAt: time,
  subject: 'Change',
  author: 0,
  files: 1,
  created: 0,
  deleted: 0,
  merge: false,
  bulk: false,
});
test('lifetimes are inclusive at birth and exclusive at death, including backward scrubs', () => {
  const track = { born: 3, died: 8 };
  assert.deepEqual(
    [2, 3, 7, 8, 4].map((cursor) => fileVisible(track, cursor)),
    [false, true, true, false, true],
  );
});
test('renames resolve the path at the exact commit, including backward scrubs', () => {
  const track = {
    path: 'lib/new.ts',
    paths: [
      [0, 'old.ts'],
      [4, 'lib/new.ts'],
    ] satisfies [number, string][],
  };
  assert.deepEqual(
    [0, 3, 4, 9, 1].map((cursor) => pathAt(track, cursor)),
    ['old.ts', 'old.ts', 'lib/new.ts', 'lib/new.ts', 'old.ts'],
  );
});
test('touch lookup does not reveal future activity', () => {
  assert.deepEqual(
    [0, 1, 3, 6, 8].map((cursor) => lastTouch([1, 4, 7], cursor)),
    [-1, 1, 1, 4, 7],
  );
});
test('pins resolve dates and clamp indices without accepting malformed dates', () => {
  const commits = [
    commit(Date.parse('2020-01-01') / 1000),
    commit(Date.parse('2020-04-01') / 1000),
  ];
  assert.equal(resolveTimePin('2020-03', commits), 1);
  assert.equal(resolveTimePin('999', commits), 1);
  assert.equal(resolveTimePin('2020-13', commits), null);
  assert.equal(resolveTimePin('', commits), null);
});
test('share links pin the snapshot and integer commit index', () => {
  assert.equal(
    pinnedUrl({
      origin: 'https://lore.example',
      slug: 'a/b',
      snapshotId: 'c'.repeat(24),
      cursor: 4.4,
    }),
    `https://lore.example/a/b?s=${'c'.repeat(24)}&t=4`,
  );
});

const eras = [
  { start: 0, end: 30 },
  { start: 30, end: 40 },
  { start: 40, end: 100 },
];

test('the tour gives each chapter 30 of its 90 seconds, whatever its commit count', () => {
  assert.deepEqual(
    [0, 15, 29.99, 30, 45, 60, 75, 89.99].map((seconds) => commitAtSeconds(eras, 100, seconds)),
    [0, 15, 29, 30, 35, 40, 70, 99],
  );
  assert.deepEqual(
    [3, 30, 35, 40, 70].map((commit) => commitsPerSecond(eras, commit)),
    [1, 1, 1, 2, 2],
  );
});

test('seeking to a chapter or a commit lands on that commit and keeps the tour paced', () => {
  for (const commit of [0, 7, 29, 30, 39, 40, 41, 99])
    assert.equal(commitAtSeconds(eras, 100, secondsAtCommit(eras, commit)), commit);
  assert.deepEqual(
    eras.map((era) => secondsAtCommit(eras, era.start)),
    [0, 30, 60],
  );
});

function chapterSpans(sizes: number[]) {
  const spans: { start: number; end: number }[] = [];
  let start = 0;
  for (const size of sizes) {
    spans.push({ start, end: start + size });
    start += size;
  }
  return spans;
}

function randomSizes(count: number) {
  let seed = 0x9e3779b9;
  return Array.from({ length: count }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return 1 + Math.floor((seed / 2 ** 32) * 50);
  });
}

test('every chapter start round-trips to its own chapter and commit, at any chapter count', () => {
  for (let chapters = 1; chapters <= 10; chapters++) {
    for (const sizes of [Array<number>(chapters).fill(7), randomSizes(chapters)]) {
      const spans = chapterSpans(sizes);
      const total = spans[spans.length - 1].end;
      for (let index = 0; index < chapters; index++) {
        const start = spans[index].start;
        const seconds = secondsAtCommit(spans, start);
        assert.equal(
          commitAtSeconds(spans, total, seconds),
          start,
          `chapter ${index + 1} of ${chapters} (${sizes.join(',')}) at ${seconds}s`,
        );
        assert.equal(
          eraIndexAt(spans, commitAtSeconds(spans, total, secondsAtCommit(spans, start))),
          index,
        );
        assert.equal(chapterAtSeconds(spans, seconds), index);
      }
    }
  }
});

test('the tour ends on the last commit and clamps before its start', () => {
  assert.equal(commitAtSeconds(eras, 100, 90), 99);
  assert.equal(commitAtSeconds(eras, 100, 500), 99);
  assert.equal(commitAtSeconds(eras, 100, -4), 0);
  assert.equal(secondsAtCommit(eras, 99), 89.5);
  assert.equal(commitAtSeconds([], 5, 10), 4);
});

test('?t= reads a commit index or a month and rejects anything else', () => {
  const commits = [0, 1, 2].map((index) => commit(Date.parse(`2021-0${index + 1}-15`) / 1000));
  assert.deepEqual(
    ['0', '2', '17', '2021-02', '2020-12', '2021-02-01', '-1', 'abc', '1e2', null].map((pin) =>
      resolveTimePin(pin, commits),
    ),
    [0, 2, 2, 1, 0, null, null, null, null, null],
  );
});

test('camera framing keeps a dense cluster readable and retains the full zoom extent', async () => {
  const { frameFiles } = await import('../src/viewer/framing');
  const positions: [number, number, number][] = Array.from({ length: 20 }, (_, index) => [
    index - 10,
    0,
    0,
  ]);
  positions.push([1000, 1000, 1000]);
  const frame = frameFiles(positions.flat());
  assert.deepEqual(frame.center, [0, 0, 0]);
  assert.equal(frame.radius, 9);
  assert.equal(frame.fullRadius, Math.hypot(1000, 1000, 1000));
  assert.deepEqual(frameFiles([]), { center: [0, 0, 0], radius: 1, fullRadius: 1 });
});
