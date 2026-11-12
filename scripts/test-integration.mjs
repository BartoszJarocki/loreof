import { readdir } from 'node:fs/promises';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';

const required = ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'BLOB_READ_WRITE_TOKEN'];
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length) {
  console.error(`Integration tests require ${missing.join(', ')}.`);
  process.exit(1);
}

process.env.LORE_LIVE_GITHUB = '1';
const files = process.argv.slice(2);
if (!files.length) {
  for (const name of (await readdir('tests')).sort()) {
    if (name.endsWith('.test.ts') && name !== 'narration-eval.test.ts') files.push(`tests/${name}`);
  }
}
if (!files.length) throw new Error('No integration tests were found.');

let complete = false;
const results = run({
  files,
  execArgv: ['--experimental-test-module-mocks', '--import', 'tsx'],
});
results.on('test:summary', (summary) => {
  if (summary.file !== undefined) return;
  complete = true;
  const { tests, skipped, todo, cancelled } = summary.counts;
  if (!summary.success || tests === 0 || skipped || todo || cancelled) {
    console.error('Integration tests must pass with no skipped, pending, or cancelled tests.');
    process.exitCode = 1;
  }
});
results.on('end', () => {
  if (!complete) {
    console.error('The integration test runner did not report completion.');
    process.exitCode = 1;
  }
});
results.compose(spec).pipe(process.stdout);
