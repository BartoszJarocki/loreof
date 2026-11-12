import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { put } from '@vercel/blob';
import { manifestSchema, snapshotMetaSchema } from '../src/lib/schema';
import { partVersion } from '../src/lib/snapshot-pack';
import { hash, key, redis } from '../src/server/config';
import { artifactPath } from '../src/server/storage';
import { fixture, hasStorage, isolatedStorage } from './helpers/storage';

test(
  'the part route asks the CDN to keep a digest-named part while the browser keeps it forever',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async () => {
      const snapshot = fixture();
      const slug = snapshot.repository.slug;
      const bytes = gzipSync(JSON.stringify(snapshot));
      const pathname = artifactPath(slug, snapshot.id, hash(bytes));
      const manifest = manifestSchema.parse({
        ...snapshotMetaSchema.parse(snapshot),
        artifact: { pathname, sha256: hash(bytes), bytes: bytes.length },
      });
      await put(pathname, bytes, { access: 'private', addRandomSuffix: false });
      await redis().set(key(`manifest:${slug}:${snapshot.id}`), JSON.stringify(manifest));
      await redis().set(key(`latest:${slug}`), snapshot.id);
      await redis().set(key(`visible:${slug}`), '1');

      const { GET } = await import('../src/app/api/snapshots/[id]/[part]/route');
      const id = snapshot.id;
      const response = await GET(
        new Request(
          `https://lore.example/api/snapshots/${id}/map?repo=${encodeURIComponent(slug)}&v=${partVersion(manifest)}`,
        ),
        { params: Promise.resolve({ id, part: 'map' }) },
      );
      assert.equal(response.status, 200);
      const cache = response.headers.get('cache-control') ?? '';
      assert.match(cache, /public/);
      assert.doesNotMatch(cache, /private/);
      assert.match(cache, /max-age=31536000/);
      assert.match(cache, /s-maxage=86400/);
      assert.match(cache, /immutable/);
      assert.equal(response.headers.get('vercel-cdn-cache-control'), null);
    });
  },
);
