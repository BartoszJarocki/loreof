import { randomUUID } from 'node:crypto';
import { del, list } from '@vercel/blob';
import { snapshotIdFor } from '../../src/lib/identity';
import type { Fact, Snapshot } from '../../src/lib/schema';
import type { JobAttempt } from '../../src/server/admission';
import { key, redis } from '../../src/server/config';

const sha = 'a'.repeat(40);
export function fixture(): Snapshot {
  const repository = {
    owner: 'owner',
    name: 'repo',
    slug: 'owner/repo',
    head: sha,
    branch: 'main',
    description: 'A repository',
    stars: 1,
  };
  const fact: Fact = { id: 'f1', kind: 'created', text: 'One file was created.', commits: [sha] };
  return {
    schemaVersion: 1,
    pipelineVersion: 'lore-1',
    id: snapshotIdFor(repository),
    repository,
    generatedAt: '2026-11-03T00:00:00.000Z',
    startTime: 1,
    endTime: 1,
    overview: fact.text,
    coverage: {
      scope: 'first-parent',
      totalCommits: 1,
      analyzedCommits: 1,
      totalFiles: 1,
      displayedFiles: 1,
      eligibleGraphCommits: 1,
      selectedGraphCommits: 1,
      pairUpdates: 0,
      edges: 0,
      graphSampled: false,
      filesSampled: false,
      exactRenamesOnly: true,
    },
    authors: [{ kind: 'anonymous', id: 0, label: 'Contributor 1' }],
    commits: [
      {
        sha,
        time: 1,
        authoredAt: 1,
        subject: 'Initial commit',
        author: 0,
        files: 1,
        created: 1,
        deleted: 0,
        merge: false,
        bulk: false,
      },
    ],
    files: [
      {
        id: 0,
        path: 'readme.md',
        kind: 'file',
        born: 0,
        died: null,
        paths: [[0, 'readme.md']],
        touches: [0],
        authors: [{ id: 0, touches: 1 }],
        position: [0, 0, 0],
        directory: '',
      },
    ],
    directories: [{ path: '', files: 1, centroid: [0, 0, 0], color: '#ff6953' }],
    eras: [
      {
        id: 0,
        start: 0,
        end: 1,
        startTime: 1,
        endTime: 1,
        title: 'The first chapter',
        beats: [{ kind: 'fact', ref: fact.id, text: fact.text }],
        narration: 'facts',
        facts: [fact],
        sheet: [],
        directories: [],
        created: 1,
        deleted: 0,
        contributors: 1,
        centroid: [0, 0, 0],
      },
    ],
  };
}

const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
export const hasStorage = Boolean(
  (process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL) &&
  blobToken &&
  blobToken !== 'vercel_blob_rw_not_configured',
);

export async function isolatedStorage(run: (prefix: string) => Promise<void>): Promise<void> {
  const previousRedis = process.env.LORE_REDIS_PREFIX;
  const previousBlob = process.env.LORE_BLOB_PREFIX;
  const unique = randomUUID();
  process.env.LORE_REDIS_PREFIX = `lore:test:removal:${unique}`;
  const prefix = `tests/removal/${unique}/`;
  process.env.LORE_BLOB_PREFIX = prefix;
  try {
    await run(prefix);
  } finally {
    const store = redis();
    const owned = await store.keys(key('*'));
    if (owned.length) await store.del(...owned);
    const blobs = await list({ prefix });
    if (blobs.blobs.length) await del(blobs.blobs.map((blob) => blob.pathname));
    if (previousRedis === undefined) delete process.env.LORE_REDIS_PREFIX;
    else process.env.LORE_REDIS_PREFIX = previousRedis;
    if (previousBlob === undefined) delete process.env.LORE_BLOB_PREFIX;
    else process.env.LORE_BLOB_PREFIX = previousBlob;
  }
}

export async function activeAttempt(snapshot: Snapshot): Promise<JobAttempt> {
  const attempt = { id: snapshot.id, attemptId: randomUUID() };
  const store = redis();
  await store.set(key(`context:${snapshot.id}`), {
    repository: snapshot.repository,
    observedAt: Date.now(),
    attemptId: attempt.attemptId,
  });
  await store.set(key(`job:${snapshot.id}`), {
    id: snapshot.id,
    slug: snapshot.repository.slug,
    state: 'queued',
    updatedAt: new Date().toISOString(),
  });
  await store.zadd(key('leases'), { member: snapshot.id, score: Date.now() + 1200000 });
  return attempt;
}
