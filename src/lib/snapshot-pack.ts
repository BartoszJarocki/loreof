import type { Era, FileTrack, Manifest, Snapshot } from './schema';

/** Bump when a part layout changes. Old parts then miss and re-derive from the JSON. */
export const PARTS_FORMAT = 3;
export const PARTS = ['map', 'touches', 'paths'] as const;
export type Part = (typeof PARTS)[number];

/** What the page renders before the map, carrying `eras` as the snapshot has them. */
export type Story = Pick<
  Manifest,
  'id' | 'repository' | 'generatedAt' | 'startTime' | 'endTime' | 'coverage' | 'eras'
> & { parts: Record<Part, string> };

/**
 * The map file decoded, without its touches. `died[f]` is `commits` for a file alive at the last
 * commit, so `cursor < died[f]` always holds.
 */
export type SnapshotMap = {
  files: number;
  commits: number;
  /** The decoded length of the map part. */
  bytes: number;
  /** The number of touch records the touches part must hold. */
  touches: number;
  /** x, y, z per file, within ±4095. Multiply by `positionScale` for layout units. */
  positions: Int16Array;
  positionScale: number;
  born: Uint32Array;
  died: Uint32Array;
  /** Commit times in seconds. */
  times: Float64Array;
  /**
   * The commit tick each chapter beat names, in era and beat order; `0xffffffff` for a beat that
   * does not name a commit. Resolved from the sheet's full sha when the part is written.
   */
  beatTicks: Uint32Array;
  directory: Uint16Array;
  directories: string[];
};

type MapSections = { numbers: readonly (readonly [number, number, number])[] };

/** File `f` owns `ticks[offsets[f]..offsets[f + 1])`, ascending. */
export type Touches = { offsets: Uint32Array; ticks: Uint32Array };

export type FilePaths = FileTrack['paths'][];

type MapSource = Pick<Snapshot, 'startTime'> & {
  files: Pick<FileTrack, 'position' | 'born' | 'died' | 'touches' | 'directory'>[];
  commits: Pick<Snapshot['commits'][number], 'time' | 'sha'>[];
  eras?: Pick<Era, 'beats' | 'sheet'>[];
};

export const NO_BEAT_TICK = 0xffffffff;

const MAGIC = 0x50414d4c;
const TOUCH_MAGIC = 0x50544d4c;
/**
 * Positions use 13 of the Int16 bits. A step is then about 1/8000 of the map's extent, under a
 * pixel at full zoom, and the low bytes gzip about a quarter smaller than at 16 bits.
 */
const POSITION_STEPS = 4095;
const HEADER = 44;
const TOUCH_HEADER = 16;
/** A part may be slow, but a gap this long means the connection is gone. */
export const PART_IDLE_MS = 20_000;
const align = (bytes: number) => Math.ceil(bytes / 4) * 4;

function layout(files: number, commits: number, table: number, beats: number) {
  const times = HEADER;
  const born = times + 4 * commits;
  const died = born + 4 * files;
  // Each position keeps four unused bytes before it so the section stays 8-byte aligned, as it
  // was in format 2.
  const positions = died + 8 * files;
  const directory = positions + align(6 * files);
  const names = directory + align(2 * files);
  const beatTicks = align(names + table);
  return {
    times,
    born,
    died,
    positions,
    directory,
    names,
    beatTicks,
    table,
    map: align(beatTicks + 4 * beats),
    numbers: [
      [times, 4, commits],
      [born, 4, files],
      [died, 4, files],
      [positions, 2, 3 * files],
      [directory, 2, files],
      [beatTicks, 4, beats],
    ] as const,
  };
}

/**
 * Stores each numeric section as byte planes (every low byte, then every next byte), which gzip
 * compresses about a fifth better than interleaved little-endian values.
 */
function splitPlanes(bytes: Uint8Array, at: MapSections): Uint8Array {
  const out = bytes.slice();
  for (const [offset, width, count] of at.numbers) {
    for (let byte = 0; byte < width; byte++)
      for (let i = 0; i < count; i++)
        out[offset + byte * count + i] = bytes[offset + i * width + byte];
  }
  return out;
}

function joinPlanes(bytes: Uint8Array, offset: number, count: number, width: 2): Uint16Array;
function joinPlanes(bytes: Uint8Array, offset: number, count: number, width: 4): Uint32Array;
function joinPlanes(
  bytes: Uint8Array,
  offset: number,
  count: number,
  width: 2 | 4,
): Uint16Array | Uint32Array {
  const start = bytes.byteOffset + offset;
  const plane = (byte: number) => new Uint8Array(bytes.buffer, start + byte * count, count);
  if (width === 2) {
    const [low, high] = [plane(0), plane(1)];
    const out = new Uint16Array(count);
    for (let i = 0; i < count; i++) out[i] = low[i] | (high[i] << 8);
    return out;
  }
  const [b0, b1, b2, b3] = [plane(0), plane(1), plane(2), plane(3)];
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) out[i] = b0[i] | (b1[i] << 8) | (b2[i] << 16) | (b3[i] << 24);
  return out;
}

/**
 * Each chapter beat names a sheet item whose `commits[0]` is the full sha. Resolve that sha to its
 * exact commit tick once, when the part is written, so equal commit times can never pick a
 * neighbour.
 */
function packBeatTicks(source: MapSource): Uint32Array {
  let count = 0;
  for (const era of source.eras ?? []) count += era.beats.length;
  const ticks = new Uint32Array(count).fill(NO_BEAT_TICK);
  if (count === 0) return ticks;
  const bySha = new Map<string, number>();
  source.commits.forEach((commit, tick) => bySha.set(commit.sha.toLowerCase(), tick));
  let at = 0;
  for (const era of source.eras ?? []) {
    const sheet = new Map(era.sheet.map((item) => [item.id, item]));
    for (const beat of era.beats) {
      if (beat.kind === 'commit') {
        const sha = sheet.get(beat.ref)?.commits[0]?.toLowerCase();
        const tick = sha === undefined ? undefined : bySha.get(sha);
        if (tick !== undefined) ticks[at] = tick;
      }
      at++;
    }
  }
  return ticks;
}

/**
 * Touch counts and per-file tick deltas go on the wire instead of offsets and absolute ticks, and
 * commit times as deltas, because they gzip to about half the size.
 */
export function packMap(snapshot: MapSource): Uint8Array {
  const { files, commits } = snapshot;
  const names: string[] = [];
  const index = new Map<string, number>();
  for (const file of files)
    if (!index.has(file.directory)) {
      index.set(file.directory, names.length);
      names.push(file.directory);
    }
  if (names.length > 0xffff) throw new Error('The map holds too many directories.');
  const table = new TextEncoder().encode(JSON.stringify(names));
  const beatTicks = packBeatTicks(snapshot);
  const touches = files.reduce((total, file) => total + file.touches.length, 0);
  const at = layout(files.length, commits.length, table.length, beatTicks.length);
  const buffer = new ArrayBuffer(at.map);
  const header = new DataView(buffer);
  header.setUint32(0, MAGIC, true);
  header.setUint32(4, PARTS_FORMAT, true);
  header.setUint32(8, files.length, true);
  header.setUint32(12, commits.length, true);
  header.setUint32(16, touches, true);
  header.setUint32(20, table.length, true);
  header.setFloat64(24, snapshot.startTime, true);
  let extent = 0;
  for (const file of files)
    for (const value of file.position) extent = Math.max(extent, Math.abs(value));
  const scale = extent > 0 ? extent / POSITION_STEPS : 1;
  header.setFloat64(32, scale, true);
  header.setUint32(40, beatTicks.length, true);

  const times = new Uint32Array(buffer, at.times, commits.length);
  commits.forEach((commit, i) => {
    times[i] = commit.time - (i ? commits[i - 1].time : snapshot.startTime);
  });
  const born = new Uint32Array(buffer, at.born, files.length);
  const died = new Uint32Array(buffer, at.died, files.length);
  const positions = new Int16Array(buffer, at.positions, 3 * files.length);
  const directory = new Uint16Array(buffer, at.directory, files.length);
  files.forEach((file, i) => {
    born[i] = file.born;
    died[i] = file.died ?? commits.length;
    for (let axis = 0; axis < 3; axis++)
      positions[3 * i + axis] = Math.round(file.position[axis] / scale);
    directory[i] = index.get(file.directory) ?? 0;
  });
  new Uint8Array(buffer, at.names).set(table);
  new Uint32Array(buffer, at.beatTicks, beatTicks.length).set(beatTicks);
  return splitPlanes(new Uint8Array(buffer), at);
}

/** The touch tail is its own part, so a retry after a cut stream re-reads only these bytes. */
export function packTouches(snapshot: Pick<MapSource, 'files'>): Uint8Array {
  const files = snapshot.files;
  const touches = files.reduce((total, file) => total + file.touches.length, 0);
  const buffer = new ArrayBuffer(TOUCH_HEADER + 4 * files.length + 4 * touches);
  const header = new DataView(buffer);
  header.setUint32(0, TOUCH_MAGIC, true);
  header.setUint32(4, PARTS_FORMAT, true);
  header.setUint32(8, files.length, true);
  header.setUint32(12, touches, true);
  const counts = new Uint32Array(buffer, TOUCH_HEADER, files.length);
  const ticks = new Uint32Array(buffer, TOUCH_HEADER + 4 * files.length, touches);
  let tick = 0;
  files.forEach((file, i) => {
    counts[i] = file.touches.length;
    let previous = file.born;
    for (const touch of file.touches) {
      ticks[tick++] = touch - previous;
      previous = touch;
    }
  });
  return splitPlanes(new Uint8Array(buffer), {
    numbers: [
      [TOUCH_HEADER, 4, files.length],
      [TOUCH_HEADER + 4 * files.length, 4, touches],
    ],
  });
}

function readLayout(bytes: Uint8Array) {
  if (bytes.byteLength < HEADER) throw new Error('The map file is truncated.');
  const header = new DataView(bytes.buffer, bytes.byteOffset, HEADER);
  if (header.getUint32(0, true) !== MAGIC || header.getUint32(4, true) !== PARTS_FORMAT)
    throw new Error('The map file has an unknown format.');
  const files = header.getUint32(8, true);
  const commits = header.getUint32(12, true);
  const touches = header.getUint32(16, true);
  const table = header.getUint32(20, true);
  const beats = header.getUint32(40, true);
  const at = layout(files, commits, table, beats);
  return {
    ...at,
    files,
    commits,
    touches,
    beats,
    startTime: header.getFloat64(24, true),
    positionScale: header.getFloat64(32, true),
  };
}

export type MapExtent = {
  /** The decoded length of the map part. */
  bytes: number;
  files: number;
  /** Touch records the touches part must hold. */
  touches: number;
};

/** The decoded length of the touches part a map header expects. */
export function touchesBytes(extent: Pick<MapExtent, 'files' | 'touches'>): number {
  return TOUCH_HEADER + 4 * extent.files + 4 * extent.touches;
}

/** From the first 40 bytes: the map's decoded length and the touches part it expects. */
export function mapExtent(head: Uint8Array): MapExtent {
  const at = readLayout(head);
  return { bytes: at.map, files: at.files, touches: at.touches };
}

export type MapProgress = (received: number, total: number) => void;

/** Each read gets its own timeout, so slow chunks may take as long as they need as long as they arrive. */
function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('The snapshot part stopped arriving.')),
      PART_IDLE_MS,
    );
  });
  return Promise.race([reader.read(), idle]).finally(() => clearTimeout(timer));
}

async function readMapBytes(
  body: ReadableStream<Uint8Array>,
  on: { progress: MapProgress; header?: (extent: MapExtent) => void },
  ready?: (bytes: Uint8Array) => void,
): Promise<Uint8Array> {
  const reader = body.getReader();
  let bytes = new Uint8Array(0);
  let received = 0;
  let extent: MapExtent | null = null;
  try {
    while (true) {
      const { done, value } = await readChunk(reader);
      if (done) break;
      if (!extent) {
        const head = new Uint8Array(received + value.byteLength);
        head.set(bytes.subarray(0, received));
        head.set(value, received);
        bytes = head;
        received = head.byteLength;
        if (received < HEADER) continue;
        extent = mapExtent(head);
        on.header?.(extent);
        bytes = new Uint8Array(Math.max(extent.bytes, received));
        bytes.set(head);
      } else {
        if (received + value.byteLength > extent.bytes)
          throw new Error('The map file is too long.');
        bytes.set(value, received);
        received += value.byteLength;
      }
      on.progress(received, extent.bytes);
      if (ready && received >= extent.bytes) {
        ready(bytes);
        ready = undefined;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  if (!extent || received !== extent.bytes) throw new Error('The map file is truncated.');
  return bytes.subarray(0, received);
}

async function readTouchesBytes(
  body: ReadableStream<Uint8Array>,
  expected: number,
  progress: MapProgress,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const bytes = new Uint8Array(expected);
  let received = 0;
  try {
    while (true) {
      const { done, value } = await readChunk(reader);
      if (done) break;
      if (received + value.byteLength > expected) throw new Error('The touches file is too long.');
      bytes.set(value, received);
      received += value.byteLength;
      progress(received, expected);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  if (received !== expected) throw new Error('The touches file is truncated.');
  return bytes;
}

/** Reads the map part as it arrives and reports the map once its bytes are in. */
export async function readMapPart(
  body: ReadableStream<Uint8Array>,
  on: {
    progress: MapProgress;
    header?: (extent: MapExtent) => void;
    map: (map: SnapshotMap) => void;
  },
): Promise<SnapshotMap> {
  let map: SnapshotMap | null = null;
  const bytes = await readMapBytes(body, on, (data) => {
    map = unpackMap(data);
    on.map(map);
  });
  if (!map) {
    map = unpackMap(bytes);
    on.map(map);
  }
  return map;
}

/** Reads the touches part for a map that already plays. A retry re-reads only this part. */
export async function readMapTouches(
  body: ReadableStream<Uint8Array>,
  map: SnapshotMap,
  progress: MapProgress,
): Promise<Touches> {
  const bytes = await readTouchesBytes(body, touchesBytes(map), progress);
  return unpackTouches(bytes, map);
}

export type PartReader = (url: string) => Promise<ReadableStream<Uint8Array>>;

/**
 * Opens the touches request beside the map request. Reading the touches bytes waits for the map,
 * whose header gives their expected length.
 */
export function loadSnapshotParts(
  open: PartReader,
  urls: { map: string; touches: string },
  on: {
    progress: (part: 'map' | 'touches', received: number, total: number) => void;
    header?: (extent: MapExtent) => void;
    map: (map: SnapshotMap) => void;
  },
): { map: Promise<SnapshotMap>; touches: Promise<Touches> } {
  const touchesBody = open(urls.touches);
  const map = open(urls.map).then((body) =>
    readMapPart(body, {
      progress: (received, total) => on.progress('map', received, total),
      header: on.header,
      map: on.map,
    }),
  );
  const touches = Promise.all([map, touchesBody]).then(([map, body]) =>
    readMapTouches(body, map, (received, total) => on.progress('touches', received, total)),
  );
  return { map, touches };
}

/** Fetches the touches part again for a map that already plays. */
export function retrySnapshotTouches(
  open: PartReader,
  url: string,
  map: SnapshotMap,
  progress: MapProgress,
): Promise<Touches> {
  return open(url).then((body) => readMapTouches(body, map, progress));
}

/** Decodes the map part: commit times, lifetimes, positions and directory names. */
export function unpackMap(bytes: Uint8Array): SnapshotMap {
  const at = readLayout(bytes);
  const { files, commits, positionScale, beats } = at;
  if (bytes.byteLength !== at.map || commits === 0 || !(positionScale > 0))
    throw new Error('The map file does not match its header.');
  const times = new Float64Array(commits);
  const deltas = joinPlanes(bytes, at.times, commits, 4);
  let time = at.startTime;
  for (let i = 0; i < commits; i++) times[i] = time += deltas[i];
  const born = joinPlanes(bytes, at.born, files, 4);
  const died = joinPlanes(bytes, at.died, files, 4);
  const directory = joinPlanes(bytes, at.directory, files, 2);
  const beatTicks = joinPlanes(bytes, at.beatTicks, beats, 4);
  const directories: unknown = JSON.parse(
    new TextDecoder().decode(bytes.subarray(at.names, at.names + at.table)),
  );
  if (!Array.isArray(directories) || directories.some((name) => typeof name !== 'string'))
    throw new Error('The map file has an invalid directory table.');
  for (let file = 0; file < files; file++)
    if (born[file] >= died[file] || died[file] > commits || directory[file] >= directories.length)
      throw new Error('The map file has an invalid file lifetime.');
  for (const tick of beatTicks)
    if (tick !== NO_BEAT_TICK && tick >= commits)
      throw new Error('The map file has a beat outside its history.');
  return {
    files,
    commits,
    bytes: bytes.byteLength,
    touches: at.touches,
    positions: new Int16Array(joinPlanes(bytes, at.positions, 3 * files, 2).buffer),
    positionScale,
    born,
    died,
    times,
    beatTicks,
    directory,
    directories,
  };
}

function readTouchLayout(bytes: Uint8Array) {
  if (bytes.byteLength < TOUCH_HEADER) throw new Error('The touches file is truncated.');
  const header = new DataView(bytes.buffer, bytes.byteOffset, TOUCH_HEADER);
  if (header.getUint32(0, true) !== TOUCH_MAGIC || header.getUint32(4, true) !== PARTS_FORMAT)
    throw new Error('The touches file has an unknown format.');
  const files = header.getUint32(8, true);
  const touches = header.getUint32(12, true);
  return { files, touches, end: TOUCH_HEADER + 4 * files + 4 * touches };
}

export function unpackTouches(
  bytes: Uint8Array,
  map: Pick<SnapshotMap, 'files' | 'touches' | 'born' | 'commits'>,
): Touches {
  const at = readTouchLayout(bytes);
  if (at.files !== map.files || at.touches !== map.touches)
    throw new Error('The touches file does not match the map.');
  if (bytes.byteLength !== at.end) throw new Error('The touches file is truncated.');
  const counts = joinPlanes(bytes, TOUCH_HEADER, at.files, 4);
  const ticks = joinPlanes(bytes, TOUCH_HEADER + 4 * at.files, at.touches, 4);
  const offsets = new Uint32Array(at.files + 1);
  for (let file = 0; file < at.files; file++) {
    const start = offsets[file];
    const end = start + counts[file];
    if (end > at.touches) throw new Error('The touches file has more touches than it declares.');
    let tick = map.born[file];
    for (let i = start; i < end; i++) ticks[i] = tick += ticks[i];
    if (tick >= map.commits) throw new Error('The touches file has a touch after its last commit.');
    offsets[file + 1] = end;
  }
  if (offsets[at.files] !== at.touches)
    throw new Error('The touches file has fewer touches than it declares.');
  return { offsets, ticks };
}

export function packPaths(snapshot: { files: Pick<FileTrack, 'paths'>[] }): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(snapshot.files.map((file) => file.paths)));
}

export function unpackPaths(bytes: Uint8Array, files: number): FilePaths {
  const paths: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (
    !Array.isArray(paths) ||
    paths.length !== files ||
    paths.some(
      (track) =>
        !Array.isArray(track) ||
        track.length === 0 ||
        track.some(
          (entry) =>
            !Array.isArray(entry) || typeof entry[0] !== 'number' || typeof entry[1] !== 'string',
        ),
    )
  )
    throw new Error('The paths file does not match the map.');
  return paths as FilePaths;
}

/** The part URL names the JSON digest and the format, so a browser may cache it forever. */
export function partVersion(manifest: Pick<Manifest, 'artifact'>): string {
  return `${manifest.artifact.sha256.slice(0, 16)}.${PARTS_FORMAT}`;
}

export function storyOf(manifest: Manifest): Story {
  const { id, repository, generatedAt, startTime, endTime, coverage, eras } = manifest;
  const part = (name: Part) =>
    `/api/snapshots/${id}/${name}?repo=${encodeURIComponent(repository.slug)}&v=${partVersion(manifest)}`;
  return {
    id,
    repository,
    generatedAt,
    startTime,
    endTime,
    coverage,
    eras,
    parts: { map: part('map'), touches: part('touches'), paths: part('paths') },
  };
}
