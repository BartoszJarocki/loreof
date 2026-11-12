import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { del, get, list, put } from '@vercel/blob';
import { parseSnapshot } from '../src/lib/snapshot';
import { key, redis } from '../src/server/config';
import {
  deleteCheckpoint,
  loadCheckpoint,
  saveCheckpoint,
  sweepCheckpoints,
} from '../src/server/storage';
import { activeAttempt, fixture, hasStorage, isolatedStorage } from './helpers/storage';
import { blobProxy } from './helpers/blob-proxy';

async function age(id: string) {
  const store = redis();
  const raw = await store.get<Record<string, unknown>>(key(`checkpoint:${id}`));
  assert.ok(raw);
  await store.set(key(`checkpoint:${id}`), { ...raw, uploadUntil: Date.now() - 3600000 });
  await store.zadd(key('checkpoints'), { member: id, score: 0 });
}

test(
  'a checkpoint belongs to the snapshot, the first complete write wins, and a stale attempt can neither write nor delete it',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async (prefix) => {
      const snapshot = fixture();
      const first = await activeAttempt(snapshot);
      const path = await saveCheckpoint(first, snapshot);
      assert.equal(await saveCheckpoint(first, snapshot), path);
      const later = { ...snapshot, generatedAt: '2026-11-04T00:00:00.000Z' };
      assert.equal(await saveCheckpoint(first, later), path);
      assert.equal((await loadCheckpoint(first))?.generatedAt, snapshot.generatedAt);
      const next = await activeAttempt(snapshot);
      assert.equal((await loadCheckpoint(next))?.overview, snapshot.overview);
      assert.equal(await loadCheckpoint(first), null);
      await assert.rejects(saveCheckpoint(first, snapshot), /stale/);
      await assert.rejects(saveCheckpoint(first, later), /stale/);
      assert.equal((await loadCheckpoint(next))?.id, snapshot.id);
      assert.equal((await list({ prefix })).blobs.length, 1);
      await deleteCheckpoint(next);
      assert.equal(await get(path, { access: 'private' }), null);
      assert.equal(await loadCheckpoint(next), null);
      await assert.rejects(saveCheckpoint(next, snapshot), /retired/);
    });
  },
);

test(
  'checkpoint sweeper preserves active leases, retires expired attempts, and leaves published and legacy artifacts untouched',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async (prefix) => {
      const snapshot = fixture();
      const attempt = await activeAttempt(snapshot);
      const path = await saveCheckpoint(attempt, snapshot);
      const published = `${prefix}snapshots/owner/repo/keep.json`;
      const legacy = `${prefix}checkpoints/${snapshot.id}.json.gz`;
      await put(published, 'published', { access: 'private', addRandomSuffix: false });
      await put(legacy, 'legacy', { access: 'private', addRandomSuffix: false });
      await age(snapshot.id);
      assert.deepEqual(await sweepCheckpoints(), { deleted: 0, legacyDeleted: 0 });
      assert.equal((await loadCheckpoint(attempt))?.id, snapshot.id);
      await redis().zadd(key('leases'), { member: snapshot.id, score: 0 });
      await age(snapshot.id);
      assert.deepEqual(await sweepCheckpoints(), { deleted: 1, legacyDeleted: 0 });
      assert.deepEqual(await sweepCheckpoints(), { deleted: 0, legacyDeleted: 0 });
      assert.equal(await get(path, { access: 'private' }), null);
      assert.deepEqual(
        (await list({ prefix })).blobs.map((b) => b.pathname).sort(),
        [legacy, published].sort(),
      );
      await assert.rejects(saveCheckpoint(attempt, snapshot), /retired/);
    });
  },
);

test(
  'a resubmitted head can checkpoint again after the sweep retired its first attempt',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async () => {
      const snapshot = fixture();
      const first = await activeAttempt(snapshot);
      await saveCheckpoint(first, snapshot);
      await redis().set(key(`job:${snapshot.id}`), {
        id: snapshot.id,
        slug: snapshot.repository.slug,
        state: 'failed',
        retryable: true,
        message: 'Narration failed',
        updatedAt: new Date().toISOString(),
      });
      await redis().zrem(key('leases'), snapshot.id);
      await age(snapshot.id);
      assert.deepEqual(await sweepCheckpoints(), { deleted: 1, legacyDeleted: 0 });
      const retry = await activeAttempt(snapshot);
      assert.equal(await loadCheckpoint(retry), null);
      await assert.rejects(saveCheckpoint(first, snapshot), /stale|retired/);
      const path = await saveCheckpoint(retry, snapshot);
      assert.equal((await loadCheckpoint(retry))?.id, snapshot.id);
      assert.ok(await get(path, { access: 'private' }));
      assert.equal(
        Number(await redis().zscore(key('checkpoints'), snapshot.id)) > Date.now() + 6 * 86400_000,
        true,
      );
    });
  },
);

test(
  'a failed upload is accepted only when the stored blob is a valid checkpoint of this snapshot',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async (prefix) => {
      const snapshot = fixture();
      const attempt = await activeAttempt(snapshot);
      const path = `${prefix}checkpoints/owner/repo/${snapshot.id}.json.gz`;
      const store = (content: unknown) =>
        put(path, gzipSync(JSON.stringify(content)), { access: 'private', addRandomSuffix: false });
      await store({ different: true });
      await assert.rejects(saveCheckpoint(attempt, snapshot));
      await del(path);
      await store(parseSnapshot({ ...snapshot, id: 'f'.repeat(24) }));
      await assert.rejects(saveCheckpoint(attempt, snapshot));
      await del(path);
      await store(parseSnapshot({ ...snapshot, generatedAt: '2026-11-04T00:00:00.000Z' }));
      assert.equal(await saveCheckpoint(attempt, snapshot), path);
      assert.equal((await loadCheckpoint(attempt))?.id, snapshot.id);
    });
  },
);

test(
  'checkpoint deletion failures keep inventory and the next sweep completes deletion',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async () => {
      const snapshot = fixture();
      const attempt = await activeAttempt(snapshot);
      const path = await saveCheckpoint(attempt, snapshot);
      await blobProxy(
        async (method) => (method === 'POST' ? 403 : undefined),
        async () => {
          await assert.rejects(deleteCheckpoint(attempt));
        },
      );
      assert.equal(await redis().zcard(key('checkpoints')), 1);
      await age(snapshot.id);
      assert.deepEqual(await sweepCheckpoints(), { deleted: 1, legacyDeleted: 0 });
      assert.equal(await get(path, { access: 'private' }), null);
      assert.equal(await redis().zcard(key('checkpoints')), 0);
    });
  },
);

test(
  'a late upload from a superseded attempt cannot delete the successor checkpoint',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async (prefix) => {
      const snapshot = fixture();
      const first = await activeAttempt(snapshot);
      let hold = true;
      let release = () => {};
      let notify = () => {};
      const blocked = new Promise<void>((resolve) => {
        notify = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      await blobProxy(
        async (method, path) => {
          if (hold && method === 'PUT' && path.startsWith(prefix)) {
            hold = false;
            notify();
            await resume;
          }
        },
        async () => {
          const saving = assert.rejects(saveCheckpoint(first, snapshot), /stale/);
          try {
            await blocked;
            const successor = await activeAttempt(snapshot);
            await saveCheckpoint(successor, snapshot);
            release();
            await saving;
            assert.equal((await loadCheckpoint(successor))?.id, snapshot.id);
            assert.equal((await list({ prefix })).blobs.length, 1);
          } finally {
            release();
            await saving;
          }
        },
      );
    });
  },
);

test(
  'sweep retirement respects the upload grace and rejects the upload when it finishes',
  { skip: !hasStorage, timeout: 30000 },
  async () => {
    await isolatedStorage(async (prefix) => {
      const snapshot = fixture();
      const attempt = await activeAttempt(snapshot);
      let hold = true;
      let release = () => {};
      let notify = () => {};
      const blocked = new Promise<void>((resolve) => {
        notify = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      await blobProxy(
        async (method, path) => {
          if (hold && method === 'PUT' && path.startsWith(prefix)) {
            hold = false;
            notify();
            await resume;
          }
        },
        async () => {
          const saving = assert.rejects(saveCheckpoint(attempt, snapshot), /retired/);
          try {
            await blocked;
            await redis().zadd(key('checkpoints'), { member: snapshot.id, score: 0 });
            await redis().zadd(key('leases'), { member: snapshot.id, score: 0 });
            assert.deepEqual(await sweepCheckpoints(), { deleted: 0, legacyDeleted: 0 });
            assert.equal(await redis().zcard(key('checkpoints')), 1);
            release();
            await saving;
            assert.equal((await list({ prefix })).blobs.length, 0);
            await age(snapshot.id);
            assert.deepEqual(await sweepCheckpoints(), { deleted: 1, legacyDeleted: 0 });
          } finally {
            release();
            await saving;
          }
        },
      );
    });
  },
);

test(
  'legacy cleanup removes only expired checkpoint paths after their lease ends',
  { skip: !hasStorage },
  async (context) => {
    await isolatedStorage(async (prefix) => {
      const snapshot = fixture();
      const legacy = `${prefix}checkpoints/${snapshot.id}.json.gz`;
      const published = `${prefix}snapshots/owner/repo/${snapshot.id}/keep.json.gz`;
      await put(legacy, 'legacy', { access: 'private', addRandomSuffix: false });
      await put(published, 'published', { access: 'private', addRandomSuffix: false });
      const future = Date.now() + 8 * 24 * 60 * 60_000;
      const clock = context.mock.method(Date, 'now', () => future);
      try {
        await redis().zadd(key('leases'), { member: snapshot.id, score: future + 60000 });
        assert.deepEqual(await sweepCheckpoints(), { deleted: 0, legacyDeleted: 0 });
        await redis().zrem(key('leases'), snapshot.id);
        assert.deepEqual(await sweepCheckpoints(), { deleted: 0, legacyDeleted: 1 });
        assert.deepEqual(
          (await list({ prefix })).blobs.map((blob) => blob.pathname),
          [published],
        );
      } finally {
        clock.mock.restore();
      }
    });
  },
);

test(
  'a failed attempt keeps its checkpoint through the retention window and the sweep clears legacy attempt records',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async (prefix) => {
      const snapshot = fixture();
      const attempt = await activeAttempt(snapshot);
      const path = await saveCheckpoint(attempt, snapshot);
      await redis().set(key(`job:${snapshot.id}`), {
        id: snapshot.id,
        slug: snapshot.repository.slug,
        state: 'failed',
        message: 'Narration failed',
        retryable: true,
        updatedAt: new Date().toISOString(),
      });
      await redis().zrem(key('leases'), snapshot.id);
      assert.deepEqual(await sweepCheckpoints(), { deleted: 0, legacyDeleted: 0 });
      const retry = await activeAttempt(snapshot);
      assert.equal((await loadCheckpoint(retry))?.id, snapshot.id);
      assert.equal((await list({ prefix })).blobs[0]?.pathname, path);

      const legacyAttempt = randomUUID();
      const legacyPath = `${prefix}checkpoints/${snapshot.repository.slug}/${snapshot.id}/${legacyAttempt}.json.gz`;
      await put(legacyPath, 'legacy', { access: 'private', addRandomSuffix: false });
      await redis().set(key(`checkpoint:${legacyAttempt}`), {
        id: snapshot.id,
        attemptId: legacyAttempt,
        slug: snapshot.repository.slug,
        state: 'active',
        uploadUntil: Date.now() - 3600000,
      });
      await redis().zadd(key('checkpoints'), { member: legacyAttempt, score: 0 });
      await redis().zadd(key('leases'), { member: snapshot.id, score: 0 });
      assert.deepEqual(await sweepCheckpoints(), { deleted: 1, legacyDeleted: 0 });
      assert.deepEqual(
        (await list({ prefix })).blobs.map((blob) => blob.pathname),
        [path],
      );
    });
  },
);

test(
  'a sweep whose blob delete stalls cannot delete the blob of an attempt that registered meanwhile',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async () => {
      const snapshot = fixture();
      const attempt = await activeAttempt(snapshot);
      await saveCheckpoint(attempt, snapshot);
      await blobProxy(
        async (method) => (method === 'POST' ? 403 : undefined),
        async () => {
          await assert.rejects(deleteCheckpoint(attempt));
        },
      );
      await age(snapshot.id);
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      let stalledOnce = false;
      let stalled: () => void = () => {};
      const reached = new Promise<void>((resolve) => (stalled = resolve));
      await blobProxy(
        async (method) => {
          if (method === 'POST' && !stalledOnce) {
            stalledOnce = true;
            stalled();
            await gate;
          }
        },
        async () => {
          const sweep = sweepCheckpoints();
          await reached;
          const next = await activeAttempt(snapshot);
          const path = await saveCheckpoint(next, snapshot);
          release();
          assert.deepEqual(await sweep, { deleted: 0, legacyDeleted: 0 });
          assert.equal((await loadCheckpoint(next))?.id, snapshot.id);
          assert.ok(await get(path, { access: 'private' }));
        },
      );
    });
  },
);

test(
  'a failed delete before a revival leaves no previous-generation blob once the checkpoint is deleted, and a neighbouring id keeps its blob',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async (prefix) => {
      const snapshot = fixture();
      const neighbour = {
        ...snapshot,
        id: `${snapshot.id.slice(0, 23)}${snapshot.id.endsWith('0') ? '1' : '0'}`,
      };
      const kept = await activeAttempt(neighbour);
      await saveCheckpoint(kept, neighbour);
      const first = await activeAttempt(snapshot);
      await saveCheckpoint(first, snapshot);
      await blobProxy(
        async (method) => (method === 'POST' ? 403 : undefined),
        async () => {
          await assert.rejects(deleteCheckpoint(first));
          const next = await activeAttempt(snapshot);
          await saveCheckpoint(next, snapshot);
        },
      );
      const owned = async (id: string) =>
        (await list({ prefix })).blobs.filter((blob) => blob.pathname.includes(id));
      assert.equal((await owned(snapshot.id)).length, 2, 'both generations are stored');
      const attemptId = (await redis().get<{ attemptId: string }>(key(`context:${snapshot.id}`)))!
        .attemptId;
      await deleteCheckpoint({ id: snapshot.id, attemptId });
      assert.equal((await owned(snapshot.id)).length, 0, 'every generation is deleted');
      assert.equal((await owned(neighbour.id)).length, 1, 'another id keeps its blob');
    });
  },
);

test('the sweep deletes every generation of a checkpoint', { skip: !hasStorage }, async () => {
  await isolatedStorage(async (prefix) => {
    const snapshot = fixture();
    const first = await activeAttempt(snapshot);
    await saveCheckpoint(first, snapshot);
    await blobProxy(
      async (method) => (method === 'POST' ? 403 : undefined),
      async () => {
        await assert.rejects(deleteCheckpoint(first));
        const next = await activeAttempt(snapshot);
        await saveCheckpoint(next, snapshot);
        await assert.rejects(deleteCheckpoint(next));
      },
    );
    assert.equal((await list({ prefix })).blobs.length, 2);
    await age(snapshot.id);
    assert.equal((await sweepCheckpoints()).deleted, 1);
    assert.equal((await list({ prefix })).blobs.length, 0);
  });
});
