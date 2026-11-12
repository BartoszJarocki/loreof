import { parseSnapshot } from '@/lib/snapshot';
import { snapshotIdFor } from '@/lib/identity';
import { FatalError, sleep } from 'workflow';
import { z } from 'zod';
import { eraSchema, jobSchema, type Job, type Repository } from '@/lib/schema';
import { readAttempt, SAVE_NARRATION_SCRIPT, updateJob, type JobAttempt } from '@/server/admission';
import { key, redis } from '@/server/config';
import { narrateEra } from '@/server/narration';
import {
  assertVisible,
  deleteCheckpoint,
  loadCheckpoint,
  publishSnapshot,
  saveCheckpoint,
} from '@/server/storage';
import {
  analysisFailure,
  analysisStatusSchema,
  ANALYSIS_DEADLINE_MS,
  MAX_SNAPSHOT_BYTES,
  MAX_STATUS_BYTES,
  POLL_SECONDS,
  SANDBOX_TIMEOUT_MS,
  type AnalysisFailure,
} from './analysis-protocol';

async function status(
  attempt: JobAttempt,
  stage: Extract<Job, { state: 'running' }>['stage'],
  detail: string,
): Promise<void> {
  const { repository } = await readAttempt(attempt);
  const { id } = attempt;
  const updated = await updateJob(attempt, {
    id,
    slug: repository.slug,
    state: 'running',
    stage,
    detail,
    updatedAt: new Date().toISOString(),
  });
  if (!updated) throw new FatalError('Repository processing attempt is no longer active.');
}

export async function prepare(
  attempt: JobAttempt,
): Promise<{ cached: boolean; name: string; startedAt: number }> {
  'use step';
  const context = await readAttempt(attempt);
  const { id } = attempt;
  await assertVisible(context.repository.slug, true);
  if (await loadCheckpoint(attempt)) {
    console.info('analysis: reused checkpoint', { snapshotId: id, attemptId: attempt.attemptId });
    return { cached: true, name: `lore-${attempt.attemptId}`, startedAt: Date.now() };
  }
  const { Sandbox } = await import('@vercel/sandbox');
  const { readFile } = await import('node:fs/promises');
  const { randomUUID } = await import('node:crypto');
  await status(attempt, 'clone', 'Preparing isolated repository analysis.');
  const name = `lore-${attempt.attemptId}`;
  let sandbox;
  try {
    sandbox = await Sandbox.get({ name });
  } catch (error) {
    if (!(error instanceof Error && /not found|does not exist|404/i.test(error.message)))
      throw error;
    sandbox = await Sandbox.create({
      name,
      runtime: 'node24',
      resources: { vcpus: 4 },
      timeout: SANDBOX_TIMEOUT_MS,
      persistent: false,
      networkPolicy: { allow: ['github.com'] },
    });
  }
  const startedAt = Date.now();
  const root = '/vercel/sandbox/run';
  const previous = await sandbox.readFileToBuffer({ path: `${root}/input.json` });
  if (!previous) {
    const staging = `/vercel/sandbox/prepare-${randomUUID()}`;
    await sandbox.writeFiles([
      {
        path: `${staging}/started.json`,
        content: JSON.stringify({ startedAt }),
      },
      {
        path: `${staging}/input.json`,
        content: JSON.stringify({ repository: context.repository, snapshotId: id }),
      },
      {
        path: `${staging}/analysis.mjs`,
        content: await readFile(`${process.cwd()}/.generated/analysis.mjs`),
      },
      {
        path: `${staging}/runner.mjs`,
        content: await readFile(`${process.cwd()}/.generated/runner.mjs`),
      },
    ]);
    const installed = await sandbox.runCommand({ cmd: 'mv', args: ['-T', '-n', staging, root] });
    if (installed.exitCode !== 0)
      throw new Error('Could not install the repository analysis runner.');
  }
  await sandbox.runCommand({
    cmd: 'node',
    cwd: root,
    args: [`${root}/runner.mjs`],
    detached: true,
  });
  const started = await sandbox.readFileToBuffer({ path: `${root}/started.json` });
  return {
    cached: false,
    name,
    startedAt: started
      ? z.object({ startedAt: z.number() }).parse(JSON.parse(started.toString('utf8'))).startedAt
      : startedAt,
  };
}

type BoundedRead =
  | { state: 'missing' }
  | { state: 'not-regular' }
  | { state: 'over-limit' }
  | { state: 'read'; bytes: Buffer };

type BoundedSource = {
  fs: { stat(path: string): Promise<{ size: number; isFile(): boolean }> };
  readFile(file: { path: string }): Promise<NodeJS.ReadableStream | null>;
};

async function readBounded(
  source: BoundedSource,
  path: string,
  limit: number,
): Promise<BoundedRead> {
  const stats = await source.fs.stat(path).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stats) return { state: 'missing' };
  if (!stats.isFile()) return { state: 'not-regular' };
  if (!Number.isSafeInteger(stats.size) || stats.size < 0)
    throw new Error(`${path} size could not be read.`);
  if (stats.size > limit) return { state: 'over-limit' };
  const stream = await source.readFile({ path });
  if (!stream) return { state: 'missing' };
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array | string);
    if (bytes + buffer.length > limit) return { state: 'over-limit' };
    bytes += buffer.length;
    chunks.push(buffer);
  }
  return { state: 'read', bytes: Buffer.concat(chunks, bytes) };
}

function unsupported(message: string): { state: 'failed'; failure: AnalysisFailure } {
  return { state: 'failed', failure: { kind: 'unsupported', message } };
}

function sameRepository(actual: Repository, expected: Repository): boolean {
  return (
    actual.owner === expected.owner &&
    actual.name === expected.name &&
    actual.slug.toLowerCase() === expected.slug.toLowerCase() &&
    actual.description === expected.description &&
    actual.branch === expected.branch &&
    actual.head === expected.head &&
    actual.stars === expected.stars
  );
}

export async function poll(
  attempt: JobAttempt,
  name: string,
  startedAt: number,
): Promise<
  | { state: 'running'; reporting: boolean; pastDeadline: boolean }
  | { state: 'done' }
  | { state: 'failed'; failure: AnalysisFailure }
> {
  'use step';
  const context = await readAttempt(attempt);
  const { id } = attempt;
  if (await loadCheckpoint(attempt)) return { state: 'done' };
  const { Sandbox } = await import('@vercel/sandbox');
  const sandbox = await Sandbox.get({ name });
  const read = await readBounded(sandbox, '/vercel/sandbox/run/status.json', MAX_STATUS_BYTES);
  const pastDeadline = Date.now() - startedAt >= ANALYSIS_DEADLINE_MS;
  if (read.state === 'missing') return { state: 'running', reporting: false, pastDeadline };
  if (read.state === 'not-regular') return unsupported('Analysis status is not a regular file.');
  if (read.state === 'over-limit')
    return unsupported('Analysis status exceeds the supported limit.');
  const progress = analysisStatusSchema.parse(JSON.parse(read.bytes.toString('utf8')));
  if (progress.state === 'failed') return progress;
  if (progress.state === 'running') {
    await status(attempt, progress.stage, progress.detail);
    return { state: 'running', reporting: true, pastDeadline };
  }
  const path = '/vercel/sandbox/run/snapshot.json';
  const output = await readBounded(sandbox, path, MAX_SNAPSHOT_BYTES);
  if (output.state === 'missing') throw new Error('Analysis output is missing.');
  if (output.state === 'not-regular') return unsupported('Analysis output is not a regular file.');
  if (output.state === 'over-limit')
    return unsupported('Analysis output exceeds the supported limit.');
  let snapshot: ReturnType<typeof parseSnapshot>;
  try {
    snapshot = parseSnapshot(JSON.parse(output.bytes.toString('utf8')));
  } catch {
    return unsupported('Analysis output is not a valid snapshot.');
  }
  const matches =
    snapshot.id === id &&
    sameRepository(snapshot.repository, context.repository) &&
    snapshotIdFor(snapshot.repository) === id;
  if (!matches) return unsupported('Analysis output does not match the requested repository.');
  await saveCheckpoint(attempt, snapshot);
  return { state: 'done' };
}

export async function cleanup(name: string): Promise<void> {
  'use step';
  const { Sandbox } = await import('@vercel/sandbox');
  try {
    const sandbox = await Sandbox.get({ name });
    await sandbox.delete({ deleteOrphanSnapshots: true });
  } catch (error) {
    if (error instanceof Error && /not found|does not exist|404/i.test(error.message)) return;
    throw error;
  }
}

export async function eraCount(attempt: JobAttempt): Promise<number> {
  'use step';
  await readAttempt(attempt);
  const snapshot = await loadCheckpoint(attempt);
  if (!snapshot) throw new Error('Analysis checkpoint is missing.');
  return snapshot.eras.length;
}

export async function narrate(attempt: JobAttempt, index: number): Promise<void> {
  'use step';
  await readAttempt(attempt);
  const { id } = attempt;
  const store = redis();
  const checkpointKey = key(`narration:${id}:${index}`);
  if (await store.exists(checkpointKey)) return;
  const snapshot = await loadCheckpoint(attempt);
  const era = snapshot?.eras[index];
  if (!era) throw new Error('Era checkpoint is missing.');
  await status(
    attempt,
    'narrate',
    `Writing era ${index + 1} of ${snapshot.eras.length} from its commits.`,
  );
  const selected = await narrateEra(era, snapshot.repository);
  const saved = await store.eval(
    SAVE_NARRATION_SCRIPT,
    [key(`context:${id}`), key('leases'), key(`job:${id}`), checkpointKey],
    [attempt.attemptId, id, Date.now(), JSON.stringify(selected)],
  );
  if (!saved) throw new FatalError('Repository processing attempt is no longer active.');
}

export async function publish(attempt: JobAttempt): Promise<void> {
  'use step';
  const store = redis();
  const job = await store.get(key(`job:${attempt.id}`));
  if (job && jobSchema.parse(job).state === 'ready') return;
  const context = await readAttempt(attempt);
  const { id } = attempt;
  const snapshot = await loadCheckpoint(attempt);
  if (!snapshot) throw new Error('Analysis checkpoint is missing.');
  const eras = [];
  for (let index = 0; index < snapshot.eras.length; index++)
    eras.push(eraSchema.parse(await store.get(key(`narration:${id}:${index}`))));
  await status(attempt, 'store', 'Publishing verified repository history.');
  await publishSnapshot({ ...snapshot, eras }, { observedAt: context.observedAt, attempt });
}

export async function fail(
  attempt: JobAttempt,
  failure: AnalysisFailure,
  stage: string,
): Promise<void> {
  'use step';
  console.error('repository_processing_failed', {
    snapshotId: attempt.id,
    attemptId: attempt.attemptId,
    stage,
    failure,
  });
  const raw = await redis().get(key(`job:${attempt.id}`));
  if (!raw) return;
  const job = jobSchema.parse(raw);
  if (job.state !== 'queued' && job.state !== 'running') return;
  await updateJob(attempt, {
    id: attempt.id,
    slug: job.slug,
    state: 'failed',
    message:
      failure.kind === 'unsupported'
        ? 'This repository exceeds the supported analysis limits.'
        : failure.kind === 'too-large'
          ? 'This repository is too large to analyze for now. Try again tomorrow.'
          : 'Repository processing is temporarily unavailable. You can retry later.',
    retryable: failure.kind === 'infrastructure',
    updatedAt: new Date().toISOString(),
  });
}

async function retire(attempt: JobAttempt): Promise<void> {
  'use step';
  await deleteCheckpoint(attempt);
}

async function logCleanupFailure(
  attempt: JobAttempt,
  stage: string,
  failure: AnalysisFailure,
): Promise<void> {
  'use step';
  console.error('repository_cleanup_failed', {
    snapshotId: attempt.id,
    attemptId: attempt.attemptId,
    stage,
    failure,
  });
}

export async function repositoryWorkflow(attempt: JobAttempt): Promise<void> {
  'use workflow';
  const name = `lore-${attempt.attemptId}`;
  let stage = 'prepare';
  let reportedFailure: AnalysisFailure | undefined;
  try {
    const prepared = await prepare(attempt);
    if (!prepared.cached) {
      stage = 'analysis';
      while (true) {
        const result = await poll(attempt, name, prepared.startedAt);
        if (result.state === 'failed') {
          reportedFailure = result.failure;
          throw new FatalError(result.failure.message);
        }
        if (result.state === 'done') break;
        if (result.pastDeadline) {
          if (!result.reporting) throw new Error('Repository analysis timed out.');
          reportedFailure = {
            kind: 'too-large',
            message: 'Repository analysis did not finish within the sandbox time limit.',
          };
          throw new FatalError(reportedFailure.message);
        }
        await sleep(`${POLL_SECONDS}s`);
      }
      try {
        await cleanup(name);
      } catch (error) {
        await logCleanupFailure(attempt, 'sandbox', analysisFailure(error));
      }
    }
    stage = 'narrate';
    const count = await eraCount(attempt);
    await Promise.all(Array.from({ length: count }, (_, index) => narrate(attempt, index)));
    stage = 'publish';
    await publish(attempt);
  } catch (error) {
    try {
      await fail(attempt, reportedFailure ?? analysisFailure(error), stage);
    } catch (failureError) {
      await logCleanupFailure(attempt, 'failure-status', analysisFailure(failureError));
    }
    try {
      await cleanup(name);
    } catch (cleanupError) {
      await logCleanupFailure(attempt, 'sandbox', analysisFailure(cleanupError));
    }
    throw error;
  }
  try {
    await retire(attempt);
  } catch (error) {
    await logCleanupFailure(attempt, 'checkpoint', analysisFailure(error));
  }
}
