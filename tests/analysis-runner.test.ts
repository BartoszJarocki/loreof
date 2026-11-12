import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fixture } from './helpers/storage';
import { analysisStatusSchema } from '../src/workflows/analysis-protocol';
import { parseSnapshot } from '../src/lib/snapshot';

const exec = promisify(execFile);
const generated = resolve('.generated');

async function sandbox(run: (directory: string, environment: NodeJS.ProcessEnv) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'lore-runner-'));
  const repository = join(root, 'source');
  const directory = join(root, 'sandbox');
  await mkdir(repository);
  await mkdir(directory);
  try {
    await exec('git', ['init', '-b', 'main'], { cwd: repository });
    await exec('git', ['config', 'user.name', 'Test Author'], { cwd: repository });
    await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: repository });
    await writeFile(join(repository, 'readme.md'), 'history');
    await exec('git', ['add', '.'], { cwd: repository });
    await exec('git', ['commit', '-m', 'Initial history'], { cwd: repository });
    const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim();
    const snapshot = fixture();
    await writeFile(
      join(directory, 'input.json'),
      JSON.stringify({ repository: { ...snapshot.repository, head }, snapshotId: snapshot.id }),
    );
    await copyFile(join(generated, 'runner.mjs'), join(directory, 'runner.mjs'));
    await copyFile(join(generated, 'analysis.mjs'), join(directory, 'analysis.mjs'));
    await run(directory, {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.file://${repository}.insteadOf`,
      GIT_CONFIG_VALUE_0: 'https://github.com/owner/repo.git',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function status(directory: string) {
  return analysisStatusSchema.parse(
    JSON.parse(await readFile(join(directory, 'status.json'), 'utf8')),
  );
}

test('bundled runner executes real Git and analysis once across duplicate launches', async () => {
  await sandbox(async (cwd, env) => {
    await Promise.all([
      exec(process.execPath, ['runner.mjs'], { cwd, env }),
      exec(process.execPath, ['runner.mjs'], { cwd, env }),
    ]);
    assert.deepEqual(await status(cwd), { state: 'done' });
    const snapshot = parseSnapshot(JSON.parse(await readFile(join(cwd, 'snapshot.json'), 'utf8')));
    assert.equal(snapshot.commits[0]?.subject, 'Initial history');
    assert.equal(snapshot.files[0]?.path, 'readme.md');
    await exec(process.execPath, ['runner.mjs'], { cwd, env });
    assert.deepEqual(await status(cwd), { state: 'done' });
  });
});

test('bundled worker reports supported limits explicitly and Git failures remain infrastructure failures', async () => {
  await sandbox(async (cwd, env) => {
    const input = JSON.parse(await readFile(join(cwd, 'input.json'), 'utf8'));
    const source = join(cwd, '../source');
    await writeFile(join(source, 'second.md'), 'another commit');
    await exec('git', ['add', '.'], { cwd: source });
    await exec('git', ['commit', '-m', 'Second commit'], { cwd: source });
    input.repository.head = (
      await exec('git', ['rev-parse', 'HEAD'], { cwd: source })
    ).stdout.trim();
    input.limits = { maxCommits: 1 };
    await writeFile(join(cwd, 'input.json'), JSON.stringify(input));
    await exec(process.execPath, ['runner.mjs'], { cwd, env });
    const result = await status(cwd);
    assert.equal(result.state, 'failed');
    if (result.state !== 'failed') throw new Error('Expected failed runner');
    assert.equal(result.failure.kind, 'unsupported');
    assert.match(result.failure.message, /history exceeds 1 commits/);
  });
  await sandbox(async (cwd, env) => {
    await exec(process.execPath, ['runner.mjs'], {
      cwd,
      env: { ...env, GIT_CONFIG_KEY_0: 'url.file:///missing-lore-test-repository.insteadOf' },
    });
    const result = await status(cwd);
    assert.equal(result.state, 'failed');
    if (result.state !== 'failed') throw new Error('Expected failed runner');
    assert.equal(result.failure.kind, 'infrastructure');
    assert.match(result.failure.message, /git exited 128/);
  });
});

test('interrupted runner locks never reuse partial clones and a fresh sandbox can complete', async () => {
  await sandbox(async (cwd, env) => {
    await writeFile(join(cwd, 'runner.lock'), '');
    await writeFile(
      join(cwd, 'status.json'),
      JSON.stringify({ state: 'running', stage: 'clone', detail: 'Interrupted clone' }),
    );
    await exec(process.execPath, ['runner.mjs'], { cwd, env });
    assert.deepEqual(await status(cwd), {
      state: 'running',
      stage: 'clone',
      detail: 'Interrupted clone',
    });
    await assert.rejects(readFile(join(cwd, 'snapshot.json')), { code: 'ENOENT' });
  });
  await sandbox(async (cwd, env) => {
    await exec(process.execPath, ['runner.mjs'], { cwd, env });
    assert.deepEqual(await status(cwd), { state: 'done' });
  });
});

test('malformed worker protocol remains an infrastructure error instead of becoming a completed run', async () => {
  await sandbox(async (cwd, env) => {
    await writeFile(join(cwd, 'analysis.mjs'), "process.stdout.write('not a protocol record\\n');");
    await exec(process.execPath, ['runner.mjs'], { cwd, env });
    const result = await status(cwd);
    assert.equal(result.state, 'failed');
    if (result.state !== 'failed') throw new Error('Expected failed runner');
    assert.equal(result.failure.kind, 'infrastructure');
    assert.match(result.failure.message, /JSON/);
  });
});
