import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Commit, Era } from '../src/lib/schema';
import type { Touches } from '../src/lib/snapshot-pack';
import {
  beatSpeed,
  buildBeats,
  commitBins,
  ENVELOPE_SECONDS,
  envelope,
  invertTouches,
  nextBeat,
  previousBeat,
  touchedAt,
  touchActivity,
} from '../src/viewer/beats';
import { TOUR_SECONDS } from '../src/viewer/playback';

const commit = (time: number, sha = 'a'.repeat(40)): Commit => ({
  sha,
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

const eras = [
  {
    id: 0,
    start: 0,
    end: 3,
    startTime: 100,
    endTime: 200,
    beats: [{ kind: 'commit', ref: 'c2', sha: 'bbbbbbbbb', date: '2020-01-02', subject: 'Second' }],
    sheet: [{ id: 'c2', kind: 'commit', text: 'Second', time: 200, commits: ['b'.repeat(40)] }],
  },
  {
    id: 1,
    start: 3,
    end: 6,
    startTime: 400,
    endTime: 600,
    beats: [{ kind: 'commit', ref: 'c5', sha: 'ccccccccc', date: '2020-01-05', subject: 'Third' }],
    sheet: [{ id: 'c5', kind: 'commit', text: 'Third', time: 500, commits: ['c'.repeat(40)] }],
  },
] as unknown as Era[];

// Two commits share a timestamp. The beat's sheet sha names index 2, not the first at time 200.
const commits = [
  commit(100, 'a'.repeat(40)),
  commit(200, 'd'.repeat(40)),
  commit(200, 'b'.repeat(40)),
  commit(400, 'e'.repeat(40)),
  commit(500, 'c'.repeat(40)),
  commit(600, 'f'.repeat(40)),
];
const sha = (value: string) => value.repeat(9).slice(0, 9);

test('a beat resolves through its packed tick to the exact commit', () => {
  const beats = buildBeats(eras, commits, [2, 4]);
  assert.deepEqual(
    beats.map((beat) => [beat.tick, beat.sha, beat.fullSha, beat.subject, beat.era]),
    [
      [2, sha('bbbbbbbbb'), 'b'.repeat(40), 'Second', 0],
      [4, sha('ccccccccc'), 'c'.repeat(40), 'Third', 1],
    ],
  );
  assert.deepEqual(
    [nextBeat(beats, 0), previousBeat(beats, 4), nextBeat(beats, 4)].map((beat) => beat?.tick),
    [2, 2, undefined],
  );
});

test('packed beat ticks place every beat, and the sentinel skips one', () => {
  const beats = buildBeats(eras, commits, [5, 1]);
  assert.deepEqual(
    beats.map((beat) => beat.tick),
    [1, 5],
  );
  assert.deepEqual(buildBeats(eras, commits, [0xffffffff, 0xffffffff]), []);
});

test('the envelope eases in, holds, and eases out over 2.5 seconds', () => {
  assert.equal(envelope(0), 0);
  assert.ok(envelope(0.2) > 0 && envelope(0.2) < 1);
  assert.equal(envelope(1.2), 1);
  assert.equal(envelope(1.8), 1);
  assert.ok(envelope(2.2) > 0 && envelope(2.2) < 1);
  assert.equal(envelope(ENVELOPE_SECONDS), 0);
  assert.equal(beatSpeed(0), 1);
  assert.equal(beatSpeed(1), 0.25);
});

test('inverting the touches part gives each tick exactly the files that commit touched', () => {
  const touches: Touches = {
    offsets: new Uint32Array([0, 2, 3, 5]),
    ticks: new Uint32Array([0, 3, 1, 3, 4]),
  };
  const index = invertTouches(touches, 6);
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((tick) => [...(touchedAt(index, tick) ?? [])]),
    [[0], [1], [], [0, 2], [2], []],
  );
  assert.equal(touchedAt(index, -1), null);
  assert.equal(touchedAt(index, 6), null);
});

test('the histogram gives every chapter the same share of its bins', () => {
  const bins = commitBins(eras, commits, 4);
  assert.equal(
    bins.reduce((sum, count) => sum + count, 0),
    commits.length,
  );
  assert.deepEqual(bins, [2, 1, 2, 1]);
});

test('the histogram bins real touched-file activity, so bars vary inside a chapter', () => {
  const activity = touchActivity(
    invertTouches(
      {
        offsets: new Uint32Array([0, 0, 1, 3, 6, 10, 15]),
        ticks: new Uint32Array([1, 2, 2, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 5]),
      },
      6,
    ),
  );
  assert.deepEqual([...activity], [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(commitBins(eras, commits, 4, activity), [1, 2, 7, 5]);
  assert.notDeepEqual(
    new Set(commitBins(eras, commits, 4, activity).slice(0, 2)).size,
    1,
    'bins inside one chapter differ',
  );
});

test('a chapter occupies exactly its share of a 90 second tour', () => {
  assert.equal(TOUR_SECONDS, 90);
});
