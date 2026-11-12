import type { SheetItem } from '../lib/schema';
import { sheetSubject } from '../lib/grounding';
import type { History } from './git';

type Tag = { name: string; sha: string; tick: number };

const LIMITS = { commits: 30, releases: 10, directories: 8, terms: 12, newcomers: 8 };
const PRERELEASE =
  /(?:^|[-.+_@/])(?:canary|alpha|beta|rc|next|nightly|preview|pre|dev|experimental|insiders)|\d(?:a|b|rc)\d+$/i;
const STOP = new Set(
  'the and for with from into onto this that when then than not use add adds added update updates updated remove removes removed fix fixes fixed make makes made more less some all any its are was were has have had can should will would could also only just via per new old bump bumps merge merged pull request auto rollup branch master main revert reverts changes change minor small few misc cleanup clean test tests docs doc readme version release typo typos code file files support supports allow allows don does doesn now still use uses used using get set first last other into out run runs convert flag enable disable rename move delete improve refactor upgrade implement initial check issue example patch round link post record lint prettier format sync wip draft fixture feature beta canary alpha ensure sure chore com but these which https http www commit feat perf build style'.split(
    ' ',
  ),
);

const MERGE_REF =
  /^Merge (?:tags?|branch(?:es)?|remote-tracking branch) '[^']*'(?:,? (?:and )?'[^']*')*(?: (?:of|into) \S+)?/i;
const LINK = /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\bgit@)\S+|\S+\.(?:org|com|net|io|dev)[:/]\S*/gi;

export function area(path: string): string {
  const parts = path.split('/');
  parts.pop();
  return parts.slice(0, 2).join('/') || '.';
}

export function subjectTerms(text: string): Map<string, string> {
  const cleaned = text
    .replace(MERGE_REF, '')
    .replace(LINK, '')
    .replace(/^(?:Auto|Rollup) merge of #\d+ - [^:\s]+:/i, '')
    .replace(/^auto merge of #\d+ : [^\s,]+/i, '')
    .replace(/^Merge pull request #\d+ from [^/\s]+\//i, '')
    .replace(/,?\s*r=\S+/g, '')
    .replace(/\(#\d+\)/g, '');
  const terms = new Map<string, string>();
  for (const surface of cleaned.split(/[^A-Za-z0-9]+/)) {
    const word = surface.toLowerCase();
    if (word.length < 3 || !/^[a-z]/.test(word) || /^v\d+$/.test(word) || STOP.has(word)) continue;
    const stem =
      word.length > 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
    if (!STOP.has(stem) && !terms.has(stem)) terms.set(stem, surface);
  }
  return terms;
}

export function factSheets(history: History, boundaries: number[], tags: Tag[]): SheetItem[][] {
  const { commits, authors, tracks } = history;
  const titles = new Map<string, string>();
  for (const commit of commits) {
    const title = history.titles?.get(commit.sha);
    if (
      title &&
      commit.merge &&
      /^(?:Merge pull request #\d+|(?:Auto|Rollup) merge of #\d+)/i.test(commit.subject) &&
      title.length <= 120
    )
      titles.set(commit.sha, title);
  }
  const handles = new Set(
    authors.flatMap((author) => (author.kind === 'github' ? [author.handle.toLowerCase()] : [])),
  );
  const textOf = (tick: number) =>
    sheetSubject(commits[tick].subject, titles.get(commits[tick].sha));
  const eras = boundaries.length - 1;
  const eraOf = new Int32Array(commits.length);
  for (let era = 0; era < eras; era++) eraOf.fill(era, boundaries[era], boundaries[era + 1]);
  const human = (tick: number) => authors[commits[tick].author].kind !== 'bot';

  const areaTotals = new Map<string, number>();
  const areaEras = Array.from({ length: eras }, () => new Map<string, number>());
  const visit = (each: (tick: number, path: string) => void) => {
    for (const track of tracks) {
      let interval = 0;
      for (const tick of track.touches) {
        while (interval + 1 < track.paths.length && track.paths[interval + 1][0] <= tick)
          interval++;
        if (human(tick)) each(tick, track.paths[interval][1]);
      }
    }
  };
  visit((tick, path) => {
    const key = area(path);
    areaTotals.set(key, (areaTotals.get(key) ?? 0) + 1);
    const counts = areaEras[eraOf[tick]];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  const specificity = new Float64Array(commits.length);
  const touched = new Int32Array(commits.length);
  visit((tick, path) => {
    const key = area(path);
    specificity[tick] += (areaEras[eraOf[tick]].get(key) ?? 0) / (areaTotals.get(key) ?? 1);
    touched[tick]++;
  });
  const score = (tick: number, cap = 32) =>
    touched[tick]
      ? (specificity[tick] / touched[tick]) * Math.log2(1 + Math.min(cap, touched[tick]))
      : 0;

  const spans = new Map<string, { born: number; ended: number; files: number }>();
  for (const track of tracks)
    track.paths.forEach(([from, path], index) => {
      const to = track.paths[index + 1]?.[0] ?? track.died ?? Infinity;
      const parts = path.split('/').slice(0, -1);
      for (let depth = 1; depth <= Math.min(2, parts.length); depth++) {
        const key = parts.slice(0, depth).join('/');
        const span = spans.get(key) ?? { born: from, ended: to, files: 0 };
        span.born = Math.min(span.born, from);
        span.ended = Math.max(span.ended, to);
        span.files++;
        spans.set(key, span);
      }
    });
  const directoryEvents = Array.from(
    { length: eras },
    () => [] as { path: string; change: string; tick: number; files: number }[],
  );
  for (const [path, span] of spans) {
    directoryEvents[eraOf[span.born]].push({
      path,
      change: 'created',
      tick: span.born,
      files: span.files,
    });
    if (Number.isFinite(span.ended) && span.ended < commits.length)
      directoryEvents[eraOf[span.ended]].push({
        path,
        change: 'removed',
        tick: span.ended,
        files: span.files,
      });
  }

  const termTotals = new Map<string, number>();
  const termEras = Array.from({ length: eras }, () => new Map<string, number>());
  const eraSizes = new Int32Array(eras);
  const firstTick = new Map<number, number>();
  const eraAuthors = Array.from({ length: eras }, () => new Map<number, number>());
  commits.forEach((commit, tick) => {
    if (!human(tick)) return;
    const era = eraOf[tick];
    eraSizes[era]++;
    for (const term of subjectTerms(textOf(tick)).keys()) {
      if (handles.has(term)) continue;
      termTotals.set(term, (termTotals.get(term) ?? 0) + 1);
      termEras[era].set(term, (termEras[era].get(term) ?? 0) + 1);
    }
    if (!firstTick.has(commit.author)) firstTick.set(commit.author, tick);
    eraAuthors[era].set(commit.author, (eraAuthors[era].get(commit.author) ?? 0) + 1);
  });
  const humanTotal = eraSizes.reduce((sum, size) => sum + size, 0);

  return Array.from({ length: eras }, (_, era) => {
    const start = boundaries[era];
    const end = boundaries[era + 1];
    const ticks: number[] = [];
    for (let tick = start; tick < end; tick++) if (human(tick)) ticks.push(tick);
    const ranked = [...ticks].sort((a, b) => score(b) - score(a) || a - b);
    const items: Omit<SheetItem, 'id'>[] = [];

    const size = eraSizes[era];
    const rest = humanTotal - size;
    const rising = [...termEras[era]]
      .filter(([, count]) => count >= 3)
      .map(([term, count]) => {
        const elsewhere = (termTotals.get(term) ?? 0) - count;
        const lift = rest
          ? Math.log((count + 0.5) / (size + 1)) - Math.log((elsewhere + 0.5) / (rest + 1))
          : count / Math.max(1, size);
        return { term, lift: lift * count };
      })
      .filter(({ lift }) => lift > 0)
      .sort((a, b) => b.lift - a.lift || a.term.localeCompare(b.term, 'en'))
      .slice(0, LIMITS.terms);
    const terms = rising.map(({ term }) => ({
      term,
      examples: [...ranked]
        .sort((a, b) => score(b, Infinity) - score(a, Infinity) || a - b)
        .filter((tick) => subjectTerms(textOf(tick)).has(term))
        .slice(0, 3),
    }));
    const chosen = new Set<number>();
    for (const tick of [...terms.map(({ examples }) => examples[0]), ...ranked]) {
      if (chosen.size >= LIMITS.commits) break;
      if (
        tick !== undefined &&
        commits[tick].subject.trim() &&
        !/^Revert\b/.test(commits[tick].subject)
      )
        chosen.add(tick);
    }
    for (const tick of [...chosen].sort((a, b) => a - b)) {
      const commit = commits[tick];
      const title = titles.get(commit.sha);
      const text = sheetSubject(commit.subject, title);
      items.push({
        kind: 'commit',
        text,
        ...(title && title !== commit.subject ? { title } : {}),
        time: commit.time,
        commits: [commit.sha],
      });
    }

    const releases = tags.filter(
      (tag) => tag.tick >= start && tag.tick < end && !PRERELEASE.test(tag.name),
    );
    const version = (name: string) => name.replace(/^(?:v|release-)/i, '');
    const minor = (name: string) =>
      /(?:^|\D)\d+\.0\.0$/.test(name) ? 0 : /\d+\.\d+\.0$|^v?\d+\.\d+$/.test(name) ? 1 : 2;
    const seen = new Set<string>();
    for (const tag of releases
      .sort((a, b) => minor(a.name) - minor(b.name) || a.tick - b.tick)
      .filter((tag) => !seen.has(version(tag.name)) && Boolean(seen.add(version(tag.name))))
      .slice(0, LIMITS.releases)
      .sort((a, b) => a.tick - b.tick || a.name.localeCompare(b.name, 'en')))
      items.push({
        kind: 'release',
        text: tag.name,
        time: commits[tag.tick].time,
        commits: [tag.sha],
      });

    for (const event of directoryEvents[era]
      .sort((a, b) => b.files - a.files || a.tick - b.tick || a.path.localeCompare(b.path, 'en'))
      .slice(0, LIMITS.directories)
      .sort((a, b) => a.tick - b.tick || a.path.localeCompare(b.path, 'en')))
      items.push({
        kind: 'directory',
        text: `${event.path}/ ${event.change}`,
        time: commits[event.tick].time,
        commits: [commits[event.tick].sha],
      });

    for (const { term, examples } of terms)
      items.push({
        kind: 'term',
        text: subjectTerms(textOf(examples[0])).get(term) ?? term,
        time: commits[examples[0]].time,
        commits: examples.map((tick) => commits[tick].sha),
      });

    for (const [author] of [...eraAuthors[era]]
      .filter(([author]) => {
        const first = firstTick.get(author);
        return first !== undefined && first >= start && first < end;
      })
      .flatMap(([author, count]) => {
        const value = authors[author];
        return value.kind === 'github' ? [[value, count] as const] : [];
      })
      .sort(([a, x], [b, y]) => y - x || a.handle.localeCompare(b.handle, 'en'))
      .slice(0, LIMITS.newcomers))
      items.push({
        kind: 'newcomer',
        text: `@${author.handle}`,
        time: commits[firstTick.get(author.id) ?? start].time,
        commits: [commits[firstTick.get(author.id) ?? start].sha],
      });

    const counters = new Map<string, number>();
    return items.map((item) => {
      const prefix = { commit: 'c', release: 'r', directory: 'd', term: 't', newcomer: 'a' }[
        item.kind
      ];
      const count = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, count);
      return { id: `${prefix}${count}`, ...item };
    });
  });
}
