import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packTouchTexture } from '../src/viewer/touch-texture';

/** One offset array and one tick array, the way the touches part holds touch histories. */
const tracks = (files: number[][]) => ({
  offsets: files.reduce((all, touches) => [...all, all[all.length - 1] + touches.length], [0]),
  ticks: files.flat(),
});

test('touch texture preserves file ranges across rows, including empty and commit-zero tracks', () => {
  const packed = packTouchTexture({
    ...tracks([[], [0, 2, 7], [1, 4, 9, 12]]),
    maxTextureSize: 4,
  });
  assert.deepEqual({ width: packed.width, height: packed.height }, { width: 4, height: 2 });
  assert.deepEqual(Array.from(packed.offsets), [0, 0, 3]);
  assert.deepEqual(Array.from(packed.counts), [0, 3, 4]);
  assert.deepEqual(Array.from(packed.data), [0, 2, 7, 1, 4, 9, 12, 0]);
  const decoded = Array.from(packed.offsets, (offset, index) =>
    Array.from(packed.data.slice(offset, offset + packed.counts[index])),
  );
  assert.deepEqual(decoded, [[], [0, 2, 7], [1, 4, 9, 12]]);
});

test('empty histories use a one-texel texture with zero lookup counts', () => {
  const packed = packTouchTexture({ ...tracks([[]]), maxTextureSize: 4 });
  assert.deepEqual(
    {
      width: packed.width,
      height: packed.height,
      data: Array.from(packed.data),
      offsets: Array.from(packed.offsets),
      counts: Array.from(packed.counts),
    },
    { width: 1, height: 1, data: [0], offsets: [0], counts: [0] },
  );
});

test('all 200,000 commits fit in one file without truncation or float rounding', () => {
  const packed = packTouchTexture({
    ...tracks([Array.from({ length: 200_000 }, (_, index) => index)]),
    maxTextureSize: 1024,
  });
  assert.deepEqual(
    {
      width: packed.width,
      height: packed.height,
      count: packed.counts[0],
      first: packed.data[0],
      rowEnd: packed.data[1023],
      nextRow: packed.data[1024],
      last: packed.data[199_999],
    },
    {
      width: 1024,
      height: 196,
      count: 200_000,
      first: 0,
      rowEnd: 1023,
      nextRow: 1024,
      last: 199_999,
    },
  );
});

test('unsupported texture capacity fails instead of dropping touch history', () => {
  assert.throws(
    () =>
      packTouchTexture({
        ...tracks([Array.from({ length: 17 }, (_, index) => index)]),
        maxTextureSize: 4,
      }),
    /complete repository touch history/,
  );
  const packed = packTouchTexture({ ...tracks([[3]]), maxTextureSize: 1 });
  assert.deepEqual(Array.from(packed.data), [3]);
  assert.throws(() => packTouchTexture({ ...tracks([]), maxTextureSize: 0 }), /cannot store/);
});

test('GPU float and bounded-search limits reject histories they cannot represent exactly', () => {
  const packed = packTouchTexture({
    ...tracks([[0, 16_777_215]]),
    maxTextureSize: 4,
  });
  assert.deepEqual(Array.from(packed.data), [0, 16_777_215]);
  for (const touches of [[16_777_216], [-1], [0.5], [4, 2]]) {
    assert.throws(
      () => packTouchTexture({ ...tracks([touches]), maxTextureSize: 4 }),
      /cannot be indexed exactly/,
    );
  }
  const longHistory = Array.from({ length: 2 ** 20 }, (_, index) => index);
  assert.throws(
    () => packTouchTexture({ ...tracks([longHistory]), maxTextureSize: 16_384 }),
    /more touch history/,
  );
  longHistory.pop();
  assert.throws(
    () =>
      packTouchTexture({
        ...tracks(Array.from({ length: 17 }, () => longHistory)),
        maxTextureSize: 16_384,
      }),
    /exceeds exact GPU indexing/,
  );
});
