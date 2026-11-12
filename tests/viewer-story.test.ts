import assert from 'node:assert/strict';
import test from 'node:test';
import type { Era } from '../src/lib/schema';
import { chapterView } from '../src/viewer/story';
import { snapshotFixture } from './fixtures/snapshot';

const sha = 'a'.repeat(40);

function modelEra(shown: string, pullTitle?: string): Era {
  const base = snapshotFixture().eras[0];
  return {
    ...base,
    narration: 'model',
    title: 'Add the Fiber reconciler',
    headline: 'c1',
    beats: [
      { kind: 'commit', ref: 'c1', sha: sha.slice(0, 9), date: '2022-01-01', subject: shown },
    ],
    sheet: [
      {
        id: 'c1',
        kind: 'commit',
        text: pullTitle ? `${pullTitle} (#6690)` : shown,
        title: pullTitle,
        time: 1,
        commits: [sha],
      },
    ],
  };
}

test('a chapter with a GitHub pull request line names that line as the pull request title', () => {
  const era = modelEra('Merge pull request #6690 from acdlite/fiber', 'Add the Fiber reconciler');
  const note = chapterView(era).note ?? '';
  assert.match(note, /GitHub Merge pull request line, which shows the pull request title/);
});

test('a chapter without a GitHub pull request line says every line is the commit subject', () => {
  const era = modelEra('Auto merge of #12345 - user:branch, r=reviewer');
  const note = chapterView(era).note ?? '';
  assert.match(note, /Each line is the commit's own subject\./);
  assert.doesNotMatch(note, /pull request title/);
});
