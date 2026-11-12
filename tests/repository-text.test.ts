import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractHistory } from '../src/analysis/git';
import { boundText } from '../src/lib/text';

const CONTROL = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

function git(directory: string, args: string[], input?: string, env?: Record<string, string>) {
  const child = spawn('git', ['-C', directory, ...args], {
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const chunks: Buffer[] = [];
  let error = '';
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => {
    error += chunk.toString();
  });
  const completed = new Promise<string>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(chunks).toString().trim()) : reject(new Error(error)),
    );
  });
  child.stdin.end(input);
  return completed;
}

test('repository text is stripped of control and bidi characters and bounded', () => {
  assert.equal(boundText('plain', 10), 'plain');
  assert.equal(boundText('a\u202Eb\u0000c\u009Fd\u2066e', 10), 'abcde');
  assert.equal(boundText('0123456789', 10), '0123456789');
  assert.equal(boundText('more than ten', 10), 'more than …');
  assert.equal(boundText('😀😀😀😀', 3), '😀😀😀…');
  assert.equal([...boundText('😀😀😀😀', 3)].length, 4);
  assert.equal(boundText('a\u200Fb\u202Ac\u200Ed\u202Be\u202Df\u061Cg', 20), 'abcdefg');
});

test('a hostile commit subject, author name and tag name leave git extraction bounded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lore-text-'));
  const repo = join(root, 'repo.git');
  const subject = `add the thing ${'a'.repeat(49_983)}\u202E\u0007\u009B`;
  const author = `${'n'.repeat(480)}\u202E[bot]`;
  const tag = `v1.0.0-${'r'.repeat(240)}`;
  try {
    await git(root, ['init', '--bare', repo]);
    const tree = await git(repo, ['mktree', '-z'], '');
    const head = await git(repo, ['commit-tree', tree], `${subject}\n`, {
      GIT_AUTHOR_NAME: author,
      GIT_AUTHOR_EMAIL: 'author@example.test',
      GIT_COMMITTER_NAME: 'Fixture Person',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
      GIT_AUTHOR_DATE: '2022-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2022-01-01T00:00:00Z',
    });
    await git(repo, ['update-ref', 'refs/heads/main', head]);
    await git(repo, ['tag', 'v2.0.0', head]);
    await git(repo, ['tag', tag, head]);
    const history = await extractHistory({ directory: repo, head, maxCommits: 10, maxTracks: 10 });
    const stored = history.commits[0].subject;
    assert.ok([...stored].length <= 301, `subject has ${[...stored].length} code points`);
    assert.ok(stored.endsWith('…'));
    assert.equal(CONTROL.test(stored), false);
    assert.equal(stored.includes('\u202E'), false);
    assert.equal(stored.startsWith('add the thing aaaa'), true);
    // The name is bounded before bot detection, so a suffix past the cap no longer counts.
    assert.deepEqual(history.authors, [{ id: 0, kind: 'anonymous', label: 'Contributor 1' }]);
    assert.deepEqual(
      history.tags.map((value) => value.name),
      ['v2.0.0'],
    );
    assert.ok(tag.length > 200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
