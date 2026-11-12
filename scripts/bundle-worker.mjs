import { build } from 'esbuild';

await build({
  entryPoints: { analysis: 'src/analysis/worker.ts', runner: 'src/workflows/runner-entry.ts' },
  outdir: '.generated',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  logLevel: 'info',
});
