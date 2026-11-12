import type { Commit, Era } from '@/lib/schema';
import type { Touches } from '@/lib/snapshot-pack';
import { NO_BEAT_TICK } from '@/lib/snapshot-pack';
import { secondsAtCommit, TOUR_SECONDS } from './playback';

/** One commit line in a chapter, resolved to the commit's place in the map. */
export type Beat = {
  tick: number;
  time: number;
  /** The short SHA the sentence shows. */
  sha: string;
  /** The full SHA behind the GitHub link. */
  fullSha: string;
  subject: string;
  date: string;
  era: number;
};

export const ENVELOPE_SECONDS = 2.5;
export const BEAT_ZOOM = 0.35;
export const BEAT_SPEED = 0.75;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** The prototype's one curve: in over 0.45 s, hold, then out over 0.65 s. */
export function envelope(seconds: number): number {
  const t = seconds;
  if (t <= 0) return 0;
  if (t >= ENVELOPE_SECONDS) return 0;
  if (t < 0.45) return ease(t / 0.45);
  if (t < 1.85) return 1;
  return Math.max(0, ease(1 - (t - 1.85) / 0.65));
}

/** Playback runs at this share of its normal speed during a beat. */
export function beatSpeed(seconds: number): number {
  return 1 - BEAT_SPEED * envelope(seconds);
}

/**
 * A beat names a sheet item, and the item carries the commit's full sha. The map part resolves
 * each beat to its tick by that sha when it is written. It never matches on time.
 */
export function buildBeats(
  eras: Era[],
  commits: Pick<Commit, 'time'>[],
  packedTicks?: ArrayLike<number> | null,
): Beat[] {
  if (commits.length === 0) return [];
  const beats: Beat[] = [];
  let flat = 0;
  eras.forEach((era, eraIndex) => {
    const sheet = new Map(era.sheet.map((item) => [item.id, item]));
    for (const beat of era.beats) {
      const index = flat++;
      if (beat.kind !== 'commit') continue;
      const item = sheet.get(beat.ref);
      if (item?.time === undefined) continue;
      const packed = packedTicks?.[index];
      const tick = packed !== undefined && packed !== NO_BEAT_TICK ? packed : undefined;
      if (tick === undefined) continue;
      beats.push({
        tick,
        time: item.time,
        sha: beat.sha,
        fullSha: item.commits[0] ?? beat.sha,
        subject: beat.subject,
        date: beat.date,
        era: eraIndex,
      });
    }
  });
  return beats.sort((a, b) => a.tick - b.tick || a.era - b.era);
}

export function nextBeat(beats: Beat[], tick: number): Beat | null {
  for (const beat of beats) if (beat.tick > tick) return beat;
  return null;
}

export function previousBeat(beats: Beat[], tick: number): Beat | null {
  for (let index = beats.length - 1; index >= 0; index--)
    if (beats[index].tick < tick) return beats[index];
  return null;
}

/** File `f` was touched at every tick in `ticks[offsets[f]..offsets[f + 1])`. Inverted once. */
export type TouchIndex = { start: Uint32Array; files: Uint32Array };

export function invertTouches(touches: Touches, commits: number): TouchIndex {
  const start = new Uint32Array(commits + 1);
  for (const tick of touches.ticks) if (tick < commits) start[tick + 1]++;
  for (let tick = 0; tick < commits; tick++) start[tick + 1] += start[tick];
  const at = start.slice(0, commits);
  const files = new Uint32Array(touches.ticks.length);
  const fileCount = touches.offsets.length - 1;
  for (let file = 0; file < fileCount; file++)
    for (let index = touches.offsets[file]; index < touches.offsets[file + 1]; index++) {
      const tick = touches.ticks[index];
      if (tick < commits) files[at[tick]++] = file;
    }
  return { start, files };
}

export function touchedAt(index: TouchIndex, tick: number): Uint32Array | null {
  if (tick < 0 || tick + 1 >= index.start.length) return null;
  return index.files.subarray(index.start[tick], index.start[tick + 1]);
}

/** Commit counts per equal-width bin of the tour, so chapters share the timeline evenly. */
export function commitBins(
  eras: Era[],
  commits: Pick<Commit, 'time'>[],
  bins: number,
  activity?: ArrayLike<number> | null,
): number[] {
  const counts = new Array<number>(bins).fill(0);
  for (let commit = 0; commit < commits.length; commit++) {
    const share = secondsAtCommit(eras, commit) / TOUR_SECONDS;
    counts[Math.min(bins - 1, Math.max(0, Math.floor(share * bins)))] += activity?.[commit] ?? 1;
  }
  return counts;
}

/** Files each commit touched, from the inverted touch index, for the histogram's real activity. */
export function touchActivity(index: TouchIndex): Uint32Array {
  const activity = new Uint32Array(index.start.length - 1);
  for (let tick = 0; tick < activity.length; tick++)
    activity[tick] = index.start[tick + 1] - index.start[tick];
  return activity;
}

export const tourAtCommit = (eras: Era[], commit: number) =>
  clamp01(secondsAtCommit(eras, commit) / TOUR_SECONDS);
