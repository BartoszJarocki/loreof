import { analysisFailure, MAX_SNAPSHOT_BYTES } from '../workflows/analysis-protocol';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { repositorySchema, snapshotIdSchema } from '../lib/schema';
import { analyzeRepository } from './index';
import { UnsupportedRepositoryError } from './errors';

const inputSchema = z.object({
  repository: repositorySchema,
  snapshotId: snapshotIdSchema,
  limits: z
    .object({
      maxCommits: z.number(),
      maxTracks: z.number(),
      maxFiles: z.number(),
      maxPairs: z.number(),
      maxEdges: z.number(),
      maxPairsPerCommit: z.number(),
      layoutIterations: z.number(),
    })
    .partial()
    .optional(),
});

function serializeSnapshot(snapshot: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(snapshot);
  } catch (error) {
    if (error instanceof RangeError)
      throw new UnsupportedRepositoryError('Repository analysis output exceeds the supported size');
    throw error;
  }
  if (Buffer.byteLength(serialized) > MAX_SNAPSHOT_BYTES)
    throw new UnsupportedRepositoryError('Repository analysis output exceeds the supported size');
  return serialized;
}

async function main() {
  const root = process.cwd();
  const input = inputSchema.parse(JSON.parse(await readFile(join(root, 'input.json'), 'utf8')));
  const snapshot = await analyzeRepository({
    ...input,
    directory: join(root, 'repo.git'),
    onProgress: (progress) => process.stdout.write(`${JSON.stringify(progress)}\n`),
  });
  await writeFile(join(root, 'snapshot.json'), serializeSnapshot(snapshot));
}
main().catch((error: unknown) => {
  process.stdout.write(`${JSON.stringify(analysisFailure(error))}\n`);
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
