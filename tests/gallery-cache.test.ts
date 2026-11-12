import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { manifestSchema, snapshotMetaSchema } from '../src/lib/schema';
import { listGallery } from '../src/server/catalog';
import { hash, key, redis } from '../src/server/config';
import { artifactPath } from '../src/server/storage';
import { fixture, hasStorage, isolatedStorage } from './helpers/storage';

test(
  'the collection reads its manifests once per minute, not once per view',
  { skip: !hasStorage },
  async (t) => {
    const realFetch = globalThis.fetch;
    await isolatedStorage(async () => {
      const snapshot = fixture();
      snapshot.repository = {
        ...snapshot.repository,
        owner: 'react',
        name: 'react',
        slug: 'react/react',
      };
      const slug = snapshot.repository.slug;
      const bytes = gzipSync(JSON.stringify(snapshot));
      const manifest = manifestSchema.parse({
        ...snapshotMetaSchema.parse(snapshot),
        artifact: {
          pathname: artifactPath(slug, snapshot.id, hash(bytes)),
          sha256: hash(bytes),
          bytes: bytes.length,
        },
      });
      const store = redis();
      await store.sadd(key('gallery'), slug);
      await store.set(key(`manifest:${slug}:${snapshot.id}`), JSON.stringify(manifest));
      await store.set(key(`latest:${slug}`), snapshot.id);
      await store.set(key(`visible:${slug}`), '1');

      let redisCalls = 0;
      t.mock.method(globalThis, 'fetch', (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).startsWith('http://127.0.0.1:8104')) redisCalls++;
        return realFetch(url, init);
      });

      assert.equal((await listGallery()).length, 1);
      redisCalls = 0;
      assert.equal((await listGallery()).length, 1);
      assert.equal(redisCalls, 0, 'the second view within a minute reads no Redis keys');
    });
  },
);
