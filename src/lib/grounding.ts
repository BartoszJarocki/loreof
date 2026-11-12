export type Evidence = {
  id: string;
  kind?: string;
  text: string;
  title?: string;
  time?: number;
  commits: string[];
};
export type FactSheet = { from: number; to: number; items: Evidence[] };
export type CommitBeat = {
  kind: 'commit';
  ref: string;
  sha: string;
  date: string;
  subject: string;
};
export type FactBeat = { kind: 'fact'; ref: string; text: string };
export type Beat = CommitBeat | FactBeat;
export type ChapterDraft = { commits: string[]; headline?: string };

export const LIMITS = { title: 60, beats: [2, 4] } as const;
export const SHORT_SHA = 9;

export function sheetSubject(subject: string, title?: string): string {
  const pull = /^Merge pull request #(\d+) from \S+/.exec(subject);
  if (!pull || !title) return subject;
  const number = pull[1];
  if (/^Merge pull request #\d+/.test(title)) return subject;
  if (/^Merge (?:pull request|branch) #\d+/i.test(title)) return subject;
  if (title.length > 120) return subject;
  return new RegExp(`\\(#${number}\\)`).test(title) ? title : `${title} (#${number})`;
}

export function mergeNumber(subject: string): string | undefined {
  return /^Merge pull request #(\d+) from \S+/.exec(subject)?.[1];
}

export function isoDate(time: number): string {
  return new Date(time * 1000).toISOString().slice(0, 10);
}

const CONVENTIONAL_PREFIX =
  /^(?:BREAKING CHANGE|feat|fix|refactor|chore|perf|docs|test|build|ci|style|revert)(?:\([^)]*\))?!?:\s*/i;
const SPACE = /\s/;

// Equivalent to the trailing /\s*\(#\d+\)\s*$/ match, scanned once so a hostile
// whitespace run cannot make the match quadratic.
function withoutPullNumber(subject: string): string {
  let end = subject.length;
  while (end > 0 && SPACE.test(subject[end - 1])) end--;
  if (end < 4 || subject[end - 1] !== ')') return subject;
  let digits = end - 1;
  while (digits > 0 && subject[digits - 1] >= '0' && subject[digits - 1] <= '9') digits--;
  if (digits === end - 1 || digits < 2) return subject;
  if (subject[digits - 1] !== '#' || subject[digits - 2] !== '(') return subject;
  let start = digits - 2;
  while (start > 0 && SPACE.test(subject[start - 1])) start--;
  return subject.slice(0, start);
}

export function titleFromSubject(subject: string): string {
  const stripped = withoutPullNumber(subject.replace(CONVENTIONAL_PREFIX, '')).trim();
  const text = stripped || subject.trim();
  if (text.length <= LIMITS.title) return text;
  const cut = text.slice(0, LIMITS.title - 1);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > 0 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

function commitItems(sheet: FactSheet): Evidence[] {
  return sheet.items.filter((item) => item.kind === 'commit');
}

function selection(
  refs: string[],
  sheet: FactSheet,
  headline?: string,
): { commits: Evidence[]; errors: string[] } {
  const errors: string[] = [];
  if (refs.length < LIMITS.beats[0] || refs.length > LIMITS.beats[1])
    errors.push(`commits: choose ${LIMITS.beats[0]} to ${LIMITS.beats[1]}`);
  if (new Set(refs).size !== refs.length) errors.push('commits: duplicate');
  const byId = new Map(commitItems(sheet).map((item) => [item.id, item]));
  const commits = refs.flatMap((ref) => {
    const item = byId.get(ref);
    if (!item) errors.push(`commits: ${ref} is not a commit in this chapter`);
    return item ? [item] : [];
  });
  if (headline === undefined) errors.push('headline: choose one of the selected commits');
  else if (!refs.includes(headline)) errors.push('headline: not among the selected commits');
  else {
    const item = byId.get(headline);
    if (item && isFactualTitle(titleFromSubject(item.text)))
      errors.push('headline: title is factual-shaped');
  }
  return { commits, errors };
}

export function ground(draft: ChapterDraft, sheet: FactSheet): string[] {
  return [...new Set(selection(draft.commits, sheet, draft.headline).errors)];
}

export function beatsFrom(refs: string[], sheet: FactSheet): CommitBeat[] {
  const byId = new Map(commitItems(sheet).map((item) => [item.id, item]));
  const order = new Map(refs.map((ref, index) => [ref, index]));
  return refs
    .flatMap((ref) => {
      const item = byId.get(ref);
      if (!item || item.time === undefined) return [];
      return [
        {
          kind: 'commit' as const,
          ref,
          sha: item.commits[0].slice(0, SHORT_SHA),
          date: isoDate(item.time),
          subject: item.text,
        },
      ];
    })
    .sort(
      (a, b) => a.date.localeCompare(b.date) || (order.get(a.ref) ?? 0) - (order.get(b.ref) ?? 0),
    );
}

const FACTUAL_TITLE =
  /^(?:The first chapter|Chapter \d+|[\d,]+ non-bot integration commits|The \S{1,80} tag|[A-Z][a-z]{2} \d{4} to [A-Z][a-z]{2} \d{4})$/;

export function isFactualTitle(title: string): boolean {
  return FACTUAL_TITLE.test(title);
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function monthLabel(time: number): string {
  const date = new Date(time * 1000);
  return `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export function factualTitleError(
  era: {
    id: number;
    startTime: number;
    endTime: number;
    sheet?: { kind?: string; text: string }[];
  },
  title: string,
  humanCommits: number,
  legacy = false,
): string | undefined {
  const tag = /^The (.+) tag$/.exec(title);
  if (tag) {
    if (legacy) return undefined;
    const releases = era.sheet?.filter((item) => item.kind === 'release') ?? [];
    return releases.some((item) => item.text === tag[1])
      ? undefined
      : `title: ${title} is not a release tag in this chapter`;
  }
  const range = /^[A-Z][a-z]{2} \d{4} to [A-Z][a-z]{2} \d{4}$/.test(title);
  if (range) {
    const expected = `${monthLabel(era.startTime)} to ${monthLabel(era.endTime)}`;
    return title === expected ? undefined : `title: ${title} is not this chapter's dates`;
  }
  if (title === 'The first chapter')
    return era.id === 0 ? undefined : `title: ${title} is not this chapter's position`;
  const chapter = /^Chapter (\d+)$/.exec(title);
  if (chapter) {
    const shown = Number(chapter[1]);
    return shown === era.id + 1
      ? undefined
      : `title: ${title} is not this chapter's number ${era.id + 1}`;
  }
  const count = /^([\d,]+) non-bot integration commits$/.exec(title);
  if (count) {
    const shown = Number(count[1].replaceAll(',', ''));
    return shown === humanCommits
      ? undefined
      : `title: ${title} does not match this chapter's ${humanCommits} non-bot commits`;
  }
  return `title: ${title} is not a factual title`;
}

export function factualNarration(era: {
  id: number;
  facts: { id: string; text: string }[];
  startTime?: number;
  endTime?: number;
  sheet?: { kind?: string; text: string }[];
}): { title: string; beats: FactBeat[] } {
  const tag = era.sheet?.filter((item) => item.kind === 'release').at(-1)?.text;
  const range =
    era.startTime !== undefined && era.endTime !== undefined
      ? `${monthLabel(era.startTime)} to ${monthLabel(era.endTime)}`
      : undefined;
  const tagTitle = tag ? `The ${tag} tag` : undefined;
  const title =
    (tagTitle && tagTitle.length <= LIMITS.title ? tagTitle : undefined) ??
    range ??
    (era.id === 0 ? 'The first chapter' : `Chapter ${era.id + 1}`);
  return {
    title,
    beats: era.facts
      .filter((fact) => fact.text.length <= 500)
      .slice(0, 4)
      .map((fact) => ({ kind: 'fact' as const, ref: fact.id, text: fact.text })),
  };
}

export function sheetFor(era: {
  startTime: number;
  endTime: number;
  sheet: Evidence[];
}): FactSheet {
  return { from: era.startTime, to: era.endTime, items: era.sheet };
}
