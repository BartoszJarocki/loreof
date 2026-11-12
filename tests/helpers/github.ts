import assert from 'node:assert/strict';

export const sha = '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d';
export const packet = (line: string) =>
  `${(Buffer.byteLength(line) + 4).toString(16).padStart(4, '0')}${line}`;
const advertisement = `${packet('# service=git-upload-pack\n')}0000${packet('version 2\n')}${packet('ls-refs=unborn\n')}0000`;
export const refs = `${packet(`${sha} HEAD symref-target:refs/heads/main\n`)}0000`;

export function transport(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const target = String(url);
  if (target.startsWith('https://api.github.com/'))
    return Promise.resolve(new Response('Rate limit exceeded', { status: 403 }));
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(target) && init?.method === 'HEAD')
    return Promise.resolve(new Response(null, { status: 200 }));
  if (target === 'https://github.com/owner/repo.git/info/refs?service=git-upload-pack')
    return Promise.resolve(
      new Response(advertisement, {
        headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
      }),
    );
  if (target === 'https://github.com/owner/repo.git/git-upload-pack') {
    assert.equal(init?.method, 'POST');
    assert.equal(
      init?.body,
      `${packet('command=ls-refs\n')}0001${packet('symrefs\n')}${packet('ref-prefix HEAD\n')}0000`,
    );
    return Promise.resolve(
      new Response(refs, { headers: { 'content-type': 'application/x-git-upload-pack-result' } }),
    );
  }
  if (target === 'https://raw.githubusercontent.com/owner/repo/HEAD/.lore-ignore')
    return Promise.resolve(new Response(null, { status: 404 }));
  throw new Error(`Unexpected request ${target}`);
}
