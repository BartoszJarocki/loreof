import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withDuration } from '../src/viewer/recording';

const ebml = [0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x86, 0x81, 0x01];
const segment = [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const scale = [0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40];
const app = [0x4d, 0x80, 0x82, 0x51, 0x54];
const info = [0x15, 0x49, 0xa9, 0x66, 0x8c, ...scale, ...app];
const cluster = [0x1f, 0x43, 0xb6, 0x75, 0x82, 0xa0, 0x80];

test('a recorded webm gets a Duration in Segment Info and keeps every other byte', async () => {
  const input = new Blob([new Uint8Array([...ebml, ...segment, ...info, ...cluster])], {
    type: 'video/webm',
  });
  const output = new Uint8Array(await (await withDuration(input, 20_000)).arrayBuffer());
  const duration = [0x44, 0x89, 0x88, 0x40, 0xd3, 0x88, 0x00, 0x00, 0x00, 0x00, 0x00];
  assert.deepEqual(
    [...output],
    [
      ...ebml,
      ...segment,
      ...[0x15, 0x49, 0xa9, 0x66, 0x01, 0, 0, 0, 0, 0, 0, 23],
      ...scale,
      ...app,
      ...duration,
      ...cluster,
    ],
  );
});

test('a webm with a seek head or an unknown layout is returned unchanged', async () => {
  const seekHead = [0x11, 0x4d, 0x9b, 0x74, 0x80];
  const withSeek = new Blob([new Uint8Array([...ebml, ...segment, ...seekHead, ...info])]);
  assert.equal(await withDuration(withSeek, 1000), withSeek);
  const garbage = new Blob([new Uint8Array([1, 2, 3])]);
  assert.equal(await withDuration(garbage, 1000), garbage);
});
