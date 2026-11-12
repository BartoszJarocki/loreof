import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { repositorySlugSchema, shaSchema } from '../src/lib/schema';
import { snapshotIdFor, DEFAULT_LAYOUT } from '../src/lib/identity';
import { analyzeRepository } from '../src/analysis';
import { gitBuffer } from '../src/analysis/git';
import {
  gatewayModel,
  narrateEra,
  type NarrationModel,
  type NarrationTrace,
} from '../src/server/narration';
import { parseSnapshot } from '../src/lib/snapshot';

async function main() {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string' },
      directory: { type: 'string' },
      out: { type: 'string' },
      head: { type: 'string' },
      layout: { type: 'string', default: DEFAULT_LAYOUT },
      narrate: { type: 'boolean', default: false },
      record: { type: 'string' },
    },
  });
  const slug = repositorySlugSchema.parse(values.repo);
  const name = slug.toLowerCase().replace('/', '-');
  const directory = resolve(values.directory ?? `.cache/repos/${name}.git`);
  const layout = z.enum(['tree', 'force', 'spectral']).parse(values.layout);
  const out = resolve(values.out ?? `.cache/analyze/${name}-${layout}.json`);
  const revision = values.head ? shaSchema.parse(values.head) : 'HEAD';
  const head = shaSchema.parse(
    (await gitBuffer(directory, ['rev-parse', '--verify', `${revision}^{commit}`]))
      .toString()
      .trim(),
  );
  const branch = (
    await gitBuffer(directory, ['symbolic-ref', '--short', 'HEAD']).catch(() =>
      Buffer.from('detached'),
    )
  )
    .toString()
    .trim();
  const [owner, repoName] = slug.split('/');
  const repository = { owner, name: repoName, slug, head, branch, description: '', stars: 0 };
  const snapshotId = snapshotIdFor(repository, layout);
  let snapshot = await analyzeRepository({
    repository,
    directory,
    snapshotId,
    layout,
    onProgress: (progress) => process.stderr.write(`${JSON.stringify(progress)}\n`),
  });
  let narrationSeconds: number | null = null;
  let recordings:
    | {
        era: number;
        from: string;
        to: string;
        attempts: unknown[];
        denied: boolean;
        narration: string;
        title: string;
        headline: string;
        beats: {
          kind: string;
          ref: string;
          sha?: string;
          date?: string;
          subject?: string;
          text?: string;
        }[];
        selected: string[];
        selectionErrors: string[];
      }[]
    | undefined;
  if (values.narrate) {
    const start = performance.now();
    const base = gatewayModel();
    const month = (time: number) => new Date(time * 1000).toISOString().slice(0, 7);
    const results = await Promise.all(
      snapshot.eras.map(async (era) => {
        if (era.narration !== 'facts') return { era, attempts: [], denied: false, trace: null };
        const attempts: unknown[] = [];
        let denied = false;
        const model: NarrationModel | null = base
          ? async (request) => {
              const result = await base(request);
              if (result === 'denied') denied = true;
              else attempts.push(result.output);
              return result;
            }
          : null;
        const trace: NarrationTrace = {
          attempts: 0,
          selected: [],
          headline: '',
          selectionErrors: [],
        };
        const narrated = await narrateEra(era, snapshot.repository, model, trace);
        return { era: narrated, attempts, denied, trace };
      }),
    );
    const parsed = parseSnapshot({ ...snapshot, eras: results.map((item) => item.era) });
    results.forEach((item, index) => {
      if (item.era.narration === 'model' && parsed.eras[index].narration !== 'model')
        throw new Error(`Chapter ${item.era.id + 1} was narrated but did not parse as model`);
    });
    snapshot = parsed;
    narrationSeconds = (performance.now() - start) / 1000;
    recordings = results.map((item) => ({
      era: item.era.id,
      from: month(item.era.startTime),
      to: month(item.era.endTime),
      attempts: item.attempts,
      denied: item.denied,
      narration: item.era.narration,
      title: item.era.title,
      headline: item.era.headline ?? '',
      beats: item.era.beats,
      selected: item.trace?.selected ?? [],
      selectionErrors: item.trace?.selectionErrors ?? [],
    }));
  }
  if (values.record && recordings)
    await writeFile(values.record, `${JSON.stringify(recordings, null, 2)}\n`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(snapshot));
  const result = {
    out,
    id: snapshot.id,
    coverage: snapshot.coverage,
    ...(values.narrate
      ? {
          narrationSeconds,
          chapters: snapshot.eras.map((era) => ({
            title: era.title,
            headline: era.headline ?? '',
            beats: era.beats,
            narration: era.narration,
          })),
        }
      : {}),
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
