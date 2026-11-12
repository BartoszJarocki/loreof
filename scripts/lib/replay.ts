import { z } from 'zod';
import type { NarrationModel } from '../../src/server/narration';

export const recordingSchema = z.array(
  z.object({
    era: z.number().int().nonnegative(),
    from: z.string(),
    to: z.string(),
    attempts: z.array(z.unknown()),
    denied: z.boolean().optional(),
  }),
);
export type Recording = z.infer<typeof recordingSchema>;

export function replayModel(recording: Recording): NarrationModel & { calls: string[] } {
  const remaining = new Map(
    recording.map(({ from, to, attempts, denied }) => [
      `${from}..${to}`,
      { attempts: [...attempts], denied: Boolean(denied) },
    ]),
  );
  const calls: string[] = [];
  const model = async ({ prompt }: { prompt: string }) => {
    const { from, to } = z
      .object({ from: z.string(), to: z.string() })
      .parse(JSON.parse(prompt.split('\n\n')[0]));
    calls.push(`${from}..${to}`);
    const entry = remaining.get(`${from}..${to}`);
    if (!entry) throw new Error(`No recorded answer for ${from}..${to}`);
    if (!entry.attempts.length && entry.denied) return 'denied';
    const next = entry.attempts.shift();
    if (next === undefined) throw new Error(`No recorded answer left for ${from}..${to}`);
    return { output: next, cost: 0 };
  };
  return Object.assign(model, { calls });
}
