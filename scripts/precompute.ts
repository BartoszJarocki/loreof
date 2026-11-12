import { parseSnapshot } from '../src/lib/snapshot';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { z } from 'zod';
import { GALLERY } from '../src/lib/gallery';
import { repositorySchema, repositorySlugSchema, PIPELINE_VERSION } from '../src/lib/schema';
import { snapshotIdFor, DEFAULT_LAYOUT } from '../src/lib/identity';
import { partVersion } from '../src/lib/snapshot-pack';
import { readManifest, readSnapshotPart, publishSnapshot } from '../src/server/storage';
import { key, redis } from '../src/server/config';
import { renderStill } from '../src/server/still';
import { gatewayModel, narrateEra } from '../src/server/narration';
import { observeRepository } from '../src/server/observation';
import { precomputePolicy, refreshDefaultBranch } from './lib/precompute';
import { applyReview, reviewedSnapshot, reviewPath, writeReview } from './lib/review';
import { recordingSchema, replayModel } from './lib/replay';

const run = promisify(execFile);
const { values } = parseArgs({
  options: {
    repo: { type: 'string', multiple: true },
    head: { type: 'string' },
    layout: { type: 'string', default: DEFAULT_LAYOUT },
    'clone-only': { type: 'boolean', default: false },
    publish: { type: 'boolean', default: false },
    narrate: { type: 'boolean', default: false },
    review: { type: 'boolean', default: false },
    replay: { type: 'string' },
    convert: { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '2' },
  },
});
const layout = z.enum(['tree', 'force', 'spectral']).parse(values.layout);
const concurrency = z.coerce.number().int().min(1).max(4).parse(values.concurrency);
const repos = (values.repo ?? GALLERY.map((item) => item.slug)).map((slug) =>
  repositorySlugSchema.parse(slug),
);
const metadataSchema = z.object({
  full_name: z.string(),
  private: z.literal(false),
  description: z.string().nullable(),
  default_branch: z.string(),
  stargazers_count: z.number(),
});
const policy = precomputePolicy({ head: values.head, publish: values.publish });
const records: unknown[] = [];

async function processRepository(slug: string) {
  const name = slug.toLowerCase().replace('/', '-');
  const directory = resolve('.cache/repos', `${name}.git`);
  const destination = resolve('.cache/gallery', `${name}-${layout}-${PIPELINE_VERSION}.json`);
  await mkdir('.cache/repos', { recursive: true });
  await mkdir('.cache/gallery', { recursive: true });
  const observedAt = values.publish ? await observeRepository() : undefined;
  const cached = await readFile(destination, 'utf8')
    .then((text) => parseSnapshot(JSON.parse(text)))
    .catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    });
  const metadata =
    policy.kind === 'refresh'
      ? metadataSchema.parse(JSON.parse((await run('gh', ['api', `repos/${slug}`])).stdout))
      : {
          full_name: slug,
          private: false,
          description: cached?.repository.description ?? '',
          default_branch: cached?.repository.branch ?? 'detached',
          stargazers_count: cached?.repository.stars ?? 0,
        };
  if (!(await stat(directory).catch(() => null))) {
    if (policy.kind === 'pinned')
      throw new Error('Pinned offline analysis requires an existing local clone.');
    process.stdout.write(`${slug}: cloning\n`);
    await run(
      'git',
      [
        'clone',
        '--bare',
        '--filter=blob:none',
        '--single-branch',
        '--branch',
        metadata.default_branch,
        '--',
        `https://github.com/${slug}.git`,
        directory,
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );
  }
  const branch = metadata.default_branch;
  const head =
    policy.kind === 'refresh' ? await refreshDefaultBranch(directory, branch) : policy.head;
  if (values['clone-only']) return { slug, cloned: true, head };
  const [owner, repoName] = metadata.full_name.split('/');
  const repository = repositorySchema.parse({
    owner,
    name: repoName,
    slug: metadata.full_name,
    description: metadata.description ?? '',
    branch,
    stars: metadata.stargazers_count,
    head,
  });
  const id = snapshotIdFor(repository, layout);
  let snapshotData = cached;
  let elapsedSeconds: number | null = null;
  if (snapshotData?.id !== id) {
    process.stdout.write(`${slug}: analyzing ${layout}\n`);
    const start = performance.now();
    const result = await run(
      process.execPath,
      [
        '--max-old-space-size=8192',
        '--import',
        'tsx',
        'scripts/analyze.ts',
        '--repo',
        repository.slug,
        '--directory',
        directory,
        '--head',
        head,
        '--out',
        destination,
        '--layout',
        layout,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    elapsedSeconds = (performance.now() - start) / 1000;
    await writeFile(`${destination}.log`, result.stderr);
    snapshotData = parseSnapshot(JSON.parse(await readFile(destination, 'utf8')));
  }
  if (
    !snapshotData ||
    snapshotData.id !== id ||
    snapshotData.repository.head !== head ||
    snapshotData.repository.slug.toLowerCase() !== repository.slug.toLowerCase()
  )
    throw new Error('Analysis identity mismatch');
  let snapshot = { ...snapshotData, repository };
  let narrationSeconds: number | null = null;
  if (values.narrate) {
    const start = performance.now();
    const model = values.replay
      ? replayModel(recordingSchema.parse(JSON.parse(await readFile(values.replay, 'utf8'))))
      : gatewayModel();
    const eras = await Promise.all(
      snapshot.eras.map((era) =>
        era.narration === 'facts' ? narrateEra(era, snapshot.repository, model) : era,
      ),
    );
    narrationSeconds = (performance.now() - start) / 1000;
    snapshot = { ...snapshot, eras };
  }
  const review = reviewPath(repository.slug);
  const reviewed = await readFile(review, 'utf8').catch(() => null);
  if (reviewed !== null && values.review && reviewedSnapshot(reviewed) !== snapshot.id)
    await rename(review, review.replace(/\.md$/, '.previous.md'));
  else if (reviewed !== null) snapshot = applyReview(snapshot, reviewed, review);
  snapshot = parseSnapshot(snapshot);
  if (values.review) {
    await mkdir('.cache/reviews', { recursive: true });
    await writeFile(review, writeReview(snapshot));
  }
  await writeFile(destination, JSON.stringify(snapshot));
  await run(process.execPath, ['--import', 'tsx', 'scripts/validate-snapshot.ts', destination]);
  await writeFile(
    destination.replace('.json', '.png'),
    await renderStill(snapshot, snapshot.eras.length - 1),
  );
  const manifest = values.publish
    ? await publishSnapshot(snapshot, {
        gallery: layout === DEFAULT_LAYOUT,
        latest: layout === DEFAULT_LAYOUT,
        observedAt,
      })
    : null;
  const previous = await readFile(`${destination}.result.json`, 'utf8')
    .then((text) =>
      z.object({ id: z.string(), elapsedSeconds: z.number().nullable() }).parse(JSON.parse(text)),
    )
    .catch(() => null);
  const record = {
    slug: repository.slug,
    head,
    id,
    layout,
    pipeline: PIPELINE_VERSION,
    elapsedSeconds: elapsedSeconds ?? (previous?.id === id ? previous.elapsedSeconds : null),
    reusedAnalysis: elapsedSeconds === null,
    jsonBytes: Buffer.byteLength(JSON.stringify(snapshot)),
    gzipBytes: gzipSync(JSON.stringify(snapshot)).length,
    commits: snapshot.commits.length,
    tracks: snapshot.files.length,
    coverage: snapshot.coverage,
    eras: snapshot.eras.length,
    narrated: snapshot.eras.filter((era) => era.narration !== 'facts').length,
    narrationSeconds,
    published: Boolean(manifest),
    artifact: destination,
    measuredAt: new Date().toISOString(),
  };
  await writeFile(`${destination}.result.json`, JSON.stringify(record, null, 2));
  process.stdout.write(
    `${slug}: ready, ${record.commits} commits, ${record.tracks} files, ${record.gzipBytes} gzip bytes\n`,
  );
  return record;
}

if (values.convert) {
  const converted: { slug: string; id?: string; seconds?: number; error?: string }[] = [];
  for (const repo of repos) {
    const slug = repo.toLowerCase();
    try {
      const store = redis();
      const ids = new Set(await store.smembers<string[]>(key(`snapshots:${slug}`)));
      const latest = await readManifest(slug);
      if (latest) ids.add(latest.id);
      if (!ids.size) throw new Error('No published snapshot.');
      let ready = 0;
      for (const id of ids) {
        const manifest = id === latest?.id ? latest : await readManifest(slug, id);
        if (!manifest) continue;
        const start = performance.now();
        await readSnapshotPart(slug, id, 'map', partVersion(manifest));
        ready++;
        converted.push({
          slug,
          id,
          seconds: +((performance.now() - start) / 1000).toFixed(2),
        });
        process.stdout.write(`${repo}: ${id} parts ready\n`);
      }
      if (!ready) throw new Error('No readable snapshot.');
    } catch (error) {
      converted.push({ slug, error: error instanceof Error ? error.message : String(error) });
      process.stderr.write(`${repo}: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
  await mkdir('.cache/gallery', { recursive: true });
  await writeFile(`.cache/gallery/convert-${Date.now()}.json`, JSON.stringify(converted, null, 2));
  process.exit(process.exitCode ?? 0);
}

let cursor = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (cursor < repos.length) {
      const slug = repos[cursor++];
      try {
        records.push(await processRepository(slug));
      } catch (error) {
        records.push({ slug, error: error instanceof Error ? error.message : String(error) });
        process.stderr.write(
          `${slug}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      }
    }
  }),
);
await mkdir('.cache/gallery', { recursive: true });
await writeFile(`.cache/gallery/run-${Date.now()}.json`, JSON.stringify(records, null, 2));
