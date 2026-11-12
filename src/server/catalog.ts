import { start } from 'workflow/api';
import { z } from 'zod';
import { HookConflictError, WorkflowStartError, WorkflowWorldError } from 'workflow/errors';
import { GALLERY } from '@/lib/gallery';
import { snapshotIdFor } from '@/lib/identity';
import {
  jobSchema,
  snapshotIdSchema,
  type Job,
  type Manifest,
  type Submission,
} from '@/lib/schema';
import { repositoryWorkflow } from '@/workflows/repository';
import { admit } from './admission';
import { observeRepository } from './observation';
import { key, redis } from './config';
import { denial, parseRepository, repositoryDetails, resolveRepository } from './github';
import { assertVisible, cachedCanonicalName, promoteManifest, readManifest } from './storage';

export { ACCESS_HEADER } from './github';

export async function submitRepository({
  input,
  ip,
}: {
  input: string;
  ip: string;
}): Promise<Submission> {
  const slug = parseRepository(input);
  const observedAt = await observeRepository();
  await assertVisible(slug, true);
  const repository = await resolveRepository(slug);
  const id = snapshotIdFor(repository);
  const existing = await readManifest(repository.slug, id);
  if (existing) {
    await promoteManifest(existing, observedAt);
    return { kind: 'ready', slug: repository.slug, snapshotId: existing.id };
  }
  const admission = await admit({ id, repository, ip, observedAt });
  if (admission.kind === 'ready') {
    const manifest = await readManifest(repository.slug, id);
    if (!manifest) throw new Error('Completed repository manifest is missing.');
    await promoteManifest(manifest, observedAt);
    return { kind: 'ready', slug: repository.slug, snapshotId: id };
  }
  if (admission.kind === 'existing') return { kind: 'queued', slug: repository.slug, jobId: id };
  const { attempt } = admission;
  const hookEnabled = ['1', 'true'].includes(
    process.env.WORKFLOW_VERCEL_EXPERIMENTAL_START_HOOK ?? '',
  );
  try {
    await start(
      repositoryWorkflow,
      [attempt],
      hookEnabled
        ? {
            hook: { token: `lore:${id}:${attempt.attemptId}` },
          }
        : {},
    );
  } catch (error) {
    console.error('repository_workflow_start_failed', {
      snapshotId: id,
      attemptId: attempt.attemptId,
      kind: HookConflictError.is(error)
        ? 'hook_conflict'
        : WorkflowStartError.is(error)
          ? 'uncertain_start'
          : WorkflowWorldError.is(error)
            ? 'world_error'
            : 'start_error',
      ...(WorkflowStartError.is(error) ? { stage: error.stage, runId: error.runId } : {}),
      ...(WorkflowWorldError.is(error) ? { code: error.code } : {}),
    });
    if (!HookConflictError.is(error)) {
      await admission.release({
        id,
        slug: repository.slug,
        state: 'failed',
        message: 'Processing could not start. Please try again.',
        retryable: true,
        updatedAt: new Date().toISOString(),
      });
      throw error;
    }
  }
  return { kind: 'queued', slug: repository.slug, jobId: id };
}

export async function getJob(id: string): Promise<Job | null> {
  const value = await redis().get(key(`job:${snapshotIdSchema.parse(id)}`));
  if (!value) return null;
  const job = jobSchema.parse(value);
  await assertVisible(job.slug);
  if (job.state === 'queued' || job.state === 'running') {
    const lease = await redis().zscore(key('leases'), id);
    if (lease === null || Number(lease) <= Date.now()) {
      const failed: Job = {
        id: job.id,
        slug: job.slug,
        state: 'failed',
        message: 'Processing timed out. Please submit the repository again to retry.',
        retryable: true,
        updatedAt: new Date().toISOString(),
      };
      return failed;
    }
  }
  return job;
}
export async function getManifest(slug: string, id?: string): Promise<Manifest | null> {
  return readManifest(parseRepository(slug), id);
}

export type RepositoryView =
  | { kind: 'ready'; manifest: Manifest }
  | { kind: 'uncached'; slug: string }
  | { kind: 'moved'; slug: string }
  | { kind: 'missing' }
  | { kind: 'rate-limited' }
  | { kind: 'unreachable' }
  | { kind: 'not-configured' };

export async function viewRepository(slug: string, id?: string): Promise<RepositoryView> {
  slug = parseRepository(slug);
  try {
    const manifest = await readManifest(slug, id);
    if (manifest) return { kind: 'ready', manifest: await withDescription(manifest) };
    const canonical = await cachedCanonicalName(slug);
    if (canonical !== slug) return { kind: 'moved', slug: canonical };
    return id ? { kind: 'missing' } : { kind: 'uncached', slug };
  } catch (error) {
    return { kind: denial(error) };
  }
}

const detailsSchema = z.object({ description: z.string().nullable() });

async function withDescription(manifest: Manifest): Promise<Manifest> {
  if (manifest.repository.description) return manifest;
  const slug = manifest.repository.slug.toLowerCase();
  const stored = detailsSchema.safeParse(await redis().get(key(`details:${slug}`)));
  let description = stored.success ? stored.data.description : null;
  if (!stored.success) {
    const details = await repositoryDetails(slug);
    description = details?.description ?? null;
    await redis().set(key(`details:${slug}`), { description }, { ex: details ? 86_400 : 600 });
  }
  return description
    ? { ...manifest, repository: { ...manifest.repository, description } }
    : manifest;
}

const GALLERY_CACHE_MS = 60_000;
let galleryCache: { at: number; manifests: Manifest[] } | null = null;

export async function listGallery(): Promise<Manifest[]> {
  const now = Date.now();
  if (galleryCache && now - galleryCache.at < GALLERY_CACHE_MS) return galleryCache.manifests;
  const published = new Set(await redis().smembers<string[]>(key('gallery')));
  const results = await Promise.allSettled(
    GALLERY.filter((item) => published.has(item.slug.toLowerCase())).map((item) =>
      getManifest(item.slug),
    ),
  );
  const manifests = results.flatMap((result) =>
    result.status === 'fulfilled' && result.value ? [result.value] : [],
  );
  if (results.every((result) => result.status === 'fulfilled'))
    galleryCache = { at: now, manifests };
  return manifests;
}
