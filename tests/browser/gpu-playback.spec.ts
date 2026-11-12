import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, test } from '@playwright/test';

test('the production GPU touch lookup handles exact boundaries and backward scrubbing', async () => {
  const bundle = await build({
    entryPoints: ['tests/browser/gpu-fixture.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
  });
  const source = bundle.outputFiles[0]?.text;
  assert.ok(source);
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<main><canvas></canvas></main>');
    const result: unknown = await page.evaluate(async (code) => {
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      try {
        const fixture: unknown = await import(url);
        if (
          !fixture ||
          typeof fixture !== 'object' ||
          !('probeGpu' in fixture) ||
          typeof fixture.probeGpu !== 'function'
        )
          throw new Error('The GPU fixture did not load.');
        const canvas = document.querySelector('canvas');
        if (!canvas) throw new Error('The GPU fixture has no canvas.');
        return fixture.probeGpu(canvas);
      } finally {
        URL.revokeObjectURL(url);
      }
    }, source);
    assert.deepEqual(result, [
      [-1, -1, 0, -1],
      [-1, -1, 0, 1],
      [2, -1, 0, 1],
      [5, -1, 0, 3],
      [5, -1, 0, 3],
      [9, -1, 0, 7],
      [9, -1, 0, 12],
      [5, -1, 0, 3],
      [-1, -1, 0, -1],
    ]);
  } finally {
    await browser.close();
  }
});
