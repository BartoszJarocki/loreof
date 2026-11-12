import type { Era } from '@/lib/schema';
import { formatDate } from './playback';

export type ChapterBeat =
  | { kind: 'commit'; ref: string; date: string; sha: string; subject: string }
  | { kind: 'fact'; ref: string; text: string };

export type ChapterView = {
  number: number;
  dateRange: string;
  title: string;
  headline?: string;
  beats: ChapterBeat[];
  note?: string;
};

const notes = {
  facts: 'Factual captions from the Git record.',
  reviewed: 'Reviewed by a person against the commits linked under each line.',
} as const;

function modelNote(era: Era): string {
  const pullRefs = new Set(
    era.sheet.filter((item) => item.kind === 'commit' && item.title).map((item) => item.id),
  );
  const hasPullLine = era.beats.some((beat) => beat.kind === 'commit' && pullRefs.has(beat.ref));
  const source = hasPullLine
    ? "Each line is the commit's own subject, except a GitHub Merge pull request line, which shows the pull request title."
    : "Each line is the commit's own subject.";
  return `A model selected these commits and the headline. ${source} No person has reviewed it yet.`;
}

export function chapterView(era: Era): ChapterView {
  return {
    number: era.id + 1,
    dateRange: `${formatDate(era.startTime)} to ${formatDate(era.endTime)}`,
    title: era.title,
    headline: era.headline,
    beats: era.beats.map((beat) =>
      beat.kind === 'commit'
        ? {
            kind: 'commit' as const,
            ref: beat.ref,
            date: beat.date,
            sha: beat.sha,
            subject: beat.subject,
          }
        : { kind: 'fact' as const, ref: beat.ref, text: beat.text },
    ),
    note: era.narration === 'model' ? modelNote(era) : notes[era.narration],
  };
}

export function yearSpan(era: Pick<Era, 'startTime' | 'endTime'>): string {
  const start = new Date(era.startTime * 1000).getUTCFullYear();
  const end = new Date(era.endTime * 1000).getUTCFullYear();
  return start === end ? `${start}` : `${start}–${String(end).slice(2)}`;
}
