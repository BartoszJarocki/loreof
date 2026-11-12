const MAX_EXACT_INTEGER = 2 ** 24 - 1;
const SEARCH_STEPS = 20;

/** File `f` owns `ticks[offsets[f]..offsets[f + 1])`, ascending. */
export function packTouchTexture({
  offsets,
  ticks,
  maxTextureSize,
}: {
  offsets: ArrayLike<number>;
  ticks: ArrayLike<number>;
  maxTextureSize: number;
}) {
  if (!Number.isInteger(maxTextureSize) || maxTextureSize < 1) {
    throw new Error('This device cannot store the repository touch history.');
  }
  const files = Math.max(0, offsets.length - 1);
  const total = ticks.length;
  for (let file = 0; file < files; file++) {
    if (offsets[file + 1] - offsets[file] >= 2 ** SEARCH_STEPS) {
      throw new Error('A file has more touch history than the GPU lookup supports.');
    }
  }
  if (total > MAX_EXACT_INTEGER) {
    throw new Error('The repository touch history exceeds exact GPU indexing.');
  }
  const width = Math.min(2 ** Math.floor(Math.log2(maxTextureSize)), Math.max(1, total));
  const height = Math.max(1, Math.ceil(total / width));
  if (height > maxTextureSize) {
    throw new Error('This device cannot store the complete repository touch history.');
  }
  const data = new Float32Array(width * height);
  const offsetOf = new Float32Array(files);
  const counts = new Float32Array(files);
  for (let file = 0; file < files; file++) {
    let previous = -1;
    for (let index = offsets[file]; index < offsets[file + 1]; index++) {
      const touch = ticks[index];
      if (!Number.isInteger(touch) || touch < 0 || touch < previous || touch > MAX_EXACT_INTEGER) {
        throw new Error('The repository touch history cannot be indexed exactly on the GPU.');
      }
      previous = touch;
    }
    offsetOf[file] = offsets[file];
    counts[file] = offsets[file + 1] - offsets[file];
  }
  data.set(ticks);
  return { data, width, height, offsets: offsetOf, counts };
}

export const touchLookupShader = `
  attribute float touchOffset;
  attribute float touchCount;
  uniform sampler2D touchHistory;
  uniform vec2 touchTextureSize;

  float touchAt(float index) {
    vec2 texel = vec2(mod(index, touchTextureSize.x), floor(index / touchTextureSize.x));
    return texture2D(touchHistory, (texel + 0.5) / touchTextureSize).r;
  }

  float lastTouchAt(float time) {
    float low = 0.0;
    float high = touchCount;
    float result = -1.0;
    for (int iteration = 0; iteration < ${SEARCH_STEPS}; iteration++) {
      if (low >= high) break;
      float middle = floor((low + high) * 0.5);
      float touch = touchAt(touchOffset + middle);
      if (touch <= time) {
        result = touch;
        low = middle + 1.0;
      } else {
        high = middle;
      }
    }
    return result;
  }
`;
