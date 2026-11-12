import { parseSnapshot } from '../lib/snapshot';
import { z } from 'zod';
import { DEFAULT_LAYOUT } from '../lib/identity';
import {
  PIPELINE_VERSION,
  repositorySchema,
  snapshotIdSchema,
  type AnalysisLimits,
  type AnalysisProgress,
  type Repository,
  type Snapshot,
} from '../lib/schema';
import { extractHistory, gitBuffer } from './git';
import { buildGraph, selectTracks } from './graph';
import { layoutTracks, type Layout } from './layout';
import { segmentEras } from './eras';

export const defaultLimits: AnalysisLimits = {
  maxCommits: 200000,
  maxTracks: 300000,
  maxFiles: 60000,
  maxPairs: 5000000,
  maxEdges: 300000,
  maxPairsPerCommit: 256,
  layoutIterations: 120,
};
const limitsSchema = z.object({
  maxCommits: z.number().int().min(1).max(defaultLimits.maxCommits),
  maxTracks: z.number().int().min(1).max(defaultLimits.maxTracks),
  maxFiles: z.number().int().min(1).max(defaultLimits.maxFiles),
  maxPairs: z.number().int().min(0).max(defaultLimits.maxPairs),
  maxEdges: z.number().int().min(0).max(defaultLimits.maxEdges),
  maxPairsPerCommit: z.number().int().min(1).max(defaultLimits.maxPairsPerCommit),
  layoutIterations: z.number().int().min(0).max(500),
});
export type AnalyzeOptions = {
  repository: Repository;
  directory: string;
  snapshotId: string;
  limits?: Partial<AnalysisLimits>;
  layout?: Layout;
  onProgress?: (progress: AnalysisProgress) => void;
};

export async function analyzeRepository(options: AnalyzeOptions): Promise<Snapshot> {
  const repository = repositorySchema.parse(options.repository);
  const snapshotId = snapshotIdSchema.parse(options.snapshotId);
  const limits = limitsSchema.parse({ ...defaultLimits, ...options.limits });
  const actual = (
    await gitBuffer(options.directory, ['rev-parse', '--verify', `${repository.head}^{commit}`])
  )
    .toString()
    .trim();
  if (actual !== repository.head)
    throw new Error('Requested revision does not resolve to the pinned commit');
  const progress = options.onProgress ?? (() => {});
  progress({
    stage: 'history',
    detail: 'Reading complete first-parent integration history and file lifetimes',
  });
  let readCommits = 0;
  const history = await extractHistory({
    directory: options.directory,
    head: repository.head,
    maxCommits: limits.maxCommits,
    maxTracks: limits.maxTracks,
    onTree: () => {
      readCommits++;
      if (readCommits % 2000 === 0)
        progress({ stage: 'history', detail: `Read ${readCommits} complete integration commits` });
    },
  });
  const selected = selectTracks(history.tracks, limits.maxFiles);
  const layout = options.layout ?? DEFAULT_LAYOUT;
  const graph = buildGraph(history, selected, limits);
  progress({
    stage: 'layout',
    detail: `Laying out ${selected.length} file identities and ${graph.edges.length} sampled co-change edges`,
  });
  const { files, directories } = await layoutTracks(
    selected,
    graph.edges,
    layout,
    limits.layoutIterations,
  );
  progress({
    stage: 'eras',
    detail:
      'Segmenting monthly directory, creation, and contributor activity with ordered tag anchors',
  });
  const eras = segmentEras(history, files);
  const first = history.commits[0];
  const last = history.commits.at(-1);
  if (!last) throw new Error('Repository has no commits');
  const overview = `${repository.slug} has ${history.commits.length.toLocaleString('en-US')} first-parent integration commits and ${history.tracks.length.toLocaleString('en-US')} file identities in this revision. ${files.length.toLocaleString('en-US')} file identities are displayed. Exact unambiguous moves preserve identity; edited or ambiguous moves can appear as removal and creation. Co-change excludes bulk commits and recognized bots${graph.coverage.graphSampled ? ' and uses bounded seeded sampling' : ''}.${layout === 'spectral' && selected.length > 2048 ? ' Spectral layout uses at most 2,048 deterministic landmarks, a coarsened co-change graph, and neighbor interpolation with directory priors for the remaining files.' : ''}`;
  return parseSnapshot({
    schemaVersion: 1,
    pipelineVersion: PIPELINE_VERSION,
    id: snapshotId,
    repository,
    generatedAt: new Date().toISOString(),
    startTime: first.time,
    endTime: last.time,
    overview,
    coverage: graph.coverage,
    authors: history.authors,
    eras,
    directories,
    files,
    commits: history.commits,
  });
}
