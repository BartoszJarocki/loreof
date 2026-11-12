import { spawnSync } from 'node:child_process';

if (!process.env.LORE_PROD_SNAPSHOTS?.trim()) {
  console.error(
    'Production snapshot tests require LORE_PROD_SNAPSHOTS set to a directory of production snapshot copies.',
  );
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [
    '--experimental-test-module-mocks',
    '--import',
    'tsx',
    '--test',
    'tests/prod-snapshots.check.ts',
  ],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
