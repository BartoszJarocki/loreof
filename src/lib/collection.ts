import type { Manifest } from './schema';

export function years(manifest: Manifest): string {
  const [start, end] = [manifest.startTime, manifest.endTime].map((seconds) =>
    new Date(seconds * 1000).getUTCFullYear(),
  );
  return start === end ? `${start}` : `${start}–${end}`;
}

const pictographic = /[\p{Extended_Pictographic}\uFE00-\uFE0F\u200D]/gu;

export function summary(manifest: Manifest): string {
  const description = manifest.repository.description
    .replace(pictographic, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (description) return description;
  const chapters = manifest.eras.length;
  const commits = manifest.coverage.totalCommits;
  return `${chapters} ${chapters === 1 ? 'chapter' : 'chapters'} · ${commits.toLocaleString('en-US')} ${commits === 1 ? 'commit' : 'commits'}`;
}
