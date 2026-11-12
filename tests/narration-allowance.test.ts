import assert from 'node:assert/strict';
import test from 'node:test';
import { reserveNarration } from '../src/server/ai-budget';
import { narrateEra, type NarrationModel } from '../src/server/narration';
import { snapshotFixture } from './fixtures/snapshot';

test('an invalid monthly allowance logs once and keeps the chapter factual', async (context) => {
  process.env.LORE_AI_MONTHLY_USD = '50';
  const errors: unknown[][] = [];
  const warnings: unknown[][] = [];
  context.mock.method(console, 'error', (...args: unknown[]) => errors.push(args));
  context.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args));
  context.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      data: [{ id: 'test/model', pricing: { input: 0.000001, output: 0.00001 } }],
    }),
  );
  const model: NarrationModel = async ({ system, prompt }) => {
    const settle = await reserveNarration('test/model', system + prompt, 600);
    return settle ? { output: { commits: ['c1'], headline: 'c1' }, cost: 0 } : 'denied';
  };
  const snapshot = snapshotFixture();
  const era = {
    ...snapshot.eras[0],
    sheet: [
      {
        id: 'c1',
        kind: 'commit' as const,
        text: 'Initial commit',
        time: 1,
        commits: [snapshot.commits[0].sha],
      },
    ],
  };
  const result = await narrateEra(era, snapshot.repository, model);
  assert.equal(result.narration, 'facts');
  const again = await narrateEra(era, snapshot.repository, model);
  assert.equal(again.narration, 'facts');
  const third = await narrateEra(era, snapshot.repository, model);
  assert.equal(third.narration, 'facts');
  assert.equal(errors.length, 1);
  assert.match(JSON.stringify(errors[0]), /LORE_AI_MONTHLY_USD/);
  assert.equal(warnings.length, 3);
  for (const warning of warnings) assert.match(JSON.stringify(warning), /budget/);
});
