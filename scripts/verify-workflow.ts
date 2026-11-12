import { parseSnapshot } from '../src/lib/snapshot';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { start } from 'workflow/api';
import { setWorld } from 'workflow/runtime';
import { createWorld } from '@workflow/world-vercel';
import { admit } from '../src/server/admission';
import { resolveRepository, parseRepository } from '../src/server/github';
import { assertVisible } from '../src/server/storage';
import { key, redis } from '../src/server/config';
import { snapshotIdFor } from '../src/lib/identity';
import { jobSchema } from '../src/lib/schema';

const { values } = parseArgs({
  options: {
    deployment: { type: 'string' },
    repo: { type: 'string', default: 'vercel/next.js' },
    environment: { type: 'string', default: 'production' },
    snapshot: { type: 'string' },
  },
});
const deploymentId = z.string().regex(/^dpl_/).parse(values.deployment);
const environment = z.enum(['production', 'preview']).parse(values.environment);
const project = z
  .object({ projectId: z.string(), orgId: z.string() })
  .parse(JSON.parse(await readFile('.vercel/project.json', 'utf8')));
const auth =
  process.env.WORKFLOW_VERCEL_AUTH_TOKEN ??
  z
    .object({ token: z.string() })
    .parse(JSON.parse(await readFile(`${homedir()}/.local/share/com.vercel.cli/auth.json`, 'utf8')))
    .token;
process.env.VERCEL_DEPLOYMENT_ID = deploymentId;
setWorld(
  createWorld({
    token: auth,
    projectConfig: { projectId: project.projectId, teamId: project.orgId, environment },
  }),
);
const slug = parseRepository(values.repo ?? 'vercel/next.js');
await assertVisible(slug, true);
const repository = values.snapshot
  ? parseSnapshot(JSON.parse(await readFile(values.snapshot, 'utf8'))).repository
  : await resolveRepository(slug);
if (repository.slug.toLowerCase() !== slug)
  throw new Error('Pinned snapshot belongs to a different repository.');
const id = snapshotIdFor(repository);
const admission = await admit({
  id,
  repository,
  ip: 'operator-workflow-verification',
  observedAt: Date.now(),
});
if (admission.kind !== 'admitted')
  throw new Error(`Verification requires a new attempt; admission returned ${admission.kind}.`);
const manifest = z
  .object({
    workflows: z.record(z.string(), z.record(z.string(), z.object({ workflowId: z.string() }))),
  })
  .parse(JSON.parse(await readFile('.next/diagnostics/workflows-manifest.json', 'utf8')));
const workflowId =
  manifest.workflows['src/workflows/repository.ts']?.repositoryWorkflow?.workflowId;
if (!workflowId) throw new Error('Build the workflow before verification.');
const began = Date.now();
const run = await start({ workflowId }, [admission.attempt], { deploymentId });
const events: { elapsedMs: number; at: string; state: string; stage?: string; detail?: string }[] =
  [];
const proof = {
  repository,
  snapshotId: id,
  attempt: admission.attempt,
  deploymentId,
  environment,
  runId: run.runId,
  events,
};
const output = `.cache/workflow-${run.runId}.json`;
await mkdir('.cache', { recursive: true });
process.stdout.write(JSON.stringify({ runId: run.runId, snapshotId: id, output }) + '\n');
let previous = '';
for (let count = 0; count < 180; count++) {
  const raw = await redis().get(key(`job:${id}`));
  const job = raw ? jobSchema.parse(raw) : null;
  if (job) {
    const label = job.state === 'running' ? `${job.stage}:${job.detail}` : job.state;
    if (label !== previous) {
      const event = {
        elapsedMs: Date.now() - began,
        at: new Date().toISOString(),
        state: job.state,
        ...(job.state === 'running' ? { stage: job.stage, detail: job.detail } : {}),
      };
      events.push(event);
      process.stdout.write(JSON.stringify(event) + '\n');
      previous = label;
      await writeFile(output, JSON.stringify(proof, null, 2));
    }
    if (job.state === 'ready') {
      const workflowStatus = await run.status;
      if (workflowStatus === 'failed' || workflowStatus === 'cancelled')
        throw new Error(`Hosted workflow ${workflowStatus} after publication.`);
      if (workflowStatus === 'completed') {
        await writeFile(output, JSON.stringify({ ...proof, workflowStatus }, null, 2));
        process.stdout.write('Hosted workflow completed.\n');
        break;
      }
    }
    if (job.state === 'failed')
      throw new Error('Hosted workflow reported failure. Inspect its run in Vercel.');
  }
  if (count === 179) throw new Error('Hosted workflow did not finish within fifteen minutes.');
  await setTimeout(5000);
}
