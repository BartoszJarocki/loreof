import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { redis } from '../src/server/config';

const hasRedis = Boolean(process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL);

async function signUp(ip: string, email: string): Promise<Response> {
  const { POST } = await import('../src/app/api/waitlist/route');
  return POST(
    new Request('https://lore.example/api/waitlist', {
      method: 'POST',
      headers: {
        origin: 'https://lore.example',
        'content-type': 'application/json',
        'x-forwarded-for': ip,
      },
      body: JSON.stringify({ email, consent: true }),
    }),
  );
}

function address(): string {
  return `${randomUUID()}@example.com`;
}

test(
  'waitlist limits count every signup and answer listed and unlisted addresses alike',
  { skip: !hasRedis },
  async (t) => {
    t.mock.method(console, 'warn', () => {});
    const prefix = `lore:test:${randomUUID()}`;
    const previousPrefix = process.env.LORE_REDIS_PREFIX;
    const previousSalt = process.env.LORE_IP_SALT;
    process.env.LORE_REDIS_PREFIX = prefix;
    process.env.LORE_IP_SALT = 'isolated-waitlist-test';
    const store = redis();
    try {
      const limitedIp = `2001:db8:${randomUUID().slice(0, 4)}::1`;
      const listed = address();
      const statuses: number[] = [];
      statuses.push((await signUp(limitedIp, listed)).status);
      statuses.push((await signUp(limitedIp, address())).status);
      statuses.push((await signUp(limitedIp, address())).status);
      statuses.push((await signUp(limitedIp, address())).status);
      assert.deepEqual(statuses, [201, 201, 201, 429]);

      const otherIp = `2001:db8:${randomUUID().slice(0, 4)}::1`;
      const listedAgain = await signUp(otherIp, listed);
      const fresh = await signUp(otherIp, address());
      assert.equal(listedAgain.status, 201);
      assert.equal(fresh.status, 201);
      assert.deepEqual(
        new Uint8Array(await listedAgain.arrayBuffer()),
        new Uint8Array(await fresh.arrayBuffer()),
      );

      const listedAtLimit = await signUp(limitedIp, listed);
      const freshAtLimit = await signUp(limitedIp, address());
      assert.equal(listedAtLimit.status, 429);
      assert.equal(freshAtLimit.status, 429);
      assert.deepEqual(
        new Uint8Array(await listedAtLimit.arrayBuffer()),
        new Uint8Array(await freshAtLimit.arrayBuffer()),
      );
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
