import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicError } from '../src/lib/public-error';

test('mutation requests need an explicit human verdict from the bot check', async (t) => {
  let reply: { isBot?: boolean } = {};
  t.mock.module('botid/server', {
    namedExports: {
      checkBotId: async () => reply,
    },
  });
  const { mutationBody } = await import('../src/server/http');
  const request = () =>
    new Request('https://lore.example/api/waitlist', {
      method: 'POST',
      headers: { origin: 'https://lore.example', 'content-type': 'application/json' },
      body: '{"email":"person@example.com"}',
    });

  for (const verdict of [{}, { isBot: undefined }, { isBot: true }]) {
    reply = verdict;
    await assert.rejects(
      mutationBody(request()),
      (error) => error instanceof PublicError && error.status === 403,
    );
  }

  reply = { isBot: false };
  assert.deepEqual(await mutationBody(request()), { email: 'person@example.com' });
});
