import assert from 'node:assert/strict';
import test from 'node:test';
import { hashIp, PublicError, redis } from '../src/server/config';
import { denial } from '../src/server/github';

const storageNames = [
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
];

test('a deployment without storage reports a configuration error, not a GitHub outage', async (t) => {
  const saved = new Map(storageNames.map((name) => [name, process.env[name]]));
  for (const name of storageNames) delete process.env[name];
  const logged = t.mock.method(console, 'error', () => {});
  try {
    const denied = () => {
      try {
        redis();
        throw new Error('storage should not be configured');
      } catch (error) {
        return denial(error);
      }
    };
    assert.equal(denied(), 'not-configured');
    assert.equal(logged.mock.callCount(), 1);
    const [label, details] = logged.mock.calls[0].arguments as [string, { missing: string[] }];
    assert.equal(label, 'lore_not_configured');
    assert.deepEqual(details.missing, [
      'KV_REST_API_URL or UPSTASH_REDIS_REST_URL',
      'KV_REST_API_TOKEN or UPSTASH_REDIS_REST_TOKEN',
    ]);
    assert.equal(denied(), 'not-configured');
    assert.equal(logged.mock.callCount(), 1, 'the missing variables are logged once');
  } finally {
    for (const [name, value] of saved)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
});

test('the not-configured page links back to the collection only from a repository page', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { NotConfigured } = await import('../src/components/NotConfigured');
  const home = renderToStaticMarkup(createElement(NotConfigured, { home: true }));
  assert.doesNotMatch(home, /href="\/"/);
  const repository = renderToStaticMarkup(createElement(NotConfigured));
  assert.match(repository, /href="\/"/);
});

test('a missing IP salt is a configuration error that names the variable', (t) => {
  const saved = process.env.LORE_IP_SALT;
  delete process.env.LORE_IP_SALT;
  const logged = t.mock.method(console, 'error', () => {});
  try {
    assert.throws(
      () => hashIp('127.0.0.1'),
      (error: unknown) => error instanceof PublicError && error.status === 503,
    );
    assert.deepEqual(logged.mock.calls[0].arguments, [
      'lore_not_configured',
      { missing: ['LORE_IP_SALT'] },
    ]);
  } finally {
    if (saved === undefined) delete process.env.LORE_IP_SALT;
    else process.env.LORE_IP_SALT = saved;
  }
});
