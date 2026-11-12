'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { z } from 'zod';
import { jobSchema, type Job } from '@/lib/schema';
import { responseData } from './RepositoryForm';

type Stage = Extract<Job, { state: 'running' }>['stage'];
const steps: { label: string; stages: Stage[] }[] = [
  { label: 'resolve', stages: ['resolve'] },
  { label: 'clone', stages: ['clone'] },
  { label: 'history', stages: ['history'] },
  { label: 'map', stages: ['layout'] },
  { label: 'chapters', stages: ['eras', 'narrate'] },
  { label: 'publish', stages: ['store'] },
];

type Progress =
  | { kind: 'starting' }
  | { kind: 'queued' }
  | { kind: 'running'; stage: Stage; detail: string }
  | { kind: 'stopped'; message: string; retry: boolean };

const submissionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready'), slug: z.string() }),
  z.object({ kind: z.literal('queued'), slug: z.string(), jobId: z.string() }),
]);
const POLL_MS = 2500;

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export function RepositoryProgress({ slug }: { slug: string }) {
  const router = useRouter();
  const [progress, setProgress] = useState<Progress>({ kind: 'starting' });
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const open = (target: string) => {
      router.replace(`/${target}`);
      router.refresh();
    };
    let noRetry = false;
    (async () => {
      const posted = await fetch('/api/repositories', {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repository: slug }),
      });
      noRetry = posted.status === 422 || posted.status === 429;
      const submission = submissionSchema.parse(await responseData(posted));
      if (submission.kind === 'ready') return open(submission.slug);
      setProgress({ kind: 'queued' });
      while (true) {
        const job = jobSchema.parse(
          await responseData(
            await fetch(`/api/jobs/${submission.jobId}`, { cache: 'no-store', signal }),
          ),
        );
        if (job.state === 'ready') return open(job.slug);
        if (job.state === 'failed')
          return setProgress({ kind: 'stopped', message: job.message, retry: job.retryable });
        setProgress(
          job.state === 'queued'
            ? { kind: 'queued' }
            : { kind: 'running', stage: job.stage, detail: job.detail },
        );
        await wait(POLL_MS, signal);
      }
    })().catch((error: unknown) => {
      if (signal.aborted) return;
      setProgress({
        kind: 'stopped',
        message:
          error instanceof Error ? error.message : 'lore could not start reading this repository.',
        retry: !noRetry,
      });
    });
    return () => controller.abort();
  }, [router, slug]);

  const current =
    progress.kind === 'running'
      ? steps.findIndex((step) => step.stages.includes(progress.stage))
      : 0;
  return (
    <>
      <h1 className="sr-only">{slug}</h1>
      <p className="lede" role={progress.kind === 'stopped' ? 'alert' : undefined}>
        {progress.kind === 'stopped'
          ? progress.message
          : 'lore is reading this repository for the first time. this page opens the documentary when it is ready.'}
      </p>
      {progress.kind === 'stopped' ? (
        progress.retry && (
          <p className="page-actions">
            <a className="text-link" href={`/${slug}`}>
              try again
            </a>
          </p>
        )
      ) : (
        <ol
          className="index-section"
          style={{ '--c1': '10ch' } as CSSProperties}
          aria-live="polite"
        >
          {steps.map((step, index) => {
            const state = index < current ? 'done' : index === current ? 'current' : 'pending';
            return (
              <li key={step.label} className="index-row" data-state={state}>
                <span className="tone-faint">{step.label}</span>
                <span className="tone-body index-clip">
                  {state === 'current' && progress.kind === 'running' ? progress.detail : ''}
                </span>
                <span className="tone-faint index-trail index-trail-stack">
                  {state === 'done'
                    ? 'done'
                    : state === 'current'
                      ? progress.kind === 'running'
                        ? 'reading'
                        : 'waiting'
                      : ''}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}
