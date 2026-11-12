import type { AnalysisLimits, Coverage } from '../lib/schema';
import type { History, Track } from './git';

export type Edge = { source: number; target: number; weight: number };
export function randomSource(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
export function hash(text: string): number {
  let result = 2166136261;
  for (let i = 0; i < text.length; i++) result = Math.imul(result ^ text.charCodeAt(i), 16777619);
  return result >>> 0;
}

export function selectTracks(tracks: Track[], maxFiles: number): Track[] {
  return [...tracks]
    .sort(
      (a, b) =>
        Number(b.died === null) - Number(a.died === null) ||
        b.touches.length - a.touches.length ||
        a.id - b.id,
    )
    .slice(0, maxFiles)
    .sort((a, b) => a.id - b.id);
}

function pairAt(rank: number, size: number): [number, number] {
  let low = 0;
  let high = size - 1;
  while (low + 1 < high) {
    const mid = (low + high) >>> 1;
    const offset = (mid * (2 * size - mid - 1)) / 2;
    if (offset <= rank) low = mid;
    else high = mid;
  }
  return [low, low + 1 + rank - (low * (2 * size - low - 1)) / 2];
}

export function buildGraph(
  history: History,
  selected: Track[],
  limits: AnalysisLimits,
): { edges: Edge[]; coverage: Coverage } {
  const touches: number[][] = history.commits.map(() => []);
  for (const track of selected) for (const tick of track.touches) touches[tick].push(track.id);
  const allEligible = history.commits.flatMap((commit, index) =>
    commit.files >= 2 && !commit.bulk && history.authors[commit.author].kind !== 'bot'
      ? [index]
      : [],
  );
  const eligible = allEligible.filter((index) => touches[index].length >= 2);
  const random = randomSource(hash(history.commits.at(-1)?.sha ?? 'lore'));
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
  }
  const accumulator = new Map<string, Edge>();
  let pairUpdates = 0;
  let selectedGraphCommits = 0;
  let sampled = eligible.length < allEligible.length;
  for (const tick of eligible) {
    if (pairUpdates >= limits.maxPairs) {
      sampled = true;
      break;
    }
    const ids = touches[tick];
    const total = (ids.length * (ids.length - 1)) / 2;
    const count = Math.min(total, limits.maxPairsPerCommit, limits.maxPairs - pairUpdates);
    if (count < total) sampled = true;
    const ranks = new Set<number>();
    for (let j = total - count; j < total; j++) {
      const candidate = Math.floor(random() * (j + 1));
      ranks.add(ranks.has(candidate) ? j : candidate);
    }
    selectedGraphCommits++;
    const weight = total / (count * (history.commits[tick].files - 1));
    for (const rank of ranks) {
      const [a, b] = pairAt(rank, ids.length);
      const source = ids[a];
      const target = ids[b];
      const key = `${source}:${target}`;
      const edge = accumulator.get(key);
      if (edge) edge.weight += weight;
      else if (accumulator.size < limits.maxEdges) accumulator.set(key, { source, target, weight });
      else sampled = true;
      pairUpdates++;
    }
  }
  return {
    edges: [...accumulator.values()].sort((a, b) => a.source - b.source || a.target - b.target),
    coverage: {
      scope: 'first-parent',
      totalCommits: history.totalCommits,
      analyzedCommits: history.commits.length,
      totalFiles: history.tracks.length,
      displayedFiles: selected.length,
      eligibleGraphCommits: allEligible.length,
      selectedGraphCommits,
      pairUpdates,
      edges: accumulator.size,
      graphSampled: sampled,
      filesSampled: selected.length < history.tracks.length,
      exactRenamesOnly: true,
    },
  };
}
