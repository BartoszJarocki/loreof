import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { gzipSync, gunzipSync } from 'node:zlib';
import * as blob from '@vercel/blob';
import { hash, key, redis } from '../src/server/config';
import {
  manifestSchema,
  snapshotMetaSchema,
  snapshotSchema,
  type Snapshot,
} from '../src/lib/schema';
import { partVersion, unpackMap } from '../src/lib/snapshot-pack';
import { parseSnapshot } from '../src/lib/snapshot';
import { buildBeats } from '../src/viewer/beats';

let writes = 0;
mock.module('@vercel/blob', {
  namedExports: {
    ...blob,
    put: (...args: Parameters<typeof blob.put>) => {
      writes++;
      return blob.put(...args);
    },
  },
});
const { fixture, hasStorage, isolatedStorage } = await import('./helpers/storage');
const { artifactPath, readSnapshotPart } = await import('../src/server/storage');

test(
  'concurrent first reads of an old snapshot convert it once',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async () => {
      const snapshot = fixture();
      const slug = snapshot.repository.slug;
      const bytes = gzipSync(JSON.stringify(snapshot));
      const pathname = artifactPath(slug, snapshot.id, hash(bytes));
      await blob.put(pathname, bytes, { access: 'private', addRandomSuffix: false });
      const manifest = manifestSchema.parse({
        ...snapshotMetaSchema.parse(snapshot),
        artifact: { pathname, sha256: hash(bytes), bytes: bytes.length },
      });
      await redis().set(key(`manifest:${slug}:${snapshot.id}`), JSON.stringify(manifest));
      await redis().set(key(`visible:${slug}`), '1');
      writes = 0;
      const version = partVersion(manifest);

      const reads = Array.from({ length: 8 }, (_, index) =>
        readSnapshotPart(slug, snapshot.id, index % 2 ? 'map' : 'paths', version),
      );
      const values = await Promise.all(reads);
      const maps = values.filter((_, index) => index % 2 === 1);
      const paths = values.filter((_, index) => index % 2 === 0);
      assert.ok(values.every(Boolean));
      assert.ok(maps.every((value) => value?.equals(maps[0]!)));
      assert.ok(paths.every((value) => value?.equals(paths[0]!)));
      assert.equal(writes, 3);
    });
  },
);

const sha = (digit: string) => digit.repeat(40);

/** Two chapters: the second one is a model chapter whose title names none of its commits. */
function rewritingSnapshot(): Snapshot {
  const times = [100, 200, 300, 400];
  const hashes = ['a', 'b', 'c', 'd'].map(sha);
  const allSubjects = ['First change', 'Second change', 'Third change', 'Fourth change'];
  const commit = (index: number) => ({
    sha: hashes[index]!,
    time: times[index]!,
    authoredAt: times[index]!,
    subject: allSubjects[index]!,
    author: 0,
    files: 0,
    created: 0,
    deleted: 0,
    merge: false,
    bulk: false,
  });
  const sheet = [2, 3].map((tick, index) => ({
    id: `c${index + 1}`,
    kind: 'commit' as const,
    text: allSubjects[tick]!,
    time: times[tick]!,
    commits: [hashes[tick]!],
  }));
  const fact = {
    id: 'f0',
    kind: 'created' as const,
    text: 'Work began.',
    commits: [hashes[0]!],
  };
  return snapshotSchema.parse({
    schemaVersion: 1,
    pipelineVersion: 'lore-4',
    id: 'e'.repeat(24),
    repository: {
      owner: 'owner',
      name: 'repo',
      slug: 'owner/repo',
      head: hashes[3],
      branch: 'main',
      description: '',
      stars: 0,
    },
    generatedAt: '2026-11-03T00:00:00.000Z',
    startTime: times[0],
    endTime: times[3],
    overview: 'Work began.',
    coverage: {
      scope: 'first-parent',
      totalCommits: 4,
      analyzedCommits: 4,
      totalFiles: 1,
      displayedFiles: 1,
      eligibleGraphCommits: 4,
      selectedGraphCommits: 4,
      pairUpdates: 0,
      edges: 0,
      graphSampled: false,
      filesSampled: false,
      exactRenamesOnly: true,
    },
    authors: [{ kind: 'anonymous', id: 0, label: 'Contributor 1' }],
    commits: times.map((_, index) => commit(index)),
    files: [
      {
        id: 0,
        path: 'readme.md',
        kind: 'file',
        born: 0,
        died: null,
        paths: [[0, 'readme.md']],
        touches: [0, 1, 2, 3],
        authors: [{ id: 0, touches: 4 }],
        position: [0, 0, 0],
        directory: '',
      },
    ],
    directories: [{ path: '', files: 1, centroid: [0, 0, 0], color: '#ff6953' }],
    eras: [
      {
        id: 0,
        start: 0,
        end: 2,
        startTime: times[0],
        endTime: times[1],
        title: 'The first chapter',
        beats: [{ kind: 'fact', ref: fact.id, text: fact.text }],
        narration: 'facts',
        facts: [fact],
        sheet: [],
        directories: [],
        created: 0,
        deleted: 0,
        contributors: 1,
        centroid: [0, 0, 0],
      },
      {
        id: 1,
        start: 2,
        end: 4,
        startTime: times[2],
        endTime: times[3],
        title: 'Nothing here matches',
        beats: sheet.map((item) => ({
          kind: 'commit' as const,
          ref: item.id,
          sha: item.commits[0].slice(0, 7),
          date: new Date(item.time * 1000).toISOString().slice(0, 10),
          subject: item.text,
        })),
        narration: 'model',
        facts: [
          {
            id: 'f1',
            kind: 'activity',
            text: 'Work continued.',
            commits: [hashes[2]!],
          },
        ],
        sheet,
        directories: [],
        created: 0,
        deleted: 0,
        contributors: 1,
        centroid: [0, 0, 0],
      },
    ],
  });
}

test(
  'conversion packs beat ticks against the chapters the page shows, not a rewritten era',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async () => {
      const raw = rewritingSnapshot();
      const slug = raw.repository.slug;
      // The stored JSON is what the reader parses, and it turns the model chapter into facts.
      const bytes = gzipSync(JSON.stringify(raw));
      const pathname = artifactPath(slug, raw.id, hash(bytes));
      await blob.put(pathname, bytes, { access: 'private', addRandomSuffix: false });
      const manifest = manifestSchema.parse({
        ...snapshotMetaSchema.parse(raw),
        artifact: { pathname, sha256: hash(bytes), bytes: bytes.length },
      });
      assert.equal(manifest.eras[1]?.beats.length, 2, 'the manifest keeps the model chapter');
      assert.equal(parseSnapshot(raw).eras[1]?.beats.length, 1, 'the stored JSON rewrites it');
      await redis().set(key(`manifest:${slug}:${raw.id}`), JSON.stringify(manifest));
      await redis().set(key(`latest:${slug}`), raw.id);
      await redis().set(key(`visible:${slug}`), '1');

      const part = await readSnapshotPart(slug, raw.id, 'map', partVersion(manifest));
      assert.ok(part);
      const map = unpackMap(gunzipSync(part!));
      const beats = buildBeats(manifest.eras, raw.commits, map.beatTicks);
      assert.deepEqual(
        beats.map((beat) => beat.fullSha),
        [sha('c'), sha('d')],
        'every later chapter beat names the commit its sheet item cites',
      );
      assert.deepEqual(
        [...map.beatTicks],
        [0xffffffff, 2, 3],
        'the ticks follow the manifest chapters in era and beat order',
      );
    });
  },
);
