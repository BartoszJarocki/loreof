import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { History } from '../src/analysis/git';

function git(directory: string, args: string[], input?: string) {
  const child = spawn('git', ['-C', directory, ...args], {
    env: {
      ...process.env,
      GIT_NO_LAZY_FETCH: '1',
      GIT_AUTHOR_NAME: 'Fixture Person',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture Person',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
      GIT_AUTHOR_DATE: '2022-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2022-01-01T00:00:00Z',
    },
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

test('extraction ignores caller GIT_* configuration and repository overrides', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lore-git-env-'));
  const hostile = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'i18n.logOutputEncoding',
    GIT_CONFIG_VALUE_0: 'ISO-8859-1',
    GIT_CONFIG_PARAMETERS: "'i18n.logOutputEncoding'='ISO-8859-1'",
    GIT_DIR: '',
  };
  const saved = Object.fromEntries(Object.keys(hostile).map((name) => [name, process.env[name]]));
  try {
    const repo = join(root, 'repo.git');
    const other = join(root, 'other.git');
    await git(root, ['init', '--bare', repo]);
    const tree = await git(repo, ['mktree', '-z'], '');
    const head = await git(repo, ['commit-tree', tree], 'café subject\n');
    await git(repo, ['update-ref', 'refs/heads/main', head]);
    await git(repo, ['tag', 'right-tag', head]);
    await git(root, ['clone', '--bare', repo, other]);
    await git(other, ['tag', 'wrong-tag', head]);
    hostile.GIT_DIR = other;
    for (const [name, value] of Object.entries(hostile)) process.env[name] = value;
    const { extractHistory } = await import('../src/analysis/git');
    const history: History = await extractHistory({
      directory: repo,
      head,
      maxCommits: 10,
      maxTracks: 10,
    });
    assert.deepEqual(
      history.commits.map((commit) => commit.subject),
      ['café subject'],
    );
    assert.deepEqual(
      history.tags.map((tag) => tag.name),
      ['right-tag'],
    );
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
