import { z } from 'zod';
import { UnsupportedRepositoryError } from '../analysis/errors';

export const SANDBOX_TIMEOUT_MS = 10 * 60_000;
export const POLL_SECONDS = 5;
export const DEADLINE_MARGIN_MS = 60_000;
export const ANALYSIS_DEADLINE_MS = SANDBOX_TIMEOUT_MS - DEADLINE_MARGIN_MS;
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export const MAX_STATUS_BYTES = 64 * 1024;

export const progressSchema = z.object({
  stage: z.enum(['clone', 'history', 'layout', 'eras']),
  detail: z.string().max(200),
});
export const analysisFailureSchema = z.object({
  kind: z.enum(['unsupported', 'too-large', 'infrastructure']),
  message: z.string().max(2000),
  name: z.string().max(200).optional(),
  stack: z.string().max(8000).optional(),
});
export type AnalysisFailure = z.infer<typeof analysisFailureSchema>;
export const analysisStatusSchema = z.discriminatedUnion('state', [
  progressSchema.extend({ state: z.literal('running') }),
  z.object({ state: z.literal('done') }),
  z.object({ state: z.literal('failed'), failure: analysisFailureSchema }),
]);
export type AnalysisStatus = z.infer<typeof analysisStatusSchema>;

export function analysisFailure(error: unknown): AnalysisFailure {
  return {
    kind: error instanceof UnsupportedRepositoryError ? 'unsupported' : 'infrastructure',
    message: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
    ...(error instanceof Error
      ? { name: error.name.slice(0, 200), stack: error.stack?.slice(0, 8000) }
      : {}),
  };
}
