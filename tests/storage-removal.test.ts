import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { list, put } from '@vercel/blob';
import { hash, key, PublicError, redis } from '../src/server/config';
import {
  artifactPath,
  assertVisible,
  loadCheckpoint,
  removeRepository,
  saveCheckpoint,
} from '../src/server/storage';
import { removeWaitlistEmail } from '../src/server/waitlist';
import { activeAttempt, fixture, hasStorage, isolatedStorage } from './helpers/storage';

function isRemoved(error: unknown): boolean {
  return error instanceof PublicError && error.status === 410;
}

test(
  'real storage removal deletes repository data and is safe to repeat',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async (prefix) => {
      const snapshot = fixture();
      const slug = snapshot.repository.slug;
      const store = redis();
      const attempt = await activeAttempt(snapshot);
      const checkpoint = await saveCheckpoint(attempt, snapshot);
      assert.equal((await loadCheckpoint(attempt))?.id, snapshot.id);
      assert.deepEqual(await store.smembers(key(`snapshots:${slug}`)), [snapshot.id]);
      const artifact = artifactPath(slug, snapshot.id, hash('artifact'));
      const manifest = `${prefix}manifests/${slug}/${snapshot.id}/${hash('manifest')}.json`;
      const unrelated = `${prefix}snapshots/owner/repo-other/keep.json`;
      for (const path of [artifact, manifest, unrelated])
        await put(path, '{}', { access: 'private', addRandomSuffix: false });
      const deleted = [
        `manifest:${slug}:${snapshot.id}`,
        `job:${snapshot.id}`,
        `context:${snapshot.id}`,
        `command:${snapshot.id}`,
        `command:${snapshot.id}:attempt`,
        `charged:${snapshot.id}`,
        `narration:${snapshot.id}:0`,
        `narration:${snapshot.id}:attempt:0`,
        `visible:${slug}`,
        `seen:${slug}`,
        `missing:${slug}`,
        `latest:${slug}`,
        `fence:${slug}`,
      ];
      for (const name of deleted) await store.set(key(name), 'stored');
      await store.sadd(key('gallery'), slug);
      await store.zadd(key('leases'), { member: snapshot.id, score: Date.now() + 10000 });

      await removeRepository(slug.toUpperCase());
      await removeRepository(slug);

      assert.deepEqual(
        (await list({ prefix })).blobs.map((blob) => blob.pathname),
        [unrelated],
      );
      assert.ok(checkpoint.startsWith(prefix));
      assert.equal(await loadCheckpoint(attempt), null);
      for (const name of deleted) assert.equal(await store.exists(key(name)), 0, name);
      assert.equal(await store.sismember(key('gallery'), slug), 0);
      assert.equal(await store.zscore(key('leases'), snapshot.id), null);
      assert.equal(await store.exists(key(`removed:${slug}`)), 1);
      assert.equal(await store.ttl(key(`removed:${slug}`)), -1);
      assert.deepEqual(await store.smembers(key(`snapshots:${slug}`)), [snapshot.id]);
      await assert.rejects(assertVisible(slug), isRemoved);
      await assert.rejects(saveCheckpoint(attempt, snapshot), isRemoved);
      assert.deepEqual(
        (await list({ prefix })).blobs.map((blob) => blob.pathname),
        [unrelated],
      );
    });
  },
);

test(
  'a real checkpoint upload that finishes after removal deletes its late write',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async (prefix) => {
      const snapshot = fixture();
      const previousApi = process.env.VERCEL_BLOB_API_URL;
      const upstream = previousApi ?? 'https://vercel.com/api/blob';
      let notifyBlocked = () => {};
      let releaseUpload = () => {};
      const blocked = new Promise<void>((resolve) => {
        notifyBlocked = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseUpload = resolve;
      });
      let held = false;
      const proxy = createServer(async (request, response) => {
        try {
          const url = new URL(request.url ?? '/', 'http://localhost');
          if (
            !held &&
            request.method === 'PUT' &&
            url.searchParams.get('pathname')?.startsWith(prefix)
          ) {
            held = true;
            notifyBlocked();
            await release;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const headers = new Headers();
          for (const [name, value] of Object.entries(request.headers)) {
            if (value !== undefined && !['host', 'connection', 'content-length'].includes(name))
              headers.set(name, Array.isArray(value) ? value.join(', ') : value);
          }
          const body = Buffer.concat(chunks);
          const result = await fetch(upstream + (request.url ?? '/'), {
            method: request.method,
            headers,
            body: body.length ? new Uint8Array(body) : undefined,
          });
          response.statusCode = result.status;
          for (const [name, value] of result.headers)
            if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(name))
              response.setHeader(name, value);
          response.end(Buffer.from(await result.arrayBuffer()));
        } catch {
          response.writeHead(502).end('Test proxy failed');
        }
      });
      proxy.listen(0, '127.0.0.1');
      await once(proxy, 'listening');
      const address = proxy.address();
      assert.ok(address && typeof address !== 'string');
      process.env.VERCEL_BLOB_API_URL = `http://127.0.0.1:${address.port}`;
      const attempt = await activeAttempt(snapshot);
      const saving = saveCheckpoint(attempt, snapshot);
      const outcome = assert.rejects(saving, isRemoved);
      try {
        await Promise.race([
          blocked,
          new Promise<never>((_, reject) => {
            const timer = setTimeout(
              () => reject(new Error('Checkpoint upload was not intercepted')),
              15000,
            );
            timer.unref();
          }),
        ]);
        await removeRepository(snapshot.repository.slug);
        releaseUpload();
        await outcome;
        assert.equal((await list({ prefix })).blobs.length, 0);
      } finally {
        releaseUpload();
        if (previousApi === undefined) delete process.env.VERCEL_BLOB_API_URL;
        else process.env.VERCEL_BLOB_API_URL = previousApi;
        proxy.close();
        await outcome;
      }
    });
  },
);

test(
  'saved email removal normalizes the address and can be repeated',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async () => {
      const store = redis();
      const emailKey = key(`waitlist:${hash('person@example.com')}`);
      await store.set(emailKey, { email: 'person@example.com', consent: true }, { ex: 15552000 });
      await removeWaitlistEmail(' Person@Example.com ');
      await removeWaitlistEmail('person@example.com');
      assert.equal(await store.exists(emailKey), 0);
      await assert.rejects(removeWaitlistEmail('not-an-email'));
    });
  },
);
