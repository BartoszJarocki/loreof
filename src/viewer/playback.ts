import type { Commit, Era, FileTrack } from '@/lib/schema';

export const TOUR_SECONDS = 90;
export const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

type Span = Pick<Era, 'start' | 'end'>;

/** The chapter that owns this point in the tour, without a division that can round down. */
export function chapterAtSeconds(eras: Span[], seconds: number): number {
  if (eras.length === 0) return 0;
  return clamp(
    Math.floor((Math.max(0, seconds) * eras.length) / TOUR_SECONDS + 1e-9),
    0,
    eras.length - 1,
  );
}

/** The tour gives every chapter the same share of its 90 seconds, however many commits it holds. */
export function commitAtSeconds(eras: Span[], count: number, seconds: number): number {
  if (eras.length === 0 || seconds >= TOUR_SECONDS) return Math.max(0, count - 1);
  const per = TOUR_SECONDS / eras.length;
  const index = chapterAtSeconds(eras, seconds);
  const { start, end } = eras[index];
  const fraction = (Math.max(0, seconds) - index * per) / per;
  return clamp(Math.floor(start + fraction * (end - start) + 1e-6), start, end - 1);
}

export function secondsAtCommit(eras: Span[], commit: number): number {
  if (eras.length === 0) return 0;
  const per = TOUR_SECONDS / eras.length;
  const index = eraIndexAt(eras, commit);
  const { start, end } = eras[index];
  return per * (index + clamp((commit - start) / Math.max(1, end - start), 0, 1));
}

/** Commits the tour passes each second at this commit, so a flash lasts the same wall time. */
export function commitsPerSecond(eras: Span[], commit: number): number {
  if (eras.length === 0) return 1;
  const { start, end } = eras[eraIndexAt(eras, commit)];
  return Math.max(1, (end - start) / (TOUR_SECONDS / eras.length));
}

export function eraIndexAt(eras: Span[], commit: number): number {
  const index = eras.findIndex((era) => era.start <= commit && commit < era.end);
  return index === -1 ? (commit < (eras[0]?.start ?? 0) ? 0 : eras.length - 1) : index;
}
export const fileVisible = (file: Pick<FileTrack, 'born' | 'died'>, cursor: number) =>
  file.born <= cursor && (file.died === null || cursor < file.died);

export function pathAt(file: Pick<FileTrack, 'paths' | 'path'>, cursor: number): string {
  let path = file.paths[0]?.[1] ?? file.path;
  for (const [start, next] of file.paths) {
    if (start > cursor) break;
    path = next;
  }
  return path;
}

export function lastTouch(touches: number[], cursor: number): number {
  let low = 0;
  let high = touches.length - 1;
  let result = -1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const value = touches[middle];
    if (value <= cursor) {
      result = value;
      low = middle + 1;
    } else high = middle - 1;
  }
  return result;
}

export function resolveTimePin(pin: string | null, commits: Pick<Commit, 'time'>[]): number | null {
  if (pin === null || commits.length === 0) return null;
  if (/^\d+$/.test(pin)) return clamp(Number(pin), 0, commits.length - 1);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(pin)) return null;
  const timestamp = Date.parse(`${pin}-01T00:00:00Z`) / 1000;
  let closest = 0;
  for (let i = 1; i < commits.length; i++) {
    if (Math.abs(commits[i].time - timestamp) < Math.abs(commits[closest].time - timestamp))
      closest = i;
  }
  return closest;
}

const dates = new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const numbers = new Intl.NumberFormat('en');
export const formatDate = (seconds: number) => dates.format(new Date(seconds * 1000));
export const monthStamp = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 7);
export const formatNumber = (value: number) => numbers.format(value);

export function pinnedUrl({
  origin,
  slug,
  snapshotId,
  cursor,
}: {
  origin: string;
  slug: string;
  snapshotId: string;
  cursor: number;
}) {
  const url = new URL(`/${slug}`, origin);
  url.searchParams.set('s', snapshotId);
  url.searchParams.set('t', String(Math.max(0, Math.round(cursor))));
  return url.href;
}
