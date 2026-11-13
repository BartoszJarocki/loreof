import { parseSnapshot } from '../src/lib/snapshot';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { snapshotIdFor } from '../src/lib/identity';
import { snapshotFixture as fixture } from './fixtures/snapshot';
import {
  ADMISSION_SCRIPT,
  admit,
  readAttempt,
  updateJob,
  UPDATE_JOB_SCRIPT,
  ACTIVE_ATTEMPT_SCRIPT,
  SAVE_NARRATION_SCRIPT,
  resets,
} from '../src/server/admission';
import { WorkflowStartError } from 'workflow/errors';
import { sha as githubSha, transport } from './helpers/github';
import { hash, PublicError, redis } from '../src/server/config';
import { errorResponse, mutationBody } from '../src/server/http';
import { parseRepository } from '../src/server/github';
import { artifactPath, PUBLISH_SCRIPT } from '../src/server/storage';
import { renderStill } from '../src/server/still';
import { WAITLIST_SCRIPT, waitlistSchema } from '../src/server/waitlist';

const sha = 'a'.repeat(40);

test('repository input accepts only public GitHub identifiers', () => {
  assert.equal(parseRepository('https://github.com/Facebook/React.git/'), 'facebook/react');
  assert.equal(parseRepository(' Owner/repo.name '), 'owner/repo.name');
  assert.equal(parseRepository('https://github.com/a/b?x=1#readme'), 'a/b');
  for (const input of [
    'https://github.com.evil.test/a/b',
    'https://user@github.com/a/b',
    'a/b/tree/main',
    '../repo',
    'owner/..',
    'file:///etc/passwd',
    'https://github.com:8443/a/b',
  ])
    assert.throws(() => parseRepository(input));
});

test('snapshot identity includes head and layout and normalizes owner case', () => {
  assert.equal(
    snapshotIdFor({ slug: 'Owner/Repo', head: sha }),
    snapshotIdFor({ slug: 'owner/repo', head: sha }),
  );
  assert.notEqual(
    snapshotIdFor({ slug: 'owner/repo', head: sha }),
    snapshotIdFor({ slug: 'owner/repo', head: 'b'.repeat(40) }),
  );
  assert.notEqual(
    snapshotIdFor({ slug: 'owner/repo', head: sha }),
    snapshotIdFor({ slug: 'owner/repo', head: sha }, 'tree'),
  );
  assert.equal(hash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('stored artifact boundaries reject invented claims, SHAs, and invalid lifetimes', () => {
  assert.equal(parseSnapshot(fixture()).files[0]?.path, 'readme.md');
  const changedClaim = fixture();
  const changedBeat = changedClaim.eras[0]!.beats[0]!;
  if (changedBeat.kind === 'fact') changedBeat.text = 'The code became elegant.';
  assert.throws(() => parseSnapshot(changedClaim), /factual caption/);
  const changedSha = fixture();
  changedSha.eras[0]!.facts[0]!.commits = ['b'.repeat(40)];
  assert.throws(() => parseSnapshot(changedSha), /unknown commit/);
  const lifetime = fixture();
  lifetime.files[0]!.died = 0;
  assert.throws(() => parseSnapshot(lifetime), /lifetime/);
  assert.throws(() => artifactPath('../owner/repo', 'a'.repeat(24), 'b'.repeat(64)));
});

test('CPU fallback renders actual tracks to a PNG', async () => {
  const png = await renderStill(fixture(), 0);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(png.length > 1000);
  await assert.rejects(renderStill(fixture(), 2), /era/);
});

test('waitlist requires explicit opt-in and valid email', () => {
  assert.equal(waitlistSchema.parse({ email: 'person@example.com', consent: true }).consent, true);
  assert.throws(() => waitlistSchema.parse({ email: 'person@example.com' }));
  assert.throws(() => waitlistSchema.parse({ email: 'not-an-email', consent: true }));
});

test('mutation boundaries reject cross-origin, non-JSON, and oversized requests', async () => {
  const variants: HeadersInit[] = [
    { origin: 'https://another.example', 'content-type': 'application/json' },
    { origin: 'https://lore.example', 'content-type': 'text/plain' },
    { origin: 'https://lore.example', 'content-type': 'application/jsonp' },
    {
      origin: 'https://lore.example',
      'content-type': 'application/json',
      'content-length': '5000',
    },
  ];
  for (const headers of variants) {
    await assert.rejects(
      mutationBody(
        new Request('https://lore.example/api/repositories', {
          method: 'POST',
          headers,
          body: '{}',
        }),
      ),
      PublicError,
    );
  }
  assert.equal(errorResponse(new PublicError('Daily limit reached.', 429)).status, 429);
  const response = errorResponse(new Error('secret internal detail'));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: 'Lore is temporarily unavailable. Please try again shortly.',
  });
});

const hasRedis = Boolean(process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL);
test(
  'real Redis admits atomically, deduplicates races, expires leases, and charges each admitted retry',
  { skip: !hasRedis },
  async () => {
    const store = redis();
    const prefix = `lore:test:${randomUUID()}`;
    const keys = [prefix + ':daily', prefix + ':monthly', prefix + ':ip', prefix + ':leases'];
    const ids = ['a', 'b', 'c', 'd'];
    const owned = [
      ...keys,
      prefix + ':snapshots',
      prefix + ':removed',
      ...ids.flatMap((id) => [prefix + ':job:' + id, prefix + ':context:' + id]),
    ];
    async function admission(id: string, now: number, limits = [2, 3, 2, 1]) {
      return store.eval(
        ADMISSION_SCRIPT,
        [
          prefix + ':job:' + id,
          ...keys,
          prefix + ':context:' + id,
          prefix + ':snapshots',
          prefix + ':removed',
        ],
        [
          id,
          JSON.stringify({ state: 'queued' }),
          now,
          now + 100,
          ...limits,
          JSON.stringify({ attemptId: randomUUID(), observedAt: now }),
        ],
      );
    }
    try {
      const raced = await Promise.all([admission('a', 1000), admission('a', 1000)]);
      assert.deepEqual(raced.sort(), ['admitted', 'existing']);
      assert.equal(await store.get(keys[0]!), 1);
      assert.equal(await admission('b', 1000), 'concurrent');
      assert.equal(await admission('b', 1101), 'admitted');
      assert.equal(await store.get(keys[0]!), 2);
      assert.equal(await admission('c', 1202), 'daily');
      assert.equal(await admission('c', 1202, [9, 2, 9, 1]), 'monthly');
      assert.equal(await admission('c', 1202, [9, 9, 2, 1]), 'ip');
      await store.set(prefix + ':job:a', { state: 'failed' });
      assert.equal(await admission('a', 1202), 'daily');
      assert.equal(await admission('a', 1202, [9, 2, 9, 1]), 'monthly');
      assert.equal(await admission('a', 1202, [9, 9, 2, 1]), 'ip');
      assert.equal(await admission('a', 1202, [9, 9, 9, 1]), 'admitted');
      assert.equal(await store.get(keys[0]!), 3);
      assert.equal(await store.get(keys[1]!), 3);
      assert.equal(await store.get(keys[2]!), 3);
    } finally {
      await store.del(...owned);
    }
  },
);

test(
  'real Redis waitlist stores actual consented email with bounded retention',
  { skip: !hasRedis },
  async () => {
    const store = redis();
    const prefix = `lore:test:${randomUUID()}`;
    const keys = [prefix + ':email', prefix + ':ip'];
    const entry = { email: 'person@example.com', consent: true, joinedAt: '2026-11-03' };
    try {
      assert.equal(await store.eval(WAITLIST_SCRIPT, keys, [JSON.stringify(entry)]), 'saved');
      assert.equal(await store.eval(WAITLIST_SCRIPT, keys, [JSON.stringify(entry)]), 'existing');
      assert.deepEqual(await store.get(keys[0]!), entry);
      assert.equal(await store.get(keys[1]!), 2);
      assert.ok((await store.ttl(keys[0]!)) <= 15552000);
      assert.ok((await store.ttl(keys[0]!)) > 15551000);
    } finally {
      await store.del(...keys);
    }
  },
);

test(
  'real Redis publication keeps immutable manifests and fences older work behind newer snapshots',
  { skip: !hasRedis },
  async () => {
    const store = redis();
    const prefix = `lore:test:${randomUUID()}`;
    const keys = [
      prefix + ':manifest:new',
      prefix + ':latest',
      prefix + ':fence',
      prefix + ':removed',
      prefix + ':gallery',
      prefix + ':snapshots',
    ];
    const oldKey = prefix + ':manifest:old';
    try {
      assert.equal(
        await store.eval(PUBLISH_SCRIPT, keys, [
          JSON.stringify({ immutable: 'original' }),
          'new',
          200,
          '1',
          'owner/repo',
        ]),
        'published',
      );
      assert.equal(
        await store.eval(PUBLISH_SCRIPT, keys, [
          JSON.stringify({ immutable: 'changed' }),
          'new',
          200,
          '1',
          'owner/repo',
        ]),
        'published',
      );
      assert.deepEqual(await store.get(keys[0]!), { immutable: 'original' });
      assert.equal(
        await store.eval(
          PUBLISH_SCRIPT,
          [oldKey, ...keys.slice(1)],
          ['{}', 'old', 100, '0', 'owner/repo'],
        ),
        'published',
      );
      assert.equal(await store.get(keys[1]!), 'new');
      assert.deepEqual(await store.get(oldKey), {});
      await store.set(keys[3]!, 'removed');
      assert.equal(
        await store.eval(
          PUBLISH_SCRIPT,
          [oldKey, ...keys.slice(1)],
          ['{}', 'blocked', 300, '0', 'owner/repo'],
        ),
        'removed',
      );
      assert.equal(await store.get(keys[1]!), 'new');
    } finally {
      await store.del(...keys, oldKey);
    }
  },
);

test(
  'real Redis fences expired and replaced attempts and publishes the latest active observation',
  { skip: !hasRedis },
  async () => {
    const store = redis();
    const prefix = `lore:test:${randomUUID()}`;
    const job = prefix + ':job';
    const context = prefix + ':context';
    const leases = prefix + ':leases';
    const daily = prefix + ':daily';
    const monthly = prefix + ':monthly';
    const ip = prefix + ':ip';
    const manifest = prefix + ':manifest';
    const latest = prefix + ':latest';
    const fence = prefix + ':fence';
    const removed = prefix + ':removed';
    const gallery = prefix + ':gallery';
    const snapshots = prefix + ':snapshots';
    const first = randomUUID();
    const second = randomUUID();
    const publicationKeys = [
      manifest,
      latest,
      fence,
      removed,
      gallery,
      snapshots,
      context,
      leases,
      job,
    ];
    const narration = prefix + ':narration';
    const ready = { id: 'snapshot', state: 'ready' };
    const admit = (attemptId: string, now: number, observedAt: number) =>
      store.eval(
        ADMISSION_SCRIPT,
        [job, daily, monthly, ip, leases, context, snapshots, removed],
        [
          'snapshot',
          JSON.stringify({ state: 'queued' }),
          now,
          now + 100,
          10,
          10,
          10,
          1,
          JSON.stringify({ attemptId, observedAt }),
        ],
      );
    const update = (attemptId: string, now: number, state: string) =>
      store.eval(
        UPDATE_JOB_SCRIPT,
        [context, leases, job],
        [attemptId, 'snapshot', now, JSON.stringify({ state }), now + 100],
      );
    const publish = (attemptId: string, now: number) =>
      store.eval(PUBLISH_SCRIPT, publicationKeys, [
        JSON.stringify({ content: attemptId }),
        'snapshot',
        1,
        '0',
        'owner/repo',
        attemptId,
        now,
        JSON.stringify(ready),
      ]);
    try {
      assert.equal(await admit(first, 1000, 10), 'admitted');
      assert.equal(await admit(randomUUID(), 1001, 30), 'existing');
      assert.deepEqual(await store.get(context), { attemptId: first, observedAt: 30 });
      assert.equal(await admit(randomUUID(), 1002, 20), 'existing');
      assert.deepEqual(await store.get(context), { attemptId: first, observedAt: 30 });
      assert.equal(await store.get(daily), 1);
      assert.equal(await update(first, 1100, 'running'), null);
      assert.equal(await publish(first, 1100), 'stale');
      assert.equal(await admit(second, 1101, 40), 'admitted');
      assert.equal(await store.get(daily), 2);
      for (const state of ['running', 'failed', 'ready'])
        assert.equal(await update(first, 1102, state), null);
      assert.equal(await store.zscore(leases, 'snapshot'), 1201);
      assert.deepEqual(await store.get(job), { state: 'queued' });
      assert.equal(
        await store.eval(
          ACTIVE_ATTEMPT_SCRIPT + 'return raw',
          [context, leases, job],
          [first, 'snapshot', 1102],
        ),
        null,
      );
      assert.equal(
        await store.eval(
          SAVE_NARRATION_SCRIPT,
          [context, leases, job, narration],
          [first, 'snapshot', 1102, '{}'],
        ),
        null,
      );
      assert.equal(await store.get(narration), null);
      assert.equal(
        await store.eval(
          SAVE_NARRATION_SCRIPT,
          [context, leases, job, narration],
          [second, 'snapshot', 1102, '{"facts":"current"}'],
        ),
        1,
      );
      assert.deepEqual(await store.get(narration), { facts: 'current' });
      assert.equal(await publish(first, 1102), 'stale');
      assert.equal(await store.get(manifest), null);
      await store.set(latest, 'other-head');
      await store.set(fence, 45);
      assert.equal(await admit(randomUUID(), 1103, 50), 'existing');
      assert.equal(await publish(second, 1104), 'published');
      assert.equal(await store.get(latest), 'snapshot');
      assert.equal(await store.get(fence), 50);
      assert.deepEqual(await store.get(job), ready);
      assert.equal(await store.zscore(leases, 'snapshot'), null);
      assert.equal(await update(second, 1105, 'failed'), null);
      assert.equal(await admit(randomUUID(), 1106, 60), 'ready');
      assert.equal(await store.get(daily), 2);
      assert.equal(await publish(first, 1107), 'stale');
      assert.deepEqual(await store.get(manifest), { content: second });
      assert.deepEqual(await store.smembers(snapshots), ['snapshot']);
      await store.set(removed, 'removed');
      assert.equal(await admit(randomUUID(), 1108, 70), 'removed');
    } finally {
      await store.del(
        job,
        context,
        leases,
        daily,
        monthly,
        ip,
        manifest,
        latest,
        fence,
        removed,
        gallery,
        snapshots,
        narration,
      );
    }
  },
);

test(
  'admission API returns only one owner and rejects stale owners after a retry',
  { skip: !hasRedis },
  async () => {
    const prefix = `lore:test:${randomUUID()}`;
    const previousPrefix = process.env.LORE_REDIS_PREFIX;
    const previousSalt = process.env.LORE_IP_SALT;
    process.env.LORE_REDIS_PREFIX = prefix;
    process.env.LORE_IP_SALT = 'isolated-admission-test';
    const repository = fixture().repository;
    const id = snapshotIdFor(repository);
    const store = redis();
    try {
      const raced = await Promise.all(
        [1, 2].map((observedAt) => admit({ id, repository, ip: 'test', observedAt })),
      );
      assert.deepEqual(raced.map((value) => value.kind).sort(), ['admitted', 'existing']);
      const owner = raced.find((value) => value.kind === 'admitted');
      assert.ok(owner && owner.kind === 'admitted');
      assert.equal((await readAttempt(owner.attempt)).observedAt, 2);
      const failed = {
        id,
        slug: repository.slug,
        state: 'failed' as const,
        message: 'Test failure',
        retryable: true,
        updatedAt: new Date().toISOString(),
      };
      assert.equal(await updateJob(owner.attempt, failed), true);
      const retry = await admit({ id, repository, ip: 'test', observedAt: 3 });
      assert.equal(retry.kind, 'admitted');
      assert.ok(retry.kind === 'admitted');
      assert.notEqual(retry.attempt.attemptId, owner.attempt.attemptId);
      assert.equal(await updateJob(owner.attempt, failed), false);
      await assert.rejects(readAttempt(owner.attempt), /no longer active/);
      assert.equal((await readAttempt(retry.attempt)).observedAt, 3);
      const date = new Date().toISOString();
      assert.equal(await store.get(prefix + ':daily:' + date.slice(0, 10)), 2);
      await store.zadd(prefix + ':leases', { member: id, score: Date.now() - 1 });
      assert.equal(await updateJob(retry.attempt, failed), false);
      await assert.rejects(readAttempt(retry.attempt), /no longer active/);
    } finally {
      let cursor = '0';
      const keys: string[] = [];
      do {
        const result = await store.scan(cursor, { match: prefix + ':*', count: 100 });
        cursor = result[0];
        keys.push(...result[1]);
      } while (cursor !== '0');
      if (keys.length) await store.del(...keys);
      if (previousPrefix === undefined) delete process.env.LORE_REDIS_PREFIX;
      else process.env.LORE_REDIS_PREFIX = previousPrefix;
      if (previousSalt === undefined) delete process.env.LORE_IP_SALT;
      else process.env.LORE_IP_SALT = previousSalt;
    }
  },
);

test('limit lines name when the limit resets', () => {
  assert.equal(
    resets(Date.UTC(2026, 10, 5, 18, 48), 'day'),
    'it resets at 00:00 utc, in 5 h 12 min.',
  );
  assert.equal(
    resets(Date.UTC(2026, 10, 5, 18, 48), 'month'),
    'it resets on 1 december at 00:00 utc.',
  );
  assert.equal(
    resets(Date.UTC(2026, 11, 31, 23, 0), 'month'),
    'it resets on 1 january at 00:00 utc.',
  );
});

test(
  'a workflow start failure fails the job and refunds its admission, so a resubmit starts fresh',
  { skip: !hasRedis },
  async (t) => {
    const prefix = `lore:test:${randomUUID()}`;
    const previousPrefix = process.env.LORE_REDIS_PREFIX;
    const previousSalt = process.env.LORE_IP_SALT;
    process.env.LORE_REDIS_PREFIX = prefix;
    process.env.LORE_IP_SALT = 'isolated-start-test';
    const store = redis();
    const id = snapshotIdFor({ slug: 'owner/repo', head: githubSha });
    const today = new Date().toISOString();
    const counters = [
      `${prefix}:daily:${today.slice(0, 10)}`,
      `${prefix}:monthly:${today.slice(0, 7)}`,
    ];
    let starts = 0;
    const network = globalThis.fetch;
    const github = /^https:\/\/([a-z.]+\.)?github(usercontent)?\.com\//;
    t.mock.method(globalThis, 'fetch', (url: string | URL | Request, init?: RequestInit) =>
      github.test(String(url)) ? transport(url, init) : network(url, init),
    );
    t.mock.module('workflow/api', {
      namedExports: {
        start: async () => {
          starts++;
          if (starts === 1) throw new WorkflowStartError('wrun_test', 'queue');
          return { runId: 'wrun_second' };
        },
      },
    });
    const { submitRepository } = await import('../src/server/catalog');
    try {
      await assert.rejects(submitRepository({ input: 'owner/repo', ip: 'test' }), (error) =>
        WorkflowStartError.is(error),
      );
      const failed = (await store.get(`${prefix}:job:${id}`)) as Record<string, unknown>;
      assert.deepEqual(
        { state: failed.state, retryable: failed.retryable },
        { state: 'failed', retryable: true },
      );
      assert.equal(await store.zscore(`${prefix}:leases`, id), null);
      for (const counter of counters) assert.equal(await store.get(counter), 0);
      assert.deepEqual(await submitRepository({ input: 'owner/repo', ip: 'test' }), {
        kind: 'queued',
        slug: 'owner/repo',
        jobId: id,
      });
      assert.equal(starts, 2);
      assert.equal(((await store.get(`${prefix}:job:${id}`)) as { state: string }).state, 'queued');
      for (const counter of counters) assert.equal(await store.get(counter), 1);
    } finally {
      let cursor = '0';
      const keys: string[] = [];
      do {
        const result = await store.scan(cursor, { match: prefix + ':*', count: 100 });
        cursor = result[0];
        keys.push(...result[1]);
      } while (cursor !== '0');
      if (keys.length) await store.del(...keys);
      if (previousPrefix === undefined) delete process.env.LORE_REDIS_PREFIX;
      else process.env.LORE_REDIS_PREFIX = previousPrefix;
      if (previousSalt === undefined) delete process.env.LORE_IP_SALT;
      else process.env.LORE_IP_SALT = previousSalt;
    }
  },
);

test(
  'a GitHub network failure while following renames shows the unreachable view, and canonical names are cached',
  { skip: !hasRedis },
  async (t) => {
    const prefix = `lore:test:${randomUUID()}`;
    const previousPrefix = process.env.LORE_REDIS_PREFIX;
    process.env.LORE_REDIS_PREFIX = prefix;
    const store = redis();
    await store.set(`${prefix}:visible:owner/repo`, '1', { ex: 300 });
    await store.set(`${prefix}:visible:zeit/repo`, '1', { ex: 300 });
    let heads = 0;
    let broken = true;
    const network = globalThis.fetch;
    const github = /^https:\/\/([a-z.]+\.)?github(usercontent)?\.com\//;
    t.mock.method(globalThis, 'fetch', (url: string | URL | Request, init?: RequestInit) => {
      if (!github.test(String(url))) return network(url, init);
      if (init?.method === 'HEAD') {
        heads++;
        if (broken) return Promise.reject(new TypeError('fetch failed'));
        if (String(url) === 'https://github.com/zeit/repo')
          return Promise.resolve(
            new Response(null, {
              status: 301,
              headers: { location: 'https://github.com/Owner/Repo' },
            }),
          );
      }
      return transport(url, init);
    });
    const { viewRepository } = await import('../src/server/catalog');
    const { assertReachable } = await import('../src/server/storage');
    try {
      assert.deepEqual(await viewRepository('owner/repo'), { kind: 'unreachable' });
      assert.deepEqual(await viewRepository('owner/repo'), { kind: 'unreachable' });
      assert.equal(heads, 1);
      await assert.rejects(assertReachable('owner/repo'), { status: 503 });
      assert.equal(heads, 1);
      assert.ok((await store.ttl(`${prefix}:canonical:owner/repo`)) <= 60);
      broken = false;
      assert.deepEqual(await viewRepository('zeit/repo'), { kind: 'moved', slug: 'owner/repo' });
      assert.deepEqual(await viewRepository('zeit/repo'), { kind: 'moved', slug: 'owner/repo' });
      assert.deepEqual(await viewRepository('zeit/repo', '1505db081ad794513a7011f5'), {
        kind: 'moved',
        slug: 'owner/repo',
      });
      assert.equal(heads, 2);
      assert.ok((await store.ttl(`${prefix}:canonical:zeit/repo`)) > 60);
    } finally {
      const keys = await store.keys(`${prefix}:*`);
      if (keys.length) await store.del(...keys);
      if (previousPrefix === undefined) delete process.env.LORE_REDIS_PREFIX;
      else process.env.LORE_REDIS_PREFIX = previousPrefix;
    }
  },
);
