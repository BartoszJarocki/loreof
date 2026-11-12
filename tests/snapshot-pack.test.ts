import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync, gzipSync } from 'node:zlib';
import { list, put } from '@vercel/blob';
import { snapshotFixture } from './fixtures/snapshot';
import { fixture as storageFixture, hasStorage, isolatedStorage } from './helpers/storage';
import { manifestSchema, snapshotMetaSchema, type Snapshot } from '../src/lib/schema';
import {
  loadSnapshotParts,
  mapExtent,
  NO_BEAT_TICK,
  packMap,
  packPaths,
  packTouches,
  PART_IDLE_MS,
  partVersion,
  readMapPart,
  retrySnapshotTouches,
  storyOf,
  touchesBytes,
  unpackMap,
  unpackPaths,
  unpackTouches,
} from '../src/lib/snapshot-pack';
import { hash, key, redis } from '../src/server/config';
import { artifactPath, readSnapshotPart } from '../src/server/storage';

function fixture(): Snapshot {
  const base = snapshotFixture();
  const file = base.files[0];
  return {
    ...base,
    startTime: 1_000,
    commits: [1_000, 1_060, 1_060, 5_000].map((time) => ({ ...base.commits[0], time })),
    files: [
      {
        ...file,
        born: 0,
        died: null,
        touches: [0, 2, 3],
        position: [4.095, -1.5, 0],
        directory: 'src',
        paths: [[0, 'src/a.ts']],
      },
      {
        ...file,
        id: 1,
        born: 1,
        died: 3,
        touches: [1],
        position: [1.234, 0.001, -4.095],
        directory: '.',
        paths: [
          [1, 'b.ts'],
          [2, 'lib/b.ts'],
        ],
      },
      {
        ...file,
        id: 2,
        born: 2,
        died: null,
        touches: [],
        position: [0.5, 2, 3],
        directory: 'src',
        paths: [[2, 'src/c.ts']],
      },
    ],
  };
}

test('packing then unpacking a snapshot returns its positions, lifetimes, touches, and times', () => {
  const map = unpackMap(packMap(fixture()));
  const touches = unpackTouches(packTouches(fixture()), map);
  assert.equal(map.files, 3);
  assert.equal(map.commits, 4);
  assert.equal(map.touches, 4);
  assert.deepEqual([...map.positions], [4095, -1500, 0, 1234, 1, -4095, 500, 2000, 3000]);
  assert.ok(Math.abs(map.positionScale - 0.001) < 1e-15);
  assert.deepEqual([...map.born], [0, 1, 2]);
  assert.deepEqual([...map.died], [4, 3, 4]);
  assert.deepEqual([...touches.offsets], [0, 3, 4, 4]);
  assert.deepEqual([...touches.ticks], [0, 2, 3, 1]);
  assert.deepEqual([...map.times], [1_000, 1_060, 1_060, 5_000]);
  assert.deepEqual([...map.beatTicks], [NO_BEAT_TICK]);
  assert.deepEqual(map.directories, ['src', '.']);
  assert.deepEqual([...map.directory], [0, 1, 0]);
});

test('the map resolves a beat by its sha, not the first commit at the same time', () => {
  const base = fixture();
  const commits = [1_000, 1_060, 1_060, 5_000].map((time, tick) => ({
    ...base.commits[0],
    time,
    sha: ['a', 'd', 'b', 'c'][tick].repeat(40),
  }));
  const eras = [
    {
      ...base.eras[0],
      start: 0,
      end: 4,
      beats: [
        { kind: 'commit' as const, ref: 'c2', sha: 'bbbbbbbbb', date: '1970-01-01', subject: 'B' },
      ],
      sheet: [
        {
          id: 'c2',
          kind: 'commit' as const,
          text: 'B',
          time: 1_060,
          commits: ['b'.repeat(40)],
        },
      ],
    },
  ];
  const map = unpackMap(packMap({ ...base, commits, eras }));
  assert.deepEqual([...map.beatTicks], [2]);
});

test('quantized positions stay within half a step of the layout', () => {
  const snapshot = fixture();
  const map = unpackMap(packMap(snapshot));
  snapshot.files.forEach((file, index) =>
    file.position.forEach((value, axis) =>
      assert.ok(Math.abs(map.positions[3 * index + axis] * map.positionScale - value) <= 0.0005),
    ),
  );
});

test('the map part ends before the touch tail and the touches part carries that tail', () => {
  const mapBytes = packMap(fixture());
  const touchBytes = packTouches(fixture());
  const extent = mapExtent(mapBytes.subarray(0, 44));
  assert.equal(extent.bytes, mapBytes.length);
  assert.equal(extent.touches, 4);
  assert.equal(touchesBytes(extent), 16 + 4 * 3 + 4 * 4);
  assert.equal(touchBytes.length, touchesBytes(extent));
  const map = unpackMap(mapBytes);
  assert.deepEqual([...unpackTouches(touchBytes, map).ticks], [0, 2, 3, 1]);
  assert.throws(
    () => unpackTouches(touchBytes.subarray(0, touchBytes.length - 4), map),
    /truncated/,
  );
});

test('a touches part with a different record count than the map header is rejected', () => {
  const map = unpackMap(packMap(fixture()));
  const other = unpackTouches(packTouches(fixture()), map);
  assert.deepEqual([...other.offsets], [0, 3, 4, 4]);
  const six = { ...fixture(), files: fixture().files.map((file) => ({ ...file })) };
  six.files[0].touches = [0, 1, 2];
  six.files[1].touches = [1, 2, 3];
  assert.equal(packTouches(six).length, 16 + 4 * 3 + 4 * 6);
  assert.throws(() => unpackTouches(packTouches(six), map), /does not match the map/);
});

test('a map file that is cut short, padded, or from another format is rejected', () => {
  const bytes = packMap(fixture());
  assert.throws(() => unpackMap(bytes.subarray(0, bytes.length - 4)), /does not match its header/);
  assert.throws(
    () => unpackMap(new Uint8Array([...bytes, 0, 0, 0, 0])),
    /does not match its header/,
  );
  const other = bytes.slice();
  other[4] = 9;
  assert.throws(() => unpackMap(other), /unknown format/);
  assert.throws(() => unpackMap(bytes.subarray(0, 12)), /truncated/);
});

test('a lifetime or touch outside the history is rejected', () => {
  const late = fixture();
  late.files[2].touches = [2, 9];
  assert.throws(
    () => unpackTouches(packTouches(late), unpackMap(packMap(late))),
    /touch after its last commit/,
  );
  const backward = fixture();
  backward.files[1].died = 1;
  assert.throws(() => unpackMap(packMap(backward)), /invalid file lifetime/);
});

const gzipped = (bytes: Uint8Array) => new Uint8Array(gzipSync(bytes));
const decoded = (bytes: Uint8Array) =>
  new Response(new Uint8Array(bytes)).body!.pipeThrough(new DecompressionStream('gzip'));

/**
 * Exercises the library loader the viewer calls: both parts open together, the bad touches part
 * fails, then the retry asks for the touches URL again. Each URL holds one queued response, so a
 * second map request fails the test. This guards the library, not the viewer's retry choice; the
 * browser specs in lifecycle.spec.ts guard that a touches retry never refetches the map.
 */
async function retryOnlyTouches(bad: Uint8Array) {
  const mapPart = gzipped(packMap(fixture()));
  const good = gzipped(packTouches(fixture()));
  const queued: Record<string, Uint8Array[]> = { map: [mapPart], touches: [bad, good] };
  const requests: string[] = [];
  const bytes: Record<string, number> = { map: 0, touches: 0 };
  const open = async (url: string) => {
    const part = queued[url].shift();
    if (!part) throw new Error(`The viewer requested ${url} again.`);
    requests.push(url);
    bytes[url] += part.byteLength;
    return decoded(part);
  };
  let played = false;
  const loaded = loadSnapshotParts(
    open,
    { map: 'map', touches: 'touches' },
    {
      progress() {},
      map() {
        played = true;
      },
    },
  );
  const map = await loaded.map;
  assert.equal(played, true);
  await assert.rejects(loaded.touches);
  assert.deepEqual([...requests].sort(), ['map', 'touches']);
  assert.equal(bytes.touches, bad.byteLength);
  const touches = await retrySnapshotTouches(open, 'touches', map, () => {});
  assert.deepEqual([...requests].sort(), ['map', 'touches', 'touches']);
  assert.equal(requests.filter((url) => url === 'map').length, 1);
  assert.equal(bytes.map, mapPart.byteLength);
  assert.equal(bytes.touches, bad.byteLength + good.byteLength);
  assert.deepEqual([...touches.ticks], [0, 2, 3, 1]);
  return { retry: good.byteLength, whole: mapPart.byteLength + good.byteLength };
}

test('a truncated gzip touch part retries only the touch part', async () => {
  const good = gzipped(packTouches(fixture()));
  const { retry, whole } = await retryOnlyTouches(good.subarray(0, good.length - 10));
  assert.ok(retry < whole);
});

test('a truncated raw touch part retries only the touch part', async () => {
  const touchBytes = packTouches(fixture());
  const { retry, whole } = await retryOnlyTouches(
    gzipped(touchBytes.subarray(0, touchBytes.length - 4)),
  );
  assert.ok(retry < whole);
});

test('a touches header that overstates its count retries only the touch part', async () => {
  const touchBytes = packTouches(fixture());
  const lied = touchBytes.slice();
  new DataView(lied.buffer).setUint32(
    12,
    new DataView(lied.buffer).getUint32(12, true) + 100,
    true,
  );
  const { retry, whole } = await retryOnlyTouches(gzipped(lied));
  assert.ok(retry < whole);
});

test('a map stream that fails before the first byte leaves the map unplayed', async () => {
  let played = false;
  await assert.rejects(
    readMapPart(decoded(gzipped(packMap(fixture())).subarray(0, 8)), {
      progress() {},
      map() {
        played = true;
      },
    }),
    Error,
  );
  assert.equal(played, false);
});

test('a part that stalls after its header fails on the idle timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const map = packMap(fixture());
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(map.subarray(0, 44));
      },
    });
    const result = readMapPart(body, { progress() {}, map() {} }).then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(PART_IDLE_MS);
    assert.equal(
      await Promise.race([
        result,
        new Promise((resolve) => setImmediate(() => resolve('still waiting'))),
      ]),
      'The snapshot part stopped arriving.',
    );
  } finally {
    t.mock.timers.reset();
  }
});

test('paths round-trip in file order and must match the map', () => {
  const snapshot = fixture();
  assert.deepEqual(unpackPaths(packPaths(snapshot), 3), [
    [[0, 'src/a.ts']],
    [
      [1, 'b.ts'],
      [2, 'lib/b.ts'],
    ],
    [[2, 'src/c.ts']],
  ]);
  assert.throws(() => unpackPaths(packPaths(snapshot), 2), /does not match the map/);
});

test('the story carries the eras as they are and names versioned part URLs', () => {
  const snapshot = fixture();
  const story = storyOf({
    ...snapshotMetaSchema.parse(snapshot),
    artifact: { pathname: 'x', sha256: 'f'.repeat(64), bytes: 1 },
  });
  assert.deepEqual(Object.keys(story).sort(), [
    'coverage',
    'endTime',
    'eras',
    'generatedAt',
    'id',
    'parts',
    'repository',
    'startTime',
  ]);
  assert.deepEqual(story.eras, snapshot.eras);
  assert.deepEqual(story.parts, {
    map: `/api/snapshots/${snapshot.id}/map?repo=owner%2Frepo&v=ffffffffffffffff.3`,
    touches: `/api/snapshots/${snapshot.id}/touches?repo=owner%2Frepo&v=ffffffffffffffff.3`,
    paths: `/api/snapshots/${snapshot.id}/paths?repo=owner%2Frepo&v=ffffffffffffffff.3`,
  });
});

test(
  'a snapshot published before the parts existed converts on its first read and keeps them',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async (prefix) => {
      const snapshot = storageFixture();
      const slug = snapshot.repository.slug;
      const bytes = gzipSync(JSON.stringify(snapshot));
      const pathname = artifactPath(slug, snapshot.id, hash(bytes));
      await put(pathname, bytes, { access: 'private', addRandomSuffix: false });
      const manifest = manifestSchema.parse({
        ...snapshotMetaSchema.parse(snapshot),
        artifact: { pathname, sha256: hash(bytes), bytes: bytes.length },
      });
      await redis().set(key(`manifest:${slug}:${snapshot.id}`), JSON.stringify(manifest));
      await redis().set(key(`visible:${slug}`), '1');
      const version = partVersion(manifest);

      assert.equal(await readSnapshotPart(slug, snapshot.id, 'map', 'stale.1'), null);
      const first = await readSnapshotPart(slug, snapshot.id, 'map', version);
      assert.ok(first);
      const map = unpackMap(gunzipSync(first));
      assert.deepEqual([...map.born, ...map.died], [0, 1]);
      const touchesPart = await readSnapshotPart(slug, snapshot.id, 'touches', version);
      assert.ok(touchesPart);
      assert.deepEqual([...unpackTouches(gunzipSync(touchesPart), map).ticks], [0]);
      assert.deepEqual(
        (await list({ prefix })).blobs.map((blob) => blob.pathname).sort(),
        [
          pathname,
          pathname.replace('.json.gz', '.map.3.gz'),
          pathname.replace('.json.gz', '.touches.3.gz'),
          pathname.replace('.json.gz', '.paths.3.gz'),
        ].sort(),
      );
      assert.deepEqual(await readSnapshotPart(slug, snapshot.id, 'map', version), first);
      const paths = await readSnapshotPart(slug, snapshot.id, 'paths', version);
      assert.ok(paths);
      assert.deepEqual(unpackPaths(gunzipSync(paths), 1), [[[0, 'readme.md']]]);
    });
  },
);
