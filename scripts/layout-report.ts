import { parseSnapshot } from '../src/lib/snapshot';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PIPELINE_VERSION } from '../src/lib/schema';
import { z } from 'zod';

const run = promisify(execFile);
const samples = [
  'bartoszjarocki-jarocki.me',
  'facebook-react',
  'vercel-next.js',
  'pnpm-pnpm',
  'torvalds-linux',
];
const layouts = ['tree', 'force', 'spectral'];
const resultSchema = z.object({
  elapsedSeconds: z.number().nullable(),
  jsonBytes: z.number(),
  gzipBytes: z.number(),
  head: z.string(),
  slug: z.string(),
  commits: z.number(),
  tracks: z.number(),
});
const rows: string[] = [];
const panels: string[] = [];
await mkdir('.cache/layouts', { recursive: true });
await mkdir('.cache/spike', { recursive: true });
for (const sample of samples) {
  let slug = '';
  for (const layout of layouts) {
    const base = `.cache/gallery/${sample}-${layout}-${PIPELINE_VERSION}`;
    const record = resultSchema.parse(
      JSON.parse(await readFile(`${base}.json.result.json`, 'utf8')),
    );
    slug = record.slug;
    let seconds = record.elapsedSeconds;
    if (seconds === null) {
      const snapshot = parseSnapshot(JSON.parse(await readFile(`${base}.json`, 'utf8')));
      const destination = `.cache/spike/${sample}-${layout}.json`;
      const began = performance.now();
      const result = await run(
        process.execPath,
        [
          '--max-old-space-size=8192',
          '--import',
          'tsx',
          'scripts/analyze.ts',
          '--repo',
          snapshot.repository.slug,
          '--directory',
          `.cache/repos/${sample}.git`,
          '--head',
          record.head,
          '--layout',
          layout,
          '--out',
          destination,
        ],
        { maxBuffer: 16 * 1024 * 1024 },
      );
      seconds = (performance.now() - began) / 1000;
      await writeFile(`${destination}.log`, result.stderr);
      await run(process.execPath, ['--import', 'tsx', 'scripts/validate-snapshot.ts', destination]);
    }
    await copyFile(`${base}.png`, `.cache/layouts/${sample}-${layout}.png`);
    rows.push(
      `| ${slug} | ${layout} | ${record.commits} | ${record.tracks} | ${seconds.toFixed(1)} | ${(record.jsonBytes / 1048576).toFixed(2)} | ${(record.gzipBytes / 1048576).toFixed(2)} |`,
    );
  }
  panels.push(
    `## ${slug}\n\n| Tree | Co-change force | Spectral and UMAP |\n| --- | --- | --- |\n| ![Tree layout](layouts/${sample}-tree.png) | ![Force layout](layouts/${sample}-force.png) | ![Spectral layout](layouts/${sample}-spectral.png) |`,
  );
}
await writeFile(
  '.cache/layout-comparison.md',
  `# Layout comparison\n\nGenerated ${new Date().toISOString()} with ${PIPELINE_VERSION} on Node ${process.version}. These are measured local runs on the same pinned clones, with warm filesystem caches and other work running concurrently. They include history extraction, graph construction, layout, eras, and JSON serialization. They exclude cloning, model calls, uploads, and browser rendering. They are implementation checks, not repeatable hardware benchmarks or hosted latency promises. Sizes are actual stored gallery or comparison artifacts.\n\nThe CPU still renderer projects the last chapter and samples at most 2,400 visible points for a readable image. Full browser maps retain every selected track. Spectral layouts use at most 2,048 landmarks with neighbor interpolation. Spectral layout is the provisional default after this comparison. Bartosz still needs to judge recognizable structure. The original human judgment gate remains open.\n\n| Repository | Layout | Integration commits | Displayed files | Analysis seconds | JSON MiB | Gzip MiB |\n| --- | --- | ---: | ---: | ---: | ---: | ---: |\n${rows.join('\n')}\n\n${panels.join('\n\n')}\n`,
);
process.stdout.write('Wrote .cache/layout-comparison.md and fifteen comparison stills.\n');
