import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('the integration gate requires credentials and rejects skipped or failing tests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lore-integration-gate-'));
  const fixture = join(directory, 'gate.test.mjs');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KV_REST_API_URL: 'http://127.0.0.1:1',
    KV_REST_API_TOKEN: 'fixture',
    BLOB_READ_WRITE_TOKEN: 'fixture',
  };
  delete env.NODE_TEST_CONTEXT;
  const run = (environment = env) =>
    spawnSync(process.execPath, ['scripts/test-integration.mjs', fixture], {
      env: environment,
      encoding: 'utf8',
      timeout: 30_000,
    });
  try {
    await writeFile(fixture, "throw new Error('The test must not start without credentials.');");
    const missing = run({ ...env, BLOB_READ_WRITE_TOKEN: '' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Integration tests require BLOB_READ_WRITE_TOKEN/);
    assert.doesNotMatch(missing.stderr + missing.stdout, /The test must not start/);

    for (const [body, status] of [
      ["test('passes', () => assert.equal(2 + 2, 4));", 0],
      ["test('skips', { skip: true }, () => {});", 1],
      ["test('pending', { todo: true }, () => {});", 1],
      ["test('fails', () => assert.equal(2 + 2, 5));", 1],
    ] as const) {
      await writeFile(
        fixture,
        `import test from 'node:test';\nimport assert from 'node:assert/strict';\n${body}\n`,
      );
      const result = run();
      assert.equal(result.status, status, result.stderr + result.stdout);
      assert.match(result.stdout, /tests 1/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
