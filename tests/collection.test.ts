import assert from 'node:assert/strict';
import test from 'node:test';
import { summary, years } from '../src/lib/collection';
import type { Manifest } from '../src/lib/schema';
import { snapshotFixture } from './fixtures/snapshot';

function base(): Manifest {
  return {
    ...snapshotFixture(),
    artifact: { pathname: 'fixture.json', sha256: '0'.repeat(64), bytes: 0 },
  };
}

function manifest(description: string, chapters: number, commits: number): Manifest {
  const value = base();
  return {
    ...value,
    repository: { ...value.repository, description },
    eras: Array.from({ length: chapters }, (_, id) => ({ ...value.eras[0], id })),
    coverage: { ...value.coverage, totalCommits: commits },
  };
}

test('the collection summary uses the repository description when it has one', () => {
  assert.equal(summary(manifest('A repository', 4, 15005)), 'A repository');
});

test('the collection summary strips pictographs from the gallery descriptions', () => {
  assert.equal(
    summary(
      manifest(
        '🖖 Vue.js is a progressive, incrementally-adoptable JavaScript framework for building UI on the web.',
        4,
        15005,
      ),
    ),
    'Vue.js is a progressive, incrementally-adoptable JavaScript framework for building UI on the web.',
  );
  assert.equal(
    summary(manifest('Node.js JavaScript runtime ✨🐢🚀✨', 4, 15005)),
    'Node.js JavaScript runtime',
  );
  assert.equal(
    summary(
      manifest(
        '🚀 Personal website / blog / portfolio built using TypeScript, Next.js, Tailwind CSS and Notion API',
        4,
        15005,
      ),
    ),
    'Personal website / blog / portfolio built using TypeScript, Next.js, Tailwind CSS and Notion API',
  );
});

test('the collection summary strips joiners and variation selectors', () => {
  assert.equal(summary(manifest('A 👩‍💻 team ❤️', 4, 15005)), 'A team');
});

test('the collection summary falls back to chapter and commit counts', () => {
  assert.equal(summary(manifest('', 10, 15005)), '10 chapters · 15,005 commits');
  assert.equal(summary(manifest('   ', 1, 1)), '1 chapter · 1 commit');
});

test('the collection years collapse a single year and span the rest', () => {
  const value = base();
  assert.equal(
    years({
      ...value,
      startTime: Date.UTC(2026, 0, 1) / 1000,
      endTime: Date.UTC(2026, 11, 1) / 1000,
    }),
    '2026',
  );
  assert.equal(
    years({
      ...value,
      startTime: Date.UTC(2013, 0, 1) / 1000,
      endTime: Date.UTC(2026, 11, 1) / 1000,
    }),
    '2013–2026',
  );
});
