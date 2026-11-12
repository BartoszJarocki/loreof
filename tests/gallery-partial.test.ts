import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { GALLERY } from '../src/lib/gallery';
import { manifestSchema, snapshotMetaSchema } from '../src/lib/schema';
import { listGallery } from '../src/server/catalog';
import { hash, key, redis } from '../src/server/config';
import { artifactPath } from '../src/server/storage';
import { fixture, hasStorage, isolatedStorage } from './helpers/storage';

test(
  'the collection is not remembered from a read that lost a manifest',
  { skip: !hasStorage },
  async (t) => {
    const realFetch = globalThis.fetch;
    await isolatedStorage(async () => {
      const store = redis();
      const slugs = GALLERY.slice(0, 2).map((item) => item.slug.toLowerCase());
      for (const slug of slugs) {
        const snapshot = fixture();
        const [owner, name] = slug.split('/');
        snapshot.repository = { ...snapshot.repository, owner, name, slug };
        const bytes = gzipSync(JSON.stringify(snapshot));
        const manifest = manifestSchema.parse({
          ...snapshotMetaSchema.parse(snapshot),
          artifact: {
            pathname: artifactPath(slug, snapshot.id, hash(bytes)),
            sha256: hash(bytes),
            bytes: bytes.length,
          },
        });
        await store.sadd(key('gallery'), slug);
        await store.set(key(`manifest:${slug}:${snapshot.id}`), JSON.stringify(manifest));
        await store.set(key(`latest:${slug}`), snapshot.id);
        await store.set(key(`visible:${slug}`), '1');
      }

      let failAll = false;
      let failOnce = '';
      t.mock.method(globalThis, 'fetch', (url: string | URL | Request, init?: RequestInit) => {
        if (!String(url).startsWith('http://127.0.0.1:8104')) return realFetch(url, init);
        const body = typeof init?.body === 'string' ? init.body : '';
        if (failAll && body.includes(':latest:'))
          return Promise.resolve(
            new Response(JSON.stringify({ error: 'unavailable' }), { status: 500 }),
          );
        if (failOnce && body.includes(`:latest:${failOnce}`)) {
          failOnce = '';
          return Promise.resolve(
            new Response(JSON.stringify({ error: 'unavailable' }), { status: 500 }),
          );
        }
        return realFetch(url, init);
      });

      try {
        failAll = true;
        assert.equal(
          (await listGallery()).length,
          0,
          'a read where every manifest failed renders nothing',
        );
        failAll = false;

        failOnce = slugs[1] ?? '';
        assert.equal((await listGallery()).length, 1, 'one failed manifest renders the other film');
        assert.equal(
          (await listGallery()).length,
          2,
          'the next view is not served the partial collection',
        );
      } finally {
        failAll = false;
        failOnce = '';
      }
    });
  },
);
