import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicError } from '../src/server/config';
import { parseRepository } from '../src/lib/repository';
import {
  assertPublic,
  canonicalName,
  denial,
  parseGitHead,
  resolveRepository,
} from '../src/server/github';
import { packet, refs, sha, transport } from './helpers/github';

test('the repository form accepts every way a reader writes a GitHub repository', () => {
  for (const [input, slug] of [
    ['facebook/react', 'facebook/react'],
    ['github.com/facebook/react', 'facebook/react'],
    ['www.github.com/facebook/react', 'facebook/react'],
    ['http://github.com/facebook/react', 'facebook/react'],
    ['https://github.com/facebook/react', 'facebook/react'],
    ['https://www.github.com/Facebook/React/', 'facebook/react'],
    ['https://github.com/facebook/react/tree/main/packages', 'facebook/react'],
    ['https://github.com/n8n-io/n8n?tab=readme-ov-file', 'n8n-io/n8n'],
    ['https://github.com/n8n-io/n8n#readme', 'n8n-io/n8n'],
    [
      'https://github.com/facebook/react/tree/main/packages?tab=readme-ov-file#readme',
      'facebook/react',
    ],
    ['github.com/facebook/react?tab=readme-ov-file', 'facebook/react'],
    ['github.com/facebook/react.git', 'facebook/react'],
    ['https://github.com/vercel/next.js.git', 'vercel/next.js'],
    ['  GitHub.com/facebook/react  ', 'facebook/react'],
  ])
    assert.equal(parseRepository(input), slug, input);
});

test('the repository form rejects input that does not name one GitHub repository', () => {
  for (const [input, message] of [
    ['', 'Enter a public GitHub repository URL or owner/name.'],
    ['not a repo', 'Enter a public GitHub repository URL or owner/name.'],
    ['github.com/facebook', 'Enter a public GitHub repository URL or owner/name.'],
    ['facebook/react/tree/main', 'Enter a public GitHub repository URL or owner/name.'],
    ['gitlab.com/facebook/react', 'Enter a public GitHub repository URL or owner/name.'],
    ['ftp://github.com/facebook/react', 'Use a github.com repository URL.'],
    ['https://gist.github.com/facebook/react', 'Use a github.com repository URL.'],
  ])
    assert.throws(() => parseRepository(input), { status: 400, message }, input);
});

test('public repository resolution works when the GitHub REST quota is exhausted', async (t) => {
  t.mock.method(globalThis, 'fetch', transport);
  assert.deepEqual(await resolveRepository('owner/repo'), {
    owner: 'owner',
    name: 'repo',
    slug: 'owner/repo',
    head: sha,
    branch: 'main',
    description: '',
    stars: 0,
  });
});

test('Git HEAD parser reads packet byte lengths and the symbolic default branch', () => {
  const branch = 'feature/zażółć';
  const input = `${packet(`${sha} refs/heads/other\n`)}${packet(`${sha} HEAD symref-target:refs/heads/${branch}\n`)}0000`;
  assert.deepEqual(parseGitHead(Buffer.from(input)), { head: sha, branch });
});

test('Git HEAD parser rejects truncated, malformed, oversized and ambiguous responses', () => {
  for (const input of [
    '',
    '000',
    'zzzz',
    '0003',
    '0004',
    'ffffpayload',
    refs.slice(0, -1),
    `${packet(`${sha} HEAD symref-target:refs/heads/main\n`)}`,
    `${packet(`${sha} HEAD symref-target:refs/heads/main\n`)}00000000`,
    `${packet(`${sha} HEAD symref-target:refs/heads/main\n`)}${refs}`,
    `${packet(`${'a'.repeat(41)} HEAD symref-target:refs/heads/main\n`)}0000`,
    `${packet(`${sha} HEAD symref-target:refs/tags/main\n`)}0000`,
    `${packet(`${sha} HEAD symref-target:refs/heads/../main\n`)}0000`,
    `${packet(`${sha} HEAD symref-target:refs/heads/topic.lock\n`)}0000`,
    `${packet(`${sha} HEAD symref-target:refs/heads/main\0extra\n`)}0000`,
    'a'.repeat(65537),
  ])
    assert.throws(() => parseGitHead(Buffer.from(input)), Error, input.slice(0, 100));
});

test('Git HEAD parser reports empty repositories without inventing a commit', () => {
  assert.throws(() => parseGitHead(Buffer.from('0000')), { status: 422 });
});

test('REST metadata failure cannot block Git HEAD resolution', async (t) => {
  for (const fail of ['network', 'invalid-json', 'invalid-schema', 'rate-limit']) {
    const mocked = t.mock.method(
      globalThis,
      'fetch',
      (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).startsWith('https://api.github.com/')) {
          if (fail === 'network') return Promise.reject(new Error('Network unavailable'));
          if (fail === 'invalid-json') return Promise.resolve(new Response('{'));
          if (fail === 'invalid-schema')
            return Promise.resolve(Response.json({ full_name: 'owner/repo' }));
        }
        return transport(url, init);
      },
    );
    assert.equal((await resolveRepository('owner/repo')).head, sha);
    mocked.mock.restore();
  }
});

test('available REST metadata enriches the Git result without choosing its branch or HEAD', async (t) => {
  t.mock.method(globalThis, 'fetch', (url: string | URL | Request, init?: RequestInit) =>
    String(url).startsWith('https://api.github.com/')
      ? Promise.resolve(
          Response.json({
            full_name: 'Owner/Repo',
            private: false,
            description: 'Real description',
            stargazers_count: 12,
          }),
        )
      : transport(url, init),
  );
  const repository = await resolveRepository('owner/repo');
  assert.equal(repository.description, 'Real description');
  assert.equal(repository.stars, 12);
  assert.equal(repository.branch, 'main');
  assert.equal(repository.head, sha);
});

test('GitHub absence maps to missing and a rate-limit refusal maps to rate-limited', async (t) => {
  for (const [status, headers, expected] of [
    [401, {}, 'missing'],
    [404, {}, 'missing'],
    [403, {}, 'missing'],
    [403, { 'x-ratelimit-remaining': '0' }, 'rate-limited'],
    [403, { 'retry-after': '60' }, 'rate-limited'],
    [429, {}, 'rate-limited'],
    [500, {}, 'unreachable'],
  ] as const) {
    const mocked = t.mock.method(
      globalThis,
      'fetch',
      (url: string | URL | Request, init?: RequestInit) =>
        String(url).includes('/info/refs?')
          ? Promise.resolve(new Response(null, { status, headers }))
          : transport(url, init),
    );
    const error = await resolveRepository('owner/repo').catch((caught: unknown) => caught);
    assert.equal(denial(error), expected);
    assert.equal(
      denial(await assertPublic('owner/repo').catch((caught: unknown) => caught)),
      expected,
    );
    if (expected === 'rate-limited')
      assert.deepEqual(
        { status: (error as PublicError).status, message: (error as PublicError).message },
        { status: 503, message: 'github is rate limiting lore, try again in a few minutes' },
      );
    mocked.mock.restore();
  }
});

test('opted-out repositories and unavailable opt-out checks stay denied', async (t) => {
  for (const [status, headers, expected] of [
    [200, {}, 'missing'],
    [403, {}, 'missing'],
    [403, { 'x-ratelimit-remaining': '0' }, 'rate-limited'],
    [429, {}, 'rate-limited'],
    [500, {}, 'unreachable'],
  ] as const) {
    const mocked = t.mock.method(
      globalThis,
      'fetch',
      (url: string | URL | Request, init?: RequestInit) =>
        String(url).includes('/.lore-ignore')
          ? Promise.resolve(new Response(null, { status, headers }))
          : transport(url, init),
    );
    for (const check of [resolveRepository, assertPublic])
      assert.equal(denial(await check('owner/repo').catch((caught: unknown) => caught)), expected);
    mocked.mock.restore();
  }
});

test('renamed repositories use the canonical GitHub slug for HEAD and opt-out checks', async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', (url: string | URL | Request, init?: RequestInit) => {
    requests.push(String(url));
    if (String(url) === 'https://github.com/old/repo.git/info/refs?service=git-upload-pack')
      return Promise.resolve(
        new Response(null, {
          status: 301,
          headers: {
            location: 'https://github.com/Owner/Repo.git/info/refs?service=git-upload-pack',
          },
        }),
      );
    return transport(url, init);
  });
  assert.equal((await resolveRepository('old/repo')).slug, 'owner/repo');
  assert.ok(requests.includes('https://raw.githubusercontent.com/owner/repo/HEAD/.lore-ignore'));
});

test('a repository GitHub redirects to a new name resolves under that name', async (t) => {
  t.mock.method(globalThis, 'fetch', (url: string | URL | Request, init?: RequestInit) =>
    String(url) === 'https://github.com/zeit/repo'
      ? Promise.resolve(
          new Response(null, {
            status: 301,
            headers: { location: 'https://github.com/Owner/Repo' },
          }),
        )
      : transport(url, init),
  );
  assert.equal(await canonicalName('zeit/repo'), 'owner/repo');
  assert.equal(await canonicalName('owner/repo'), 'owner/repo');
  assert.equal((await resolveRepository('zeit/repo')).slug, 'owner/repo');
});

test('a rename redirect off github.com or to a non-repository path is rejected', async (t) => {
  for (const location of [
    'https://evil.test/owner/repo',
    'https://github.com/owner/repo/tree/main',
  ]) {
    const mocked = t.mock.method(globalThis, 'fetch', () =>
      Promise.resolve(new Response(null, { status: 301, headers: { location } })),
    );
    await assert.rejects(canonicalName('zeit/repo'), /redirect/);
    mocked.mock.restore();
  }
});

test('REST metadata sends GITHUB_TOKEN when it is set and nothing when it is not', async (t) => {
  const seen: (string | null)[] = [];
  t.mock.method(globalThis, 'fetch', (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith('https://api.github.com/'))
      seen.push(new Headers(init?.headers).get('authorization'));
    return transport(url, init);
  });
  const previous = process.env.GITHUB_TOKEN;
  try {
    process.env.GITHUB_TOKEN = 'token-for-test';
    await resolveRepository('owner/repo');
    delete process.env.GITHUB_TOKEN;
    await resolveRepository('owner/repo');
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous;
  }
  assert.deepEqual(seen, ['Bearer token-for-test', null]);
});

test('Git redirects cannot become an arbitrary URL fetch or change the protocol endpoint', async (t) => {
  for (const location of [
    'https://evil.test/owner/repo.git/info/refs?service=git-upload-pack',
    'http://github.com/owner/repo.git/info/refs?service=git-upload-pack',
    'https://user@github.com/owner/repo.git/info/refs?service=git-upload-pack',
    'https://github.com:8443/owner/repo.git/info/refs?service=git-upload-pack',
    'https://github.com/owner/repo.git/info/refs?service=git-receive-pack',
    'https://github.com/owner/repo.git/info/refs?service=git-upload-pack#fragment',
    'https://github.com/owner/repo/tree/main',
    'https://github.com/owner/../repo.git/info/refs?service=git-upload-pack',
  ]) {
    const requests: string[] = [];
    const mocked = t.mock.method(
      globalThis,
      'fetch',
      (url: string | URL | Request, init?: RequestInit) => {
        requests.push(String(url));
        return String(url).includes('/info/refs?')
          ? Promise.resolve(new Response(null, { status: 301, headers: { location } }))
          : transport(url, init);
      },
    );
    await assert.rejects(resolveRepository('owner/repo'), PublicError);
    assert.equal(requests.length, 2);
    mocked.mock.restore();
  }
});

test('repository resolution rejects traversal before making any network request', async (t) => {
  const mocked = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected request');
  });
  await assert.rejects(resolveRepository('owner/..'));
  assert.equal(mocked.mock.callCount(), 0);
});

test('oversized streamed Git responses are rejected and cancelled', async (t) => {
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', (url: string | URL | Request, init?: RequestInit) =>
    String(url).includes('/info/refs?')
      ? Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(65537));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } },
          ),
        )
      : transport(url, init),
  );
  await assert.rejects(resolveRepository('owner/repo'), { status: 503 });
  assert.equal(cancelled, true);
});

test(
  'real GitHub resolves public HEAD with REST deliberately unavailable',
  { skip: !process.env.LORE_LIVE_GITHUB },
  async (t) => {
    const realFetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', (url: string | URL | Request, init?: RequestInit) =>
      String(url).startsWith('https://api.github.com/')
        ? Promise.resolve(new Response(null, { status: 403 }))
        : realFetch(url, init),
    );
    const repository = await resolveRepository('octocat/Hello-World');
    assert.equal(repository.slug, 'octocat/hello-world');
    assert.equal(repository.branch, 'master');
    assert.match(repository.head, /^[a-f0-9]{40}$/);
    assert.equal(repository.description, '');
    assert.equal(repository.stars, 0);
    await assertPublic(repository.slug);
    await assert.rejects(resolveRepository('octocat/loreof-unavailable-4e3b5223d7'), {
      status: 404,
    });
  },
);

test('private or disabled REST metadata still denies admission', async (t) => {
  for (const denied of [{ private: true }, { private: false, disabled: true }]) {
    const mocked = t.mock.method(
      globalThis,
      'fetch',
      (url: string | URL | Request, init?: RequestInit) =>
        String(url).startsWith('https://api.github.com/')
          ? Promise.resolve(
              Response.json({
                full_name: 'owner/repo',
                description: '',
                stargazers_count: 0,
                ...denied,
              }),
            )
          : transport(url, init),
    );
    await assert.rejects(resolveRepository('owner/repo'), { status: 403 });
    mocked.mock.restore();
  }
});

test('failed Git or opt-out transport cannot admit a repository', async (t) => {
  for (const target of ['/info/refs?', '/git-upload-pack', '/.lore-ignore']) {
    const mocked = t.mock.method(
      globalThis,
      'fetch',
      (url: string | URL | Request, init?: RequestInit) =>
        String(url).includes(target)
          ? Promise.reject(new Error('Connection failed'))
          : transport(url, init),
    );
    await assert.rejects(resolveRepository('owner/repo'), { status: 503 });
    mocked.mock.restore();
  }
});
