import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { key, redis } from '../src/server/config';
import { observeRepository } from '../src/server/observation';

const hasRedis = Boolean(process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL);
test(
  'real Redis orders observations before remote resolution even when the clock moves backward',
  { skip: !hasRedis },
  async (t) => {
    const previous = process.env.LORE_REDIS_PREFIX;
    process.env.LORE_REDIS_PREFIX = `lore:test:${randomUUID()}`;
    const observationKey = key('observations');
    const clock = t.mock.method(Date, 'now', () => 1000);
    try {
      assert.equal(await observeRepository(), 1000);
      clock.mock.mockImplementation(() => 900);
      assert.equal(await observeRepository(), 1001);
      assert.deepEqual(
        (await Promise.all([observeRepository(), observeRepository()])).sort(),
        [1002, 1003],
      );
      assert.equal(await redis().get(observationKey), 1003);
    } finally {
      await redis().del(observationKey);
      if (previous === undefined) delete process.env.LORE_REDIS_PREFIX;
      else process.env.LORE_REDIS_PREFIX = previous;
    }
  },
);
