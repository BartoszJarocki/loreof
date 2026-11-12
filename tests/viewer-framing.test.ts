import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameAlive, QUARTER } from '../src/viewer/framing';

const files = 100;
const positions = new Float32Array(files * 3 + 6);
const born = new Float32Array(files + 2);
const died = new Float32Array(files + 2).fill(Infinity);
for (let file = 0; file < files; file++) positions.set([file, file / 2, -file * 2], file * 3);
positions.set([5000, 5000, 5000, -5000, -5000, -5000], files * 3);
born[files] = 11;
died[files + 1] = 10;

const view = {
  positions,
  born,
  died,
  cursor: 10,
  width: 1000,
  height: 600,
  minExtent: 4,
  roll: null,
};

test('framing fits the 2nd to 98th percentile of the files alive at the cursor', () => {
  assert.deepEqual(frameAlive({ ...view, yaw: 0 }), { cx: 50, cy: 25, scale: 9.375, roll: 0 });
});

test('framing follows the yaw, so a quarter turn frames depth across the width', () => {
  const quarter = frameAlive({ ...view, yaw: Math.PI / 2 });
  assert.ok(quarter);
  assert.deepEqual(
    { cx: Math.round(quarter.cx), cy: quarter.cy, scale: quarter.scale },
    { cx: -98, cy: 25, scale: 4.6875 },
  );
});

const rounded = (frame: ReturnType<typeof frameAlive>) =>
  frame && {
    cx: Math.round(frame.cx * 1000) / 1000,
    cy: Math.round(frame.cy * 1000) / 1000,
    scale: Math.round(frame.scale * 1000) / 1000,
    roll: frame.roll,
  };

test('a portrait stage rolls a quarter turn when that runs the long side down the screen', () => {
  assert.deepEqual(rounded(frameAlive({ ...view, yaw: 0, width: 600, height: 960 })), {
    cx: 49,
    cy: 25,
    scale: 9,
    roll: QUARTER,
  });
});

test('a portrait stage keeps its turn unless the other frames the map 10% larger', () => {
  const stage = { ...view, yaw: 0, width: 600, height: 660 };
  assert.equal(frameAlive({ ...stage, roll: 0 })?.roll, 0);
  assert.equal(frameAlive({ ...stage, roll: null })?.roll, QUARTER);
  assert.equal(frameAlive({ ...stage, height: 700, roll: 0 })?.roll, QUARTER);
  assert.equal(frameAlive({ ...view, yaw: 0, roll: QUARTER })?.roll, 0);
});

test('a few files frame at the minimum extent, and nothing alive frames nothing', () => {
  const three = frameAlive({
    ...view,
    cursor: 10,
    born: born.map((tick, file) => (file < 3 ? 0 : 50 + tick)),
    yaw: 0,
  });
  assert.deepEqual(three, { cx: 1, cy: 0.5, scale: 135, roll: 0 });
  assert.equal(frameAlive({ ...view, cursor: -1, yaw: 0 }), null);
});
