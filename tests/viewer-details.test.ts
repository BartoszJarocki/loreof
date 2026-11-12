import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectedEraForPin } from '../src/viewer/era-pin';
import { resolveTimePin } from '../src/viewer/playback';
import type { Commit } from '../src/lib/schema';

const seconds = (date: string) => Date.parse(date) / 1000;
const eras = [
  { start: 0, end: 3, startTime: seconds('2020-01-01'), endTime: seconds('2020-01-05') },
  { start: 3, end: 6, startTime: seconds('2020-03-01'), endTime: seconds('2020-06-01') },
  { start: 6, end: 8, startTime: seconds('2020-07-01'), endTime: seconds('2020-07-10') },
];
const commit = (date: string, sha = 'a'.repeat(40)): Commit => ({
  sha,
  time: seconds(date),
  authoredAt: seconds('1999-01-01'),
  subject: 'Recorded change',
  author: 0,
  files: 1,
  created: 0,
  deleted: 0,
  merge: false,
  bulk: false,
});

test('chapter pins use exclusive era ends and clamp large commit indices', () => {
  assert.deepEqual(
    ['0', '2', '3', '5', '6', '7', '999'].map((pin) => selectedEraForPin(eras, pin)),
    [0, 0, 1, 1, 2, 2, 2],
  );
});

test('month pins select containing chapters or the nearest boundary across date gaps', () => {
  assert.deepEqual(
    ['2019-01', '2020-01', '2020-02', '2020-03', '2020-04', '2020-06', '2020-07', '2021-01'].map(
      (pin) => selectedEraForPin(eras, pin),
    ),
    [0, 0, 0, 1, 1, 1, 2, 2],
  );
  const commits = [commit('2020-01-22'), commit('2020-02-11')];
  const tiedEras = [
    { start: 0, end: 1, startTime: seconds('2020-01-22'), endTime: seconds('2020-01-22') },
    { start: 1, end: 2, startTime: seconds('2020-02-11'), endTime: seconds('2020-02-11') },
  ];
  assert.equal(selectedEraForPin(tiedEras, '2020-02'), 0);
  assert.equal(resolveTimePin('2020-02', commits), 0);
});

test('absent and malformed chapter pins do not select a chapter', () => {
  for (const pin of [null, '', '-1', '1.5', '2020-13', '2020-00', '2020-01-01']) {
    assert.equal(selectedEraForPin(eras, pin), null);
  }
  assert.equal(selectedEraForPin([], '0'), null);
});
