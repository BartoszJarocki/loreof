import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AI_BUDGET_SCRIPT, narrationReservation } from '../src/server/ai-budget';
import { redis } from '../src/server/config';

test('narration reserves a conservative UTF-8 input and output allowance', () => {
  assert.equal(narrationReservation('abc', 600), 70990);
  assert.equal(narrationReservation('☀', 600), 70990);
});

test(
  'real Redis refuses simultaneous AI reservations above the monthly allowance',
  { skip: !process.env.KV_REST_API_URL && !process.env.UPSTASH_REDIS_REST_URL },
  async () => {
    const store = redis();
    const budgetKey = `lore-test:${randomUUID()}:ai-budget`;
    try {
      const accepted = await Promise.all(
        Array.from({ length: 20 }, () => store.eval(AI_BUDGET_SCRIPT, [budgetKey], [40, 200])),
      );
      assert.equal(accepted.filter((value) => value === 1).length, 5);
      assert.equal(await store.get(budgetKey), 200);
      assert((await store.ttl(budgetKey)) > 0);
    } finally {
      await store.del(budgetKey);
    }
  },
);

test(
  'settlement retains the highest regional cache-write price and the cost of unknown usage',
  { skip: !process.env.KV_REST_API_URL && !process.env.UPSTASH_REDIS_REST_URL },
  async (context) => {
    const { reserveNarration } = await import('../src/server/ai-budget');
    const previousPrefix = process.env.LORE_REDIS_PREFIX;
    const prefix = `lore-test:${randomUUID()}`;
    process.env.LORE_REDIS_PREFIX = prefix;
    const budgetKey = `${prefix}:ai-reserved:${new Date().toISOString().slice(0, 7)}`;
    const store = redis();
    const realFetch = globalThis.fetch;
    context.mock.method(globalThis, 'fetch', async (...[input, init]: Parameters<typeof fetch>) => {
      if (String(input) === 'https://ai-gateway.vercel.sh/v1/models')
        return Response.json({
          data: [
            {
              id: 'test/cache-prices',
              pricing: {
                input: 0.000002,
                output: 0.00001,
                input_cache_write: 0.000003,
                regional: {
                  eu: { input: 0.0000022, output: 0.000011, input_cache_write: 0.000004 },
                },
              },
            },
          ],
        });
      return realFetch(input, init);
    });
    try {
      const settle = await reserveNarration('test/cache-prices', 'abc', 900);
      assert.ok(settle);
      assert.equal(await settle({ inputTokens: 1000, outputTokens: 100 }), 5100);
      assert.equal(await store.get(budgetKey), 5100);
      const unknown = await reserveNarration('test/cache-prices', 'abc', 900);
      assert.ok(unknown);
      const before = await store.get(budgetKey);
      assert.equal(await unknown({}), 85990);
      assert.equal(await store.get(budgetKey), before);
    } finally {
      await store.del(budgetKey);
      if (previousPrefix === undefined) delete process.env.LORE_REDIS_PREFIX;
      else process.env.LORE_REDIS_PREFIX = previousPrefix;
    }
  },
);
