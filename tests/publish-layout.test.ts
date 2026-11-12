import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { key, redis } from '../src/server/config';
import { fixture, hasStorage, isolatedStorage } from './helpers/storage';

mock.module('../src/server/github.ts', {
  namedExports: { assertPublic: async () => {}, canonicalName: async (slug: string) => slug },
});
const { publishSnapshot } = await import('../src/server/storage');

test(
  'publishing with latest disabled keeps latest on the default layout snapshot',
  { skip: !hasStorage },
  async () => {
    await isolatedStorage(async () => {
      const spectral = fixture();
      const slug = spectral.repository.slug;
      const force = { ...spectral, id: '1'.repeat(24) };
      await publishSnapshot(spectral, { observedAt: 10 });
      assert.equal(await redis().get(key(`latest:${slug}`)), spectral.id);
      await publishSnapshot(force, { latest: false, observedAt: 20 });
      assert.equal(await redis().get(key(`latest:${slug}`)), spectral.id);
      assert.equal(await redis().get(key(`fence:${slug}`)), 10);
      assert.equal(await redis().sismember(key(`snapshots:${slug}`), force.id), 1);
      assert.equal(
        (await redis().get<{ id: string }>(key(`manifest:${slug}:${force.id}`)))?.id,
        force.id,
      );
      await publishSnapshot(force, { observedAt: 30 });
      assert.equal(await redis().get(key(`latest:${slug}`)), force.id);
    });
  },
);
