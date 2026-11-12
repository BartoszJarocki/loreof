import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const names = [
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'LORE_REDIS_PREFIX',
];

test('the example environment leaves optional values unset and accepts the Redis alias', () => {
  const env = { ...process.env };
  for (const name of names) delete env[name];
  env.UPSTASH_REDIS_REST_URL = 'http://127.0.0.1:8104';
  env.UPSTASH_REDIS_REST_TOKEN = 'lore-ci';
  const source = `
const { key, redis } = await import('./src/server/config.ts');
try {
  redis();
  console.log(JSON.stringify({ prefix: key('gallery'), alias: true }));
} catch (error) {
  console.log(JSON.stringify({ prefix: key('gallery'), alias: false, message: error.message }));
  process.exitCode = 1;
}
`;
  const result = spawnSync(
    process.execPath,
    ['--env-file=.env.example', '--import', 'tsx', '--input-type=module', '-e', source],
    { cwd: root, env, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.trim().split('\n').at(-1) ?? '';
  assert.deepEqual(JSON.parse(line), { prefix: 'lore:v1:gallery', alias: true });
});
