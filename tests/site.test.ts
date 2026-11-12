import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SnapshotMeta } from '../src/lib/schema';

const meta = {
  schemaVersion: 1,
  pipelineVersion: 'lore-4',
  id: '0123456789abcdef01234567',
  repository: {
    owner: 'react',
    name: 'react',
    slug: 'react/react',
    branch: 'main',
    head: 'a'.repeat(40),
  },
  generatedAt: '2026-01-01T00:00:00.000Z',
  startTime: 0,
  endTime: 1,
  overview: '',
  coverage: {
    scope: 'first-parent',
    totalCommits: 1,
    analyzedCommits: 1,
    totalFiles: 1,
    displayedFiles: 1,
    eligibleGraphCommits: 1,
    selectedGraphCommits: 1,
    pairUpdates: 1,
    edges: 1,
    graphSampled: false,
    filesSampled: false,
    exactRenamesOnly: true,
  },
  authors: [],
  eras: [
    {
      id: 0,
      start: 0,
      end: 1,
      startTime: 0,
      endTime: 1,
      title: 'Chapter 1',
      narration: 'facts',
      headline: 'c1',
      beats: [
        { kind: 'commit', ref: 'c1', sha: 'a'.repeat(40), date: '2026-01-01', subject: 'First' },
      ],
      facts: [],
      directories: [],
      created: 0,
      deleted: 0,
      contributors: 0,
      centroid: [0, 0, 0],
      sheet: [],
    },
  ],
  directories: [{ path: 'src', files: 1, centroid: [0, 0, 0], color: '#ffffff' }],
} as unknown as SnapshotMeta;

test('the share image renders the site host', async () => {
  const saved = [process.env.NEXT_PUBLIC_SITE_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL];
  delete process.env.NEXT_PUBLIC_SITE_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  try {
    const { siteHost } = await import('../src/lib/site');
    const { stillImage } = await import('../src/server/still');
    const html = renderToStaticMarkup(stillImage(meta, 0));
    assert.equal(siteHost, 'localhost:3000');
    assert.match(html, /localhost:3000/);
    assert.doesNotMatch(html, /loreof\.dev/);
  } finally {
    if (saved[0] === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = saved[0];
    if (saved[1] === undefined) delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    else process.env.VERCEL_PROJECT_PRODUCTION_URL = saved[1];
  }
});
