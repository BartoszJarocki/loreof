import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { errorResponse } from '../src/server/http';

test('internal snapshot schema errors remain server failures', async () => {
  const result = z.object({ artifact: z.string() }).safeParse({ artifact: 3 });
  assert.equal(result.success, false);
  if (result.success) throw new Error('Expected invalid storage data');
  const response = errorResponse(result.error);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: 'Lore is temporarily unavailable. Please try again shortly.',
  });
});

test('internal JSON decode errors remain server failures', async () => {
  let failure: unknown;
  try {
    JSON.parse('{broken stored artifact');
  } catch (error) {
    failure = error;
  }
  const response = errorResponse(failure);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: 'Lore is temporarily unavailable. Please try again shortly.',
  });
});

test('request schema errors produce a public 400 while schema code failures stay internal', async () => {
  const { parseRequest } = await import('../src/server/http');
  assert.deepEqual(
    parseRequest(z.object({ repository: z.string().min(1) }), { repository: 'owner/repo' }),
    { repository: 'owner/repo' },
  );
  let failure: unknown;
  try {
    parseRequest(z.object({ repository: z.string().min(1) }), { repository: 5 });
  } catch (error) {
    failure = error;
  }
  const invalid = errorResponse(failure);
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: 'The request contains invalid data.' });
  const schema = z.string().transform(() => {
    throw new SyntaxError('broken schema code');
  });
  assert.throws(() => parseRequest(schema, 'value'), /broken schema code/);
});

test('mutation JSON errors are public but body stream failures stay internal', async (t) => {
  const { mutationBody } = await import('../src/server/http');
  t.mock.method(console, 'warn', () => {});
  const headers = { origin: 'https://lore.example', 'content-type': 'application/json' };
  assert.deepEqual(
    await mutationBody(
      new Request('https://lore.example/api/repositories', {
        method: 'POST',
        headers,
        body: '{"repository":"owner/repo"}',
      }),
    ),
    { repository: 'owner/repo' },
  );
  let invalid: unknown;
  try {
    await mutationBody(
      new Request('https://lore.example/api/repositories', { method: 'POST', headers, body: '{' }),
    );
  } catch (error) {
    invalid = error;
  }
  assert.equal(errorResponse(invalid).status, 400);
  const source = new Error('upstream body stream failed');
  const body = new ReadableStream({
    start(controller) {
      controller.error(source);
    },
  });
  const init = { method: 'POST', headers, body, duplex: 'half' };
  await assert.rejects(
    mutationBody(new Request('https://lore.example/api/repositories', init)),
    (error) => error === source,
  );
});

test('server failures log their operation and original error without exposing them in responses', async (t) => {
  const logger = t.mock.method(console, 'error', () => {});
  const failure = new Error('private storage diagnostic');
  const response = errorResponse(failure, { operation: 'snapshots.read' });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: 'Lore is temporarily unavailable. Please try again shortly.',
  });
  assert.deepEqual(logger.mock.calls[0].arguments, [
    'request_failed',
    { operation: 'snapshots.read', error: failure },
  ]);
});

test('API routes reject malformed path, query, and body input before calling services', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { GET: job } = await import('../src/app/api/jobs/[id]/route');
  const { GET: og } = await import('../src/app/api/og/route');
  const { POST: repository } = await import('../src/app/api/repositories/route');
  const { POST: waitlist } = await import('../src/app/api/waitlist/route');
  const context = { params: Promise.resolve({ id: 'invalid' }) };
  const responses = [
    await job(new Request('https://lore.example/api/jobs/invalid'), context),
    await og(new Request('https://lore.example/api/og?repo=owner/repo&s=invalid')),
    await repository(
      new Request('https://lore.example/api/repositories', {
        method: 'POST',
        headers: { origin: 'https://lore.example', 'content-type': 'application/json' },
        body: '{"repository":8}',
      }),
    ),
    await waitlist(
      new Request('https://lore.example/api/waitlist', {
        method: 'POST',
        headers: { origin: 'https://lore.example', 'content-type': 'application/json' },
        body: '{"email":"bad","consent":true}',
      }),
    ),
  ];
  assert.deepEqual(
    responses.map((response) => response.status),
    [400, 400, 400, 400],
  );
  assert.deepEqual(await responses[0].json(), { error: 'The request contains invalid data.' });
});

test('the share image redirects away from query parameters it does not read', async () => {
  const { GET } = await import('../src/app/api/og/route');
  const response = await GET(new Request('https://lore.example/api/og?repo=a/b&junk=1'));
  assert.equal(response.status, 308);
  const location = new URL(response.headers.get('location') ?? '');
  assert.equal(location.pathname, '/api/og');
  assert.equal(location.search, '?repo=a/b');
});

test('the part route gzips only the paths that next.config labels gzip', async () => {
  const { GET } = await import('../src/app/api/snapshots/[id]/[part]/route');
  const id = 'a'.repeat(24);
  const unknown = await GET(
    new Request(`https://lore.example/api/snapshots/${id}/bogus?repo=owner%2Frepo&v=abc`),
    { params: Promise.resolve({ id, part: 'bogus' }) },
  );
  assert.equal(unknown.status, 400);
  assert.equal(unknown.headers.get('content-encoding'), null);
  const plain = new Uint8Array(await unknown.arrayBuffer());
  assert.notDeepEqual([...plain.subarray(0, 2)], [0x1f, 0x8b]);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(plain)), {
    error: 'The request contains invalid data.',
  });

  const known = await GET(
    new Request('https://lore.example/api/snapshots/invalid/map?repo=owner%2Frepo&v=abc'),
    { params: Promise.resolve({ id: 'invalid', part: 'map' }) },
  );
  assert.equal(known.status, 400);
  const gzipped = new Uint8Array(await known.arrayBuffer());
  assert.deepEqual([...gzipped.subarray(0, 2)], [0x1f, 0x8b]);
  assert.deepEqual(JSON.parse(gunzipSync(gzipped).toString()), {
    error: 'The request contains invalid data.',
  });
});

test('case-variant part names get the same gzipped body as lowercase ones', async () => {
  const { GET } = await import('../src/app/api/snapshots/[id]/[part]/route');
  for (const part of ['map', 'MAP', 'touches', 'Touches', 'paths', 'PATHS']) {
    const response = await GET(
      new Request(`https://lore.example/api/snapshots/invalid/${part}?repo=owner%2Frepo&v=abc`),
      { params: Promise.resolve({ id: 'invalid', part }) },
    );
    assert.equal(response.status, 400);
    const gzipped = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual([...gzipped.subarray(0, 2)], [0x1f, 0x8b], `${part} is gzipped`);
    assert.deepEqual(JSON.parse(gunzipSync(gzipped).toString()), {
      error: 'The request contains invalid data.',
    });
  }
});

const hasRedis = Boolean(process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL);
test(
  'API route classifies malformed persisted jobs as server failures',
  { skip: !hasRedis },
  async (t) => {
    const { randomUUID } = await import('node:crypto');
    const { key, redis } = await import('../src/server/config');
    const { GET } = await import('../src/app/api/jobs/[id]/route');
    const previous = process.env.LORE_REDIS_PREFIX;
    process.env.LORE_REDIS_PREFIX = `lore:test:${randomUUID()}`;
    const id = 'a'.repeat(24);
    const jobKey = key(`job:${id}`);
    const logger = t.mock.method(console, 'error', () => {});
    try {
      await redis().set(jobKey, { id, state: 'corrupted' });
      const response = await GET(new Request(`https://lore.example/api/jobs/${id}`), {
        params: Promise.resolve({ id }),
      });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: 'Lore is temporarily unavailable. Please try again shortly.',
      });
      const [event, details] = logger.mock.calls[0].arguments;
      assert.equal(event, 'request_failed');
      assert.equal(details.operation, 'jobs.read');
      assert.ok(details.error instanceof z.ZodError);
    } finally {
      await redis().del(jobKey);
      if (previous === undefined) delete process.env.LORE_REDIS_PREFIX;
      else process.env.LORE_REDIS_PREFIX = previous;
    }
  },
);
