import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  manifestSchema,
  snapshotMetaSchema,
  type Manifest,
  type Snapshot,
} from '../src/lib/schema';
import { hash, key, redis } from '../src/server/config';
import { denial } from '../src/server/github';
import { artifactPath, assertReachable, assertVisible, readManifest } from '../src/server/storage';
import { viewRepository } from '../src/server/catalog';
import { transport } from './helpers/github';
import { fixture, hasStorage, isolatedStorage } from './helpers/storage';

async function storedManifest(
  description = 'A repository',
): Promise<{ snapshot: Snapshot; manifest: Manifest; slug: string }> {
  const source = fixture();
  source.repository.description = description;
  const snapshot = source;
  const slug = snapshot.repository.slug;
  const bytes = gzipSync(JSON.stringify(snapshot));
  const pathname = artifactPath(slug, snapshot.id, hash(bytes));
  const manifest = manifestSchema.parse({
    ...snapshotMetaSchema.parse(snapshot),
    artifact: { pathname, sha256: hash(bytes), bytes: bytes.length },
  });
  const store = redis();
  await store.set(key(`manifest:${slug}:${snapshot.id}`), JSON.stringify(manifest));
  await store.set(key(`latest:${slug}`), snapshot.id);
  return { snapshot, manifest, slug };
}

async function requestOnlyGitHub(
  realFetch: typeof fetch,
  url: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const target = String(url);
  return target.startsWith('https://github.com/') ||
    target.startsWith('https://api.github.com/') ||
    target.startsWith('https://raw.githubusercontent.com/')
    ? transport(url, init)
    : realFetch(url, init);
}

test(
  'two requests for the same missing slug make one GitHub round trip',
  { skip: !hasStorage },
  async (t) => {
    const realFetch = globalThis.fetch;
    await isolatedStorage(async () => {
      const requests: string[] = [];
      t.mock.method(globalThis, 'fetch', (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes('/info/refs?')) {
          requests.push(String(url));
          return Promise.resolve(new Response(null, { status: 404 }));
        }
        if (String(url).startsWith('https://github.com/')) requests.push(String(url));
        return requestOnlyGitHub(realFetch, url, init);
      });
      await assert.rejects(assertReachable('nobody/nothing'), { status: 404 });
      const first = requests.length;
      assert.ok(first > 0, 'the first request asks GitHub');
      await assert.rejects(assertReachable('nobody/nothing'), { status: 404 });
      assert.equal(requests.length, first, 'the second request makes no GitHub call');
    });
  },
);

test(
  'a throttled visibility check still serves a film it has seen, and only that one',
  { skip: !hasStorage },
  async (t) => {
    const realFetch = globalThis.fetch;
    await isolatedStorage(async () => {
      const { manifest, slug } = await storedManifest();
      let throttled = false;
      t.mock.method(globalThis, 'fetch', (url: string | URL | Request, init?: RequestInit) =>
        throttled && String(url).includes('/info/refs?')
          ? Promise.resolve(new Response(null, { status: 429 }))
          : requestOnlyGitHub(realFetch, url, init),
      );
      await assertVisible(slug, true);
      await redis().del(key(`visible:${slug}`));
      throttled = true;

      assert.equal((await readManifest(slug, manifest.id))?.id, manifest.id);
      const error = await assertVisible('nobody/nothing').catch((caught: unknown) => caught);
      assert.equal(denial(error), 'rate-limited');
    });
  },
);

test(
  'a 403 without a rate-limit signal is a definite denial that clears the seen marker',
  { skip: !hasStorage },
  async (t) => {
    const realFetch = globalThis.fetch;
    await isolatedStorage(async () => {
      const { slug } = await storedManifest();
      let refs: 'ok' | 'blocked' = 'ok';
      let optOut: 'ok' | 'blocked' = 'ok';
      t.mock.method(globalThis, 'fetch', (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        if (refs === 'blocked' && target.includes('/info/refs?'))
          return Promise.resolve(new Response(null, { status: 403 }));
        if (optOut === 'blocked' && target.startsWith('https://raw.githubusercontent.com/'))
          return Promise.resolve(new Response(null, { status: 403 }));
        return requestOnlyGitHub(realFetch, url, init);
      });

      await assertVisible(slug, true);
      await redis().del(key(`visible:${slug}`));
      refs = 'blocked';
      await assert.rejects(assertVisible(slug), { status: 404 });
      assert.equal(
        await redis().exists(key(`seen:${slug}`)),
        0,
        'a blocked repository is not remembered as seen for a week',
      );

      await redis().del(key(`missing:${slug}`), key(`visible:${slug}`));
      refs = 'ok';
      await assertVisible(slug, true);
      await redis().del(key(`visible:${slug}`));
      optOut = 'blocked';
      await assert.rejects(assertVisible(slug), { status: 404 });
      assert.equal(
        await redis().exists(key(`seen:${slug}`)),
        0,
        'a blocked opt-out check is not remembered as seen for a week',
      );
    });
  },
);

test(
  'a 403 that carries a rate-limit signal still serves a film it has seen',
  { skip: !hasStorage },
  async (t) => {
    const realFetch = globalThis.fetch;
    await isolatedStorage(async () => {
      const { slug } = await storedManifest();
      let refs: 'ok' | 'remaining' | 'retry' = 'ok';
      let optOut: 'ok' | 'remaining' = 'ok';
      t.mock.method(globalThis, 'fetch', (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        if (refs !== 'ok' && target.includes('/info/refs?'))
          return Promise.resolve(
            new Response(
              null,
              refs === 'remaining'
                ? { status: 403, headers: { 'x-ratelimit-remaining': '0' } }
                : { status: 403, headers: { 'retry-after': '60' } },
            ),
          );
        if (optOut === 'remaining' && target.startsWith('https://raw.githubusercontent.com/'))
          return Promise.resolve(
            new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
          );
        return requestOnlyGitHub(realFetch, url, init);
      });

      await assertVisible(slug, true);
      for (const mode of ['remaining', 'retry'] as const) {
        await redis().del(key(`visible:${slug}`));
        refs = mode;
        await assertVisible(slug);
        assert.equal(
          await redis().exists(key(`seen:${slug}`)),
          1,
          `the ${mode} signal is a throttle, not a denial`,
        );
      }
      await redis().del(key(`visible:${slug}`));
      refs = 'ok';
      optOut = 'remaining';
      await assertVisible(slug);
    });
  },
);

test(
  'a fresh visibility check fails during an outage even when the film was seen',
  { skip: !hasStorage },
  async (t) => {
    const realFetch = globalThis.fetch;
    await isolatedStorage(async () => {
      const { slug } = await storedManifest();
      let throttled = false;
      t.mock.method(globalThis, 'fetch', (url: string | URL | Request, init?: RequestInit) =>
        throttled && String(url).includes('/info/refs?')
          ? Promise.resolve(new Response(null, { status: 429 }))
          : requestOnlyGitHub(realFetch, url, init),
      );
      await assertVisible(slug, true);
      await redis().del(key(`visible:${slug}`));
      throttled = true;

      const error = await assertVisible(slug, true).catch((caught: unknown) => caught);
      assert.equal(denial(error), 'rate-limited', 'publishing does not fall back to the marker');
      await assertVisible(slug);
    });
  },
);

test(
  'a failed description lookup is called once across two views',
  { skip: !hasStorage },
  async (t) => {
    const realFetch = globalThis.fetch;
    await isolatedStorage(async () => {
      const { slug } = await storedManifest('');
      await redis().set(key(`visible:${slug}`), '1');
      let detailsCalls = 0;
      t.mock.method(globalThis, 'fetch', (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).startsWith('https://api.github.com/')) {
          detailsCalls++;
          return Promise.resolve(new Response(null, { status: 403 }));
        }
        return requestOnlyGitHub(realFetch, url, init);
      });

      const first = await viewRepository(slug);
      const second = await viewRepository(slug);
      assert.equal(first.kind, 'ready');
      assert.equal(second.kind, 'ready');
      assert.equal(detailsCalls, 1, 'the empty description is remembered');
    });
  },
);
