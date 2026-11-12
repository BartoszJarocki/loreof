/** `positions` holds x, y, z per file. */
export function frameFiles(positions: ArrayLike<number>): {
  center: [number, number, number];
  radius: number;
  fullRadius: number;
} {
  const count = Math.floor(positions.length / 3);
  if (count === 0) return { center: [0, 0, 0], radius: 1, fullRadius: 1 };
  const column = new Float64Array(count);
  const median = (axis: number) => {
    for (let file = 0; file < count; file++) column[file] = positions[file * 3 + axis];
    return select(column, Math.floor(count / 2));
  };
  const center: [number, number, number] = [median(0), median(1), median(2)];
  let farthest = 0;
  for (let file = 0; file < count; file++) {
    column[file] = Math.hypot(
      positions[file * 3] - center[0],
      positions[file * 3 + 1] - center[1],
      positions[file * 3 + 2] - center[2],
    );
    farthest = Math.max(farthest, column[file]);
  }
  return {
    center,
    radius: Math.max(1, select(column, Math.floor(count * 0.85))),
    fullRadius: Math.max(1, farthest),
  };
}

/** The value a full sort would put at `rank`, found in linear time. Reorders `values`. */
function select(values: Float32Array | Float64Array, rank: number): number {
  let low = 0;
  let high = values.length - 1;
  while (low < high) {
    const pivot = values[(low + high) >>> 1];
    let i = low;
    let j = high;
    while (i <= j) {
      while (values[i] < pivot) i++;
      while (values[j] > pivot) j--;
      if (i <= j) {
        const swap = values[i];
        values[i++] = values[j];
        values[j--] = swap;
      }
    }
    if (rank <= j) high = j;
    else if (rank >= i) low = i;
    else break;
  }
  return values[rank];
}

/**
 * `cx` and `cy` are the point at the stage center, on the map's own axes. `roll` turns the camera
 * around that point, so a portrait stage can run the map's long side down the screen.
 */
export type View = { cx: number; cy: number; scale: number; roll: number };
export type Turn = { cos: number; sin: number; rollCos: number; rollSin: number };

export const QUARTER = Math.PI / 2;
const TURN_GAIN = 1.1;

export const turnOf = (yaw: number, roll: number): Turn => ({
  cos: Math.cos(yaw),
  sin: Math.sin(yaw),
  rollCos: Math.cos(roll),
  rollSin: Math.sin(roll),
});

/** Writes where a file lands relative to `(cx, cy)`, before scale: `u` runs right and `v` runs up. */
export function stageAxes(
  positions: ArrayLike<number>,
  file: number,
  turn: Turn,
  cx: number,
  cy: number,
  into: { u: number; v: number },
) {
  const across = positions[file * 3] * turn.cos + positions[file * 3 + 2] * turn.sin - cx;
  const up = positions[file * 3 + 1] - cy;
  into.u = across * turn.rollCos + up * turn.rollSin;
  into.v = up * turn.rollCos - across * turn.rollSin;
  return into;
}

type Framing = {
  positions: ArrayLike<number>;
  born: ArrayLike<number>;
  died: ArrayLike<number>;
  cursor: number;
  yaw: number;
  width: number;
  height: number;
  minExtent: number;
  /** The part of the stage the chrome leaves free. Framing centers in it and fills this box. */
  box?: FrameBox | null;
};

export type FrameBox = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** The solid fade bands in screen pixels: below the chrome and above the timeline. */
  fade?: { top: number; bottom: number };
};

/** The share of the free box the 2nd to 98th percentile band takes on its tighter axis. */
const FILL = 0.9;

/**
 * Frames the files alive at the cursor, seen from `yaw` around the vertical axis. Their 2nd to 98th
 * percentile projected box sits centered in the free area and takes 90% of its tighter axis, so a
 * few outliers can't shrink the map. The camera keeps that core inside the free box; outliers may
 * leave it and fade at the edges. `minExtent` stops a handful of files from filling the stage.
 *
 * A landscape stage never rolls. A portrait stage keeps the quarter turn it has, `roll`, unless the
 * other one frames the map 10% larger, so a near-round map doesn't flip back and forth. Without a
 * `roll` it takes whichever frames larger.
 */
export function frameAlive(framing: Framing & { roll: number | null }): View | null {
  if (framing.height <= framing.width) return fit(framing, 0);
  const kept = fit(framing, framing.roll ?? QUARTER);
  const turned = fit(framing, framing.roll === 0 ? QUARTER : 0);
  if (!kept || !turned) return kept;
  return turned.scale > kept.scale * (framing.roll === null ? 1 : TURN_GAIN) ? turned : kept;
}

function fit(
  { positions, born, died, cursor, yaw, width, height, minExtent, box }: Framing,
  roll: number,
): View | null {
  const count = born.length;
  const us = new Float32Array(count);
  const vs = new Float32Array(count);
  const turn = turnOf(yaw, roll);
  const point = { u: 0, v: 0 };
  let alive = 0;
  for (let file = 0; file < count; file++) {
    if (born[file] > cursor || died[file] <= cursor) continue;
    stageAxes(positions, file, turn, 0, 0, point);
    us[alive] = point.u;
    vs[alive] = point.v;
    alive++;
  }
  if (alive === 0) return null;
  const u = us.subarray(0, alive);
  const v = vs.subarray(0, alive);
  const at = (values: Float32Array, share: number) =>
    select(values, Math.min(values.length - 1, Math.floor(share * values.length)));
  const [u0, u1, v0, v1] = [at(u, 0.02), at(u, 0.98), at(v, 0.02), at(v, 0.98)];
  const [cu, cv] = [(u0 + u1) / 2, (v0 + v1) / 2];
  const area = box ?? { left: 0, top: 0, right: width, bottom: height };
  const areaWidth = Math.max(1, area.right - area.left);
  const areaHeight = Math.max(1, area.bottom - area.top);
  const coreFit = Math.min(
    (areaWidth * FILL) / Math.max(minExtent, u1 - u0),
    (areaHeight * FILL) / Math.max(minExtent, v1 - v0),
  );
  // Only the core has to fit, so the percentile fit is the scale; a long tail no longer shrinks it.
  const scale = coreFit;
  // Screen x = width / 2 + (u - uCamera) * scale; the core sits at the free box center, and the
  // camera clamps so it cannot leave the box while the tails run past the edge.
  const clamp = (value: number, min: number, max: number) =>
    min > max ? (min + max) / 2 : Math.max(min, Math.min(max, value));
  const uCamera = clamp(
    cu - ((area.left + area.right) / 2 - width / 2) / scale,
    u1 - (area.right - width / 2) / scale,
    u0 + (width / 2 - area.left) / scale,
  );
  const vCamera = clamp(
    cv - (height / 2 - (area.top + area.bottom) / 2) / scale,
    v1 - (height / 2 - area.top) / scale,
    v0 + (area.bottom - height / 2) / scale,
  );
  return {
    cx: uCamera * turn.rollCos - vCamera * turn.rollSin,
    cy: uCamera * turn.rollSin + vCamera * turn.rollCos,
    scale,
    roll,
  };
}
