import type { Era, Fact, FileTrack } from '../lib/schema';
import type { History, Track } from './git';
import { factSheets, subjectTerms } from './sheet';
import { factualNarration } from '../lib/grounding';

function month(time: number): number {
  const date = new Date(time * 1000);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}
function directory(path: string): string {
  return path.includes('/') ? path.slice(0, path.indexOf('/')) : '.';
}
function prefixes(path: string): string[] {
  const parts = path.split('/').slice(0, -1);
  return parts.slice(0, 2).map((_, depth) => parts.slice(0, depth + 1).join('/'));
}

type MonthlyActivity = {
  month: number;
  start: number;
  commits: number;
  terms: Map<string, number>;
};
type Shape = { commits: number; burst: number; months: number };

const MAX_ERAS = 10;
const SHARE = 0.02;
const MONTHS = 6;
const LONGEST = 72;
const NEW_FILES = 10;
const WINDOW = 6;
const LASTING = 24;
const SPAN = 12;

export function monthlyActivity(history: History): MonthlyActivity[] {
  const { commits, authors } = history;
  const human = (tick: number) => authors[commits[tick].author].kind !== 'bot';
  const rows = new Map<number, MonthlyActivity>();
  commits.forEach((commit, tick) => {
    const key = month(commit.time);
    if (human(tick) && !rows.has(key))
      rows.set(key, {
        month: key,
        start: tick,
        commits: 0,
        terms: new Map(),
      });
  });
  commits.forEach((commit, tick) => {
    const group = rows.get(month(commit.time));
    if (!group) return;
    group.start = Math.min(group.start, tick);
    if (!human(tick)) return;
    group.commits++;
    for (const term of subjectTerms(
      `${commit.subject} ${history.titles?.get(commit.sha) ?? ''}`,
    ).keys())
      group.terms.set(term, (group.terms.get(term) ?? 0) + 1);
  });
  return [...rows.values()];
}

export function turns(history: History, months: MonthlyActivity[]): number[] {
  const { commits, tracks } = history;
  const rows = new Map(months.map((group, index) => [group.month, index]));
  const strength = months.map(() => 0);
  const until = (index: number, length: number) => {
    let end = index;
    while (end < months.length && months[end].month < months[index].month + length) end++;
    return end;
  };
  const cumulative = [0];
  for (const group of months) cumulative.push(cumulative[cumulative.length - 1] + group.commits);
  const between = (from: number, to: number) => cumulative[to] - cumulative[from];
  const human = (tick: number) => history.authors[commits[tick].author].kind !== 'bot';
  const born = new Map<string, Track[]>();
  for (const track of tracks)
    for (const key of prefixes(track.paths[0][1])) {
      const list = born.get(key) ?? [];
      list.push(track);
      born.set(key, list);
    }
  for (const list of born.values()) {
    const created = list.reduce((a, b) => Math.min(a, b.born), Infinity);
    const from = month(commits[created].time);
    const index = rows.get(from);
    const lasting = list.some(
      (track) => track.died === null || month(commits[track.died].time) - from >= LASTING,
    );
    if (
      !index ||
      !lasting ||
      list.filter((track) => month(commits[track.born].time) - from < WINDOW).length < NEW_FILES
    )
      continue;
    const end = until(index, SPAN);
    const last = months[end]?.start ?? commits.length;
    const touched = new Set<number>();
    for (const track of list)
      for (const tick of track.touches)
        if (tick >= months[index].start && tick < last && human(tick)) touched.add(tick);
    strength[index] = Math.max(strength[index], touched.size / between(index, end));
  }
  const total = months.reduce((sum, group) => sum + group.commits, 0);
  const floor = Math.max(8, total * 0.002);
  const counts = new Map<string, number>();
  for (const group of months)
    for (const [term, count] of group.terms) counts.set(term, (counts.get(term) ?? 0) + count);
  const last = months[months.length - 1].month;
  const sum = (term: string, from: number, to: number) => {
    let value = 0;
    for (let row = from; row < to; row++) value += months[row].terms.get(term) ?? 0;
    return value;
  };
  const rate = (term: string, index: number) => {
    const end = until(index, SPAN);
    return sum(term, index, end) / between(index, end);
  };
  for (const [term, count] of counts) {
    if (count < floor) continue;
    for (
      let index = 1, before = months[0].terms.get(term) ?? 0, prior = months[0].commits;
      index < months.length;
      index++
    ) {
      const group = months[index];
      const end = until(index, WINDOW);
      const inside = sum(term, index, end);
      const recent = between(index, end);
      if (
        group.terms.has(term) &&
        inside >= floor &&
        before * 2 < inside &&
        inside * prior >= 4 * before * recent
      ) {
        const later = sum(term, until(index, LASTING / 2), until(index, LASTING));
        if (last < group.month + LASTING || later * 4 >= inside)
          strength[index] = Math.max(strength[index], rate(term, index) - before / prior);
        break;
      }
      before += group.terms.get(term) ?? 0;
      prior += group.commits;
    }
  }
  return strength;
}

function eraShape(months: MonthlyActivity[]): Shape {
  const total = months.reduce((sum, group) => sum + group.commits, 0);
  return {
    commits: Math.ceil(total * SHARE),
    burst: Math.ceil(total / MAX_ERAS),
    months: Math.max(LONGEST, Math.ceil(months.length / MAX_ERAS)),
  };
}
const fitsShape = (shape: Shape, months: number, commits: number) =>
  commits >= shape.commits &&
  months <= shape.months &&
  (months >= MONTHS || commits >= shape.burst);

function eraBoundaries(history: History, months: MonthlyActivity[], shape: Shape): number[] {
  const commitCount = history.commits.length;
  if (months.length < MONTHS) return [0, commitCount];
  const strength = turns(history, months);
  const weights = new Float64Array(months.length + 1);
  for (let i = 0; i < months.length; i++) weights[i + 1] = weights[i] + months[i].commits;
  const fits = (start: number, end: number) =>
    fitsShape(shape, end - start, weights[end] - weights[start]);
  const values = Array.from({ length: MAX_ERAS + 1 }, () =>
    new Float64Array(months.length + 1).fill(-Infinity),
  );
  const previous = Array.from({ length: MAX_ERAS + 1 }, () =>
    new Int32Array(months.length + 1).fill(-1),
  );
  values[0][0] = 0;
  for (let count = 1; count <= MAX_ERAS; count++)
    for (let end = count; end <= months.length; end++)
      for (let start = count - 1; start < end; start++) {
        if (!fits(start, end) || values[count - 1][start] === -Infinity) continue;
        // A month without a turn may start an era only when the shape leaves no other way.
        const value = values[count - 1][start] + (start ? strength[start] || -1 : 0);
        if (value > values[count][end]) {
          values[count][end] = value;
          previous[count][end] = start;
        }
      }
  let best = 0;
  for (let count = 1; count <= MAX_ERAS; count++)
    if (values[count][months.length] > (best ? values[best][months.length] : -Infinity))
      best = count;
  if (!best) return [0, commitCount];
  const ticks = [0, ...months.slice(1).map((group) => group.start), commitCount];
  const boundaries = [commitCount];
  let end = months.length;
  for (let count = best; count > 0; count--) {
    end = previous[count][end];
    boundaries.push(ticks[end]);
  }
  return boundaries.reverse();
}

export function segmentEras(history: History, files: FileTrack[]): Era[] {
  const { commits, tracks } = history;
  if (!commits.length) return [];
  const months = monthlyActivity(history);
  const commitIndex = new Map(commits.map((commit, index) => [commit.sha, index]));
  const tags = history.tags
    .flatMap((tag) => {
      const tick = commitIndex.get(tag.sha);
      return tick === undefined ? [] : [{ ...tag, tick }];
    })
    .sort((a, b) => a.tick - b.tick || a.name.localeCompare(b.name, 'en'));
  const shape = eraShape(months);
  const boundaries = eraBoundaries(history, months, shape);
  const row = new Int32Array(commits.length);
  const humans = new Int32Array(commits.length + 1);
  for (let tick = 0, index = 0; tick < commits.length; tick++) {
    while (index + 1 < months.length && months[index + 1].start <= tick) index++;
    row[tick] = index;
    humans[tick + 1] =
      humans[tick] + (history.authors[commits[tick].author].kind === 'bot' ? 0 : 1);
  }
  const fits = (start: number, end: number) =>
    fitsShape(shape, row[end - 1] - row[start] + 1, humans[end] - humans[start]);
  for (let index = 1; index < boundaries.length - 1; index++) {
    const current = boundaries[index];
    const candidate = tags
      .filter((tag) => Math.abs(month(commits[tag.tick].time) - month(commits[current].time)) <= 1)
      .sort((a, b) => Math.abs(a.tick - current) - Math.abs(b.tick - current) || a.tick - b.tick)
      .find(
        (tag) =>
          tag.tick > boundaries[index - 1] &&
          tag.tick < boundaries[index + 1] &&
          fits(boundaries[index - 1], tag.tick) &&
          fits(tag.tick, boundaries[index + 1]),
      );
    if (candidate) boundaries[index] = candidate.tick;
  }
  const positions = new Map(files.map((file) => [file.id, file.position]));
  const sheets = factSheets(history, boundaries, tags);
  return boundaries.slice(0, -1).map((start, id): Era => {
    const end = boundaries[id + 1];
    const slice = commits
      .slice(start, end)
      .filter((commit) => history.authors[commit.author].kind !== 'bot');
    const evidence = [...new Set([commits[start].sha, commits[end - 1].sha])];
    const last = commits[end - 1];
    const created = slice.reduce((sum, commit) => sum + commit.created, 0);
    const deleted = slice.reduce((sum, commit) => sum + commit.deleted, 0);
    const contributors = new Set(history.credits.slice(start, end).flat()).size;
    const center: [number, number, number] = [0, 0, 0];
    let positionedTouches = 0;
    const directoryTouches = new Map<string, number>();
    const directoryEvidence = new Map<string, string[]>();
    for (const track of tracks) {
      let interval = 0;
      for (const tick of track.touches) {
        if (tick < start || tick >= end || history.authors[commits[tick].author].kind === 'bot')
          continue;
        const position = positions.get(track.id);
        if (position) {
          positionedTouches++;
          for (let axis = 0; axis < 3; axis++) center[axis] += position[axis];
        }
        while (interval + 1 < track.paths.length && track.paths[interval + 1][0] <= tick)
          interval++;
        const path = directory(track.paths[interval][1]);
        directoryTouches.set(path, (directoryTouches.get(path) ?? 0) + 1);
        const supporting = directoryEvidence.get(path) ?? [];
        if (supporting.length < 3 && !supporting.includes(commits[tick].sha))
          supporting.push(commits[tick].sha);
        directoryEvidence.set(path, supporting);
      }
    }
    const directories = [...directoryTouches]
      .map(([path, touches]) => ({ path, touches }))
      .sort((a, b) => b.touches - a.touches || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .slice(0, 5);
    const facts: Fact[] = [
      {
        id: `era-${id}-activity`,
        kind: 'activity',
        text: `${slice.length.toLocaleString('en-US')} first-parent integration commits by non-bot authors.`,
        commits: evidence,
      },
      {
        id: `era-${id}-created`,
        kind: 'created',
        text: `${created.toLocaleString('en-US')} file identities created and ${deleted.toLocaleString('en-US')} removed by non-bot authors.`,
        commits: [
          ...new Set([
            slice.find((commit) => commit.created > 0)?.sha ?? evidence[0],
            slice.find((commit) => commit.deleted > 0)?.sha ?? evidence[0],
          ]),
        ],
      },
      {
        id: `era-${id}-contributors`,
        kind: 'contributors',
        text: `${contributors.toLocaleString('en-US')} non-bot contributors, counting the authors of merged branches and pull requests.`,
        commits: evidence,
      },
    ];
    const busiest = directories[0];
    if (busiest)
      facts.push({
        id: `era-${id}-directory`,
        kind: 'directory',
        text: `${busiest.path === '.' ? 'Root files' : `The ${busiest.path} directory`} recorded ${busiest.touches.toLocaleString('en-US')} file touches.`,
        commits: directoryEvidence.get(busiest.path) ?? evidence,
      });
    const releases = tags.filter((tag) => tag.tick >= start && tag.tick < end);
    for (const tag of releases.slice(0, 6))
      facts.push({
        id: `era-${id}-release-${tag.tick}-${tag.name}`,
        kind: 'release',
        text: `The ${tag.name} tag points to an integration commit in this chapter.`,
        commits: [tag.sha],
      });
    return {
      id,
      start,
      end,
      startTime: commits[start].time,
      endTime: last.time,
      ...factualNarration({
        id,
        facts,
        startTime: commits[start].time,
        endTime: last.time,
        sheet: sheets[id],
      }),
      narration: 'facts',
      facts,
      sheet: sheets[id],
      directories,
      created,
      deleted,
      contributors,
      centroid: [
        center[0] / Math.max(1, positionedTouches),
        center[1] / Math.max(1, positionedTouches),
        center[2] / Math.max(1, positionedTouches),
      ],
    };
  });
}
