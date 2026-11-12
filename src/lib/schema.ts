import { z } from 'zod';
import { factualNarration, LIMITS } from './grounding';

export const PIPELINE_VERSION = 'lore-4';

export const repositorySlugSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/);
export const shaSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
export const snapshotIdSchema = z.string().regex(/^[a-f0-9]{24}$/);
const tickSchema = z.number().int().nonnegative();
const pointSchema = z.tuple([z.number(), z.number(), z.number()]);

export const repositorySchema = z.object({
  owner: z.string(),
  name: z.string(),
  slug: repositorySlugSchema,
  description: z.string(),
  branch: z.string(),
  head: shaSchema,
  stars: z.number().int().nonnegative(),
});

export const authorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('github'), id: tickSchema, handle: z.string() }),
  z.object({ kind: z.literal('anonymous'), id: tickSchema, label: z.string() }),
  z.object({ kind: z.literal('bot'), id: tickSchema, label: z.string() }),
]);

export const commitSchema = z.object({
  sha: shaSchema,
  time: z.number().int(),
  authoredAt: z.number().int(),
  subject: z.string(),
  mergeTitle: z.string().optional(),
  author: tickSchema,
  files: tickSchema,
  created: tickSchema,
  deleted: tickSchema,
  merge: z.boolean(),
  bulk: z.boolean(),
});

export const fileTrackSchema = z.object({
  id: tickSchema,
  path: z.string(),
  kind: z.enum(['file', 'symlink', 'submodule']),
  born: tickSchema,
  died: tickSchema.nullable(),
  paths: z.array(z.tuple([tickSchema, z.string()])).min(1),
  touches: z.array(tickSchema),
  authors: z.array(z.object({ id: tickSchema, touches: tickSchema })),
  position: pointSchema,
  directory: z.string(),
});

export const factSchema = z.object({
  id: z.string(),
  kind: z.enum(['activity', 'created', 'deleted', 'directory', 'release', 'contributors']),
  text: z.string(),
  commits: z.array(shaSchema).min(1),
});

export const sheetItemSchema = z.object({
  id: z.string().regex(/^[a-z]\d{1,3}$/),
  kind: z.enum(['commit', 'release', 'directory', 'term', 'newcomer']),
  text: z.string().min(1),
  title: z.string().optional(),
  time: z.number().int().optional(),
  commits: z.array(shaSchema).min(1).max(3),
});

export const commitBeatSchema = z.object({
  kind: z.literal('commit'),
  ref: z.string().min(1),
  sha: z.string().regex(/^[a-f0-9]{7,9}$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  subject: z.string().min(1),
});

export const factBeatSchema = z.object({
  kind: z.literal('fact'),
  ref: z.string().min(1),
  text: z.string().min(1),
});

export const beatSchema = z.discriminatedUnion('kind', [commitBeatSchema, factBeatSchema]);

const eraBase = z.object({
  id: tickSchema,
  start: tickSchema,
  end: z.number().int().positive(),
  startTime: z.number().int(),
  endTime: z.number().int(),
  facts: z.array(factSchema),
  directories: z.array(z.object({ path: z.string(), touches: tickSchema })),
  created: tickSchema,
  deleted: tickSchema,
  contributors: tickSchema,
  centroid: pointSchema,
});

const currentEraSchema = eraBase.extend({
  title: z.string().min(1).max(LIMITS.title),
  headline: z.string().min(1).optional(),
  beats: z.array(beatSchema).max(LIMITS.beats[1]),
  narration: z.enum(['facts', 'model', 'reviewed']),
  sheet: z.array(sheetItemSchema),
});

const legacyEraSchema = eraBase
  .extend({
    title: z.string(),
    titleOptions: z.array(z.string()).min(1),
    summary: z.string(),
    narration: z.enum(['facts', 'model-selected', 'reviewed']),
    claims: z.array(
      z.object({ text: z.string(), factId: z.string(), commits: z.array(shaSchema).min(1) }),
    ),
  })
  .transform((legacy): z.infer<typeof currentEraSchema> => ({
    ...eraBase.parse(legacy),
    title:
      legacy.title.length <= LIMITS.title
        ? legacy.title
        : factualNarration({
            id: legacy.id,
            facts: [],
            startTime: legacy.startTime,
            endTime: legacy.endTime,
          }).title,
    beats: legacy.claims.map((claim) => ({
      kind: 'fact' as const,
      ref: claim.factId,
      text: claim.text,
    })),
    narration: 'facts',
    sheet: [],
  }));

const storedBeatSchema = z.object({
  text: z.string(),
  refs: z.array(z.string()).min(1),
});

const storedEraSchema = eraBase
  .extend({
    title: z.string(),
    beats: z.array(storedBeatSchema),
    narration: z.enum(['facts', 'model', 'model-selected', 'reviewed']),
    sheet: z.array(sheetItemSchema),
  })
  .transform((stored): z.infer<typeof currentEraSchema> => {
    const era = eraBase.parse(stored);
    return {
      ...era,
      ...factualNarration({
        id: stored.id,
        facts: stored.facts,
        startTime: stored.startTime,
        endTime: stored.endTime,
        sheet: stored.sheet,
      }),
      narration: 'facts',
      sheet: stored.sheet,
    };
  });

export const eraSchema = z.union([currentEraSchema, storedEraSchema, legacyEraSchema]);

export const directorySchema = z.object({
  path: z.string(),
  files: tickSchema,
  centroid: pointSchema,
  color: z.string().regex(/^#[a-fA-F0-9]{6}$/),
});

export const coverageSchema = z.object({
  scope: z.literal('first-parent'),
  totalCommits: tickSchema,
  analyzedCommits: tickSchema,
  totalFiles: tickSchema,
  displayedFiles: tickSchema,
  eligibleGraphCommits: tickSchema,
  selectedGraphCommits: tickSchema,
  pairUpdates: tickSchema,
  edges: tickSchema,
  graphSampled: z.boolean(),
  filesSampled: z.boolean(),
  exactRenamesOnly: z.literal(true),
});

export const snapshotMetaSchema = z.object({
  schemaVersion: z.literal(1),
  pipelineVersion: z.string(),
  id: snapshotIdSchema,
  repository: repositorySchema,
  generatedAt: z.string(),
  startTime: z.number().int(),
  endTime: z.number().int(),
  overview: z.string(),
  coverage: coverageSchema,
  authors: z.array(authorSchema),
  eras: z.array(eraSchema).min(1),
  directories: z.array(directorySchema),
});

export const snapshotSchema = snapshotMetaSchema.extend({
  files: z.array(fileTrackSchema),
  commits: z.array(commitSchema).min(1),
});

export const manifestSchema = snapshotMetaSchema.extend({
  artifact: z.object({ pathname: z.string(), sha256: z.string(), bytes: tickSchema }),
});

const jobBase = z.object({
  id: snapshotIdSchema,
  slug: repositorySlugSchema,
  updatedAt: z.string(),
});

export const jobSchema = z.discriminatedUnion('state', [
  jobBase.extend({ state: z.literal('queued') }),
  jobBase.extend({
    state: z.literal('running'),
    stage: z.enum(['resolve', 'clone', 'history', 'layout', 'eras', 'narrate', 'store']),
    detail: z.string(),
  }),
  jobBase.extend({ state: z.literal('ready'), snapshotId: snapshotIdSchema }),
  jobBase.extend({ state: z.literal('failed'), message: z.string(), retryable: z.boolean() }),
]);

export type Repository = z.infer<typeof repositorySchema>;
export type Author = z.infer<typeof authorSchema>;
export type Commit = z.infer<typeof commitSchema>;
export type FileTrack = z.infer<typeof fileTrackSchema>;
export type Fact = z.infer<typeof factSchema>;
export type Era = z.infer<typeof eraSchema>;
export type SheetItem = z.infer<typeof sheetItemSchema>;
export type Beat = z.infer<typeof beatSchema>;
export type Directory = z.infer<typeof directorySchema>;
export type Coverage = z.infer<typeof coverageSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type SnapshotMeta = z.infer<typeof snapshotMetaSchema>;
export type Manifest = z.infer<typeof manifestSchema>;
export type Job = z.infer<typeof jobSchema>;

export type Submission =
  | { kind: 'ready'; slug: string; snapshotId: string }
  | { kind: 'queued'; slug: string; jobId: string };

export type AnalysisProgress = { stage: 'clone' | 'history' | 'layout' | 'eras'; detail: string };

export type AnalysisLimits = {
  maxCommits: number;
  maxTracks: number;
  maxFiles: number;
  maxPairs: number;
  maxEdges: number;
  maxPairsPerCommit: number;
  layoutIterations: number;
};
