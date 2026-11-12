import { snapshotIdFor } from '../../src/lib/identity';
import { PIPELINE_VERSION, type Fact, type Snapshot } from '../../src/lib/schema';

const sha = 'a'.repeat(40);
export function snapshotFixture(): Snapshot {
  const repository = {
    owner: 'owner',
    name: 'repo',
    slug: 'owner/repo',
    head: sha,
    branch: 'main',
    description: 'A repository',
    stars: 1,
  };
  const fact: Fact = { id: 'f1', kind: 'created', text: 'One file was created.', commits: [sha] };
  return {
    schemaVersion: 1,
    pipelineVersion: PIPELINE_VERSION,
    id: snapshotIdFor(repository),
    repository,
    generatedAt: '2026-11-03T00:00:00.000Z',
    startTime: 1,
    endTime: 1,
    overview: fact.text,
    coverage: {
      scope: 'first-parent',
      totalCommits: 1,
      analyzedCommits: 1,
      totalFiles: 1,
      displayedFiles: 1,
      eligibleGraphCommits: 1,
      selectedGraphCommits: 1,
      pairUpdates: 0,
      edges: 0,
      graphSampled: false,
      filesSampled: false,
      exactRenamesOnly: true,
    },
    authors: [{ kind: 'anonymous', id: 0, label: 'Contributor 1' }],
    commits: [
      {
        sha,
        time: 1,
        authoredAt: 1,
        subject: 'Initial commit',
        author: 0,
        files: 1,
        created: 1,
        deleted: 0,
        merge: false,
        bulk: false,
      },
    ],
    files: [
      {
        id: 0,
        path: 'readme.md',
        kind: 'file',
        born: 0,
        died: null,
        paths: [[0, 'readme.md']],
        touches: [0],
        authors: [{ id: 0, touches: 1 }],
        position: [0, 0, 0],
        directory: '',
      },
    ],
    directories: [{ path: '', files: 1, centroid: [0, 0, 0], color: '#ff6953' }],
    eras: [
      {
        id: 0,
        start: 0,
        end: 1,
        startTime: 1,
        endTime: 1,
        title: 'The first chapter',
        beats: [{ kind: 'fact', ref: fact.id, text: fact.text }],
        narration: 'facts',
        facts: [fact],
        sheet: [],
        directories: [],
        created: 1,
        deleted: 0,
        contributors: 1,
        centroid: [0, 0, 0],
      },
    ],
  };
}
