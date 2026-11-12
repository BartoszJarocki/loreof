import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSnapshot } from '../src/lib/snapshot';
import { narrateEra, type NarrationModel } from '../src/server/narration';
import { applyReview, writeReview } from '../scripts/lib/review';
import { snapshotFixture } from './fixtures/snapshot';

const shas = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)];
const times = [1, 86401, 172801];
const date = (time: number) => new Date(time * 1000).toISOString().slice(0, 10);

function narratable() {
  const snapshot = snapshotFixture();
  const added = [
    { sha: shas[1], subject: 'Add the Fiber reconciler (#6690)' },
    { sha: shas[2], subject: 'Remove Stack (part 4)' },
  ];
  for (const [index, commit] of added.entries())
    snapshot.commits.push({
      ...snapshot.commits[0],
      sha: commit.sha,
      time: times[index + 1],
      authoredAt: times[index + 1],
      subject: commit.subject,
      created: 0,
      deleted: 0,
    });
  snapshot.endTime = times[2];
  snapshot.coverage = {
    ...snapshot.coverage,
    totalCommits: 3,
    analyzedCommits: 3,
    eligibleGraphCommits: 3,
    selectedGraphCommits: 3,
  };
  snapshot.eras[0] = {
    ...snapshot.eras[0],
    end: 3,
    endTime: times[2],
    sheet: [
      { id: 'c1', kind: 'commit', text: 'Initial commit', time: times[0], commits: [shas[0]] },
      {
        id: 'c2',
        kind: 'commit',
        text: 'Add the Fiber reconciler (#6690)',
        time: times[1],
        commits: [shas[1]],
      },
      {
        id: 'c3',
        kind: 'commit',
        text: 'Remove Stack (part 4)',
        time: times[2],
        commits: [shas[2]],
      },
      {
        id: 'd2',
        kind: 'directory',
        text: 'packages/fiber/ created',
        time: times[1],
        commits: [shas[1]],
      },
    ],
  };
  return snapshot;
}

const grounded = {
  commits: ['c1', 'c2', 'c3'],
  headline: 'c2',
};

const beats = grounded.commits.map((ref, index) => ({
  kind: 'commit' as const,
  ref,
  sha: shas[index].slice(0, 9),
  date: date(times[index]),
  subject: ['Initial commit', 'Add the Fiber reconciler (#6690)', 'Remove Stack (part 4)'][index],
}));

function scripted(outputs: unknown[]) {
  const prompts: string[] = [];
  const model: NarrationModel = async ({ prompt }) => {
    prompts.push(prompt);
    const output = outputs.shift();
    return output === 'denied' ? 'denied' : { output, cost: 0 };
  };
  return { model, prompts };
}

test('a grounded selection keeps its commits and derives the title from the headline', async () => {
  const snapshot = narratable();
  const { model, prompts } = scripted([grounded]);
  const era = await narrateEra(snapshot.eras[0], snapshot.repository, model);
  assert.equal(prompts.length, 1);
  assert.equal(era.narration, 'model');
  assert.equal(era.title, 'Add the Fiber reconciler');
  assert.equal(era.headline, 'c2');
  assert.deepEqual(era.beats, beats);
  assert.deepEqual(parseSnapshot({ ...snapshot, eras: [era] }).eras[0].beats, beats);
});

test('a cut headline yields to a selected commit whose title fits', async () => {
  const snapshot = narratable();
  const era = snapshot.eras[0];
  const long = 'A very long commit subject that keeps going past the sixty character limit';
  era.sheet.find((item) => item.id === 'c2')!.text = long;
  const { model } = scripted([grounded]);
  const result = await narrateEra(era, snapshot.repository, model);
  assert.equal(result.title, 'Initial commit');
  assert.equal(result.headline, 'c1');

  for (const item of era.sheet.filter((entry) => entry.kind === 'commit'))
    item.text = `A very long commit subject that keeps going past sixty characters (${item.id})`;
  const second = scripted([grounded]);
  const truncated = await narrateEra(era, snapshot.repository, second.model);
  assert.equal(truncated.headline, 'c2');
  assert.ok(truncated.title.endsWith('…'));
});

test('a selection outside the sheet is retried and then accepted', async () => {
  const snapshot = narratable();
  const first = { ...grounded, commits: ['c1', 'c2', 'missing'] };
  const { model, prompts } = scripted([first, grounded]);
  const era = await narrateEra(snapshot.eras[0], snapshot.repository, model);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /commits: missing is not a commit in this chapter/);
  assert.equal(era.narration, 'model');
  assert.deepEqual(era.beats, beats);
});

test('an invalid selection falls back to factual captions after one retry', async () => {
  const snapshot = narratable();
  const invented = { ...grounded, commits: ['c2', 'missing'] };
  const { model, prompts } = scripted([invented, invented]);
  const era = await narrateEra(snapshot.eras[0], snapshot.repository, model);
  assert.equal(prompts.length, 2);
  assert.equal(era.narration, 'facts');
  assert.equal(era.headline, undefined);
  assert.deepEqual(era.beats, [{ kind: 'fact', ref: 'f1', text: 'One file was created.' }]);
});

test('a repeated commit is rejected and retried without deduplicating', async () => {
  const snapshot = narratable();
  const repeated = { ...grounded, commits: ['c1', 'c1', 'c2'] };
  const { model, prompts } = scripted([repeated, grounded]);
  const era = await narrateEra(snapshot.eras[0], snapshot.repository, model);
  assert.match(prompts[1], /commits: duplicate/);
  assert.deepEqual(era.beats, beats);
});

test('more than four refs is rejected and never salvaged', async () => {
  const snapshot = narratable();
  snapshot.eras[0].sheet.push(
    { id: 'c4', kind: 'commit', text: 'Initial commit', time: times[0], commits: [shas[0]] },
    {
      id: 'c5',
      kind: 'commit',
      text: 'Add the Fiber reconciler (#6690)',
      time: times[1],
      commits: [shas[1]],
    },
  );
  const five = { commits: ['c1', 'c2', 'c3', 'c4', 'c5'], headline: 'c2' };
  const { model, prompts } = scripted([five, five]);
  const era = await narrateEra(snapshot.eras[0], snapshot.repository, model);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /commits: choose 2 to 4/);
  assert.equal(era.narration, 'facts');
});

test('a headline outside the selection is rejected and retried', async () => {
  const snapshot = narratable();
  const wrong = { ...grounded, headline: 'c3', commits: ['c1', 'c2'] };
  const { model, prompts } = scripted([wrong, wrong]);
  const era = await narrateEra(snapshot.eras[0], snapshot.repository, model);
  assert.match(prompts[1], /headline: not among the selected commits/);
  assert.equal(era.narration, 'facts');
});

test('a headline whose title is factual-shaped falls back to facts', async () => {
  const snapshot = narratable();
  snapshot.eras[0].sheet.push({
    id: 'c4',
    kind: 'commit',
    text: 'Chapter 2',
    time: times[2],
    commits: [shas[2]],
  });
  const factual = { commits: ['c1', 'c4'], headline: 'c4' };
  const { model } = scripted([factual, factual]);
  const era = await narrateEra(snapshot.eras[0], snapshot.repository, model);
  assert.equal(era.narration, 'facts');
});

test('an exhausted budget falls back to facts without a retry', async () => {
  const snapshot = narratable();
  const { model, prompts } = scripted(['denied', grounded]);
  const era = await narrateEra(snapshot.eras[0], snapshot.repository, model);
  assert.equal(prompts.length, 1);
  assert.equal(era.narration, 'facts');
});

test('without a model or a fact sheet the era keeps factual captions', async () => {
  const snapshot = narratable();
  const unchecked = await narrateEra(snapshot.eras[0], snapshot.repository, null);
  assert.equal(unchecked.title, 'Jan 1970 to Jan 1970');
  assert.deepEqual(unchecked.beats, snapshot.eras[0].beats);
  const bare = snapshotFixture().eras[0];
  const { model, prompts } = scripted([grounded]);
  const fallback = await narrateEra(bare, snapshot.repository, model);
  assert.equal(fallback.title, 'Jan 1970 to Jan 1970');
  assert.deepEqual(fallback.beats, bare.beats);
  assert.equal(prompts.length, 0);
});

test('a lore-2 era parses as factual captions', () => {
  const snapshot = snapshotFixture();
  const legacy = {
    ...snapshot,
    pipelineVersion: 'lore-2',
    eras: [
      {
        ...snapshot.eras[0],
        beats: undefined,
        sheet: undefined,
        title: '1 non-bot integration commits',
        titleOptions: ['The first chapter', '1 non-bot integration commits'],
        summary: 'One file was created.',
        narration: 'model-selected',
        claims: [{ text: 'One file was created.', factId: 'f1', commits: [shas[0]] }],
      },
    ],
  };
  const era = parseSnapshot(JSON.parse(JSON.stringify(legacy))).eras[0];
  assert.equal(era.narration, 'facts');
  assert.equal(era.title, '1 non-bot integration commits');
  assert.deepEqual(era.beats, [{ kind: 'fact', ref: 'f1', text: 'One file was created.' }]);
  assert.deepEqual(era.sheet, []);
});

test('a legacy era keeps its stored tag title without a fact sheet', () => {
  const snapshot = snapshotFixture();
  const legacy = {
    ...snapshot,
    pipelineVersion: 'lore-2',
    eras: [
      {
        ...snapshot.eras[0],
        beats: undefined,
        sheet: undefined,
        title: 'The vscode-typescript/v1.0.0 tag',
        titleOptions: ['The first chapter', 'The vscode-typescript/v1.0.0 tag'],
        summary: 'One file was created.',
        narration: 'model-selected',
        claims: [{ text: 'One file was created.', factId: 'f1', commits: [shas[0]] }],
      },
    ],
  };
  const era = parseSnapshot(JSON.parse(JSON.stringify(legacy))).eras[0];
  assert.equal(era.narration, 'facts');
  assert.equal(era.title, 'The vscode-typescript/v1.0.0 tag');
  assert.deepEqual(era.sheet, []);
});

test('review files carry commit lines and a headline; accepted edits can change both', () => {
  const snapshot = narratable();
  snapshot.eras[0] = {
    ...snapshot.eras[0],
    ...grounded,
    title: 'Add the Fiber reconciler',
    beats,
    narration: 'model',
  };
  const markdown = writeReview(snapshot);
  assert.match(markdown, /^headline: c2$/m);
  assert.match(markdown, /^- c2 bbbbbbbbb 1970-01-02 Add the Fiber reconciler \(#6690\)$/m);
  assert.deepEqual(applyReview(snapshot, markdown, 'review.md'), snapshot);
  const accepted = markdown.replace('status: draft', 'status: accepted');
  const reviewed = applyReview(snapshot, accepted, 'review.md');
  assert.equal(reviewed.eras[0].narration, 'reviewed');
  assert.deepEqual(reviewed.eras[0].beats, beats);

  const fewer = accepted.replace(/^- c3 .*\n/m, '');
  assert.deepEqual(
    applyReview(snapshot, fewer, 'review.md').eras[0].beats.map((beat) => beat.ref),
    ['c1', 'c2'],
  );
  const reheadlined = accepted
    .replace('headline: c2', 'headline: c1')
    .replace('title: Add the Fiber reconciler', 'title: Initial commit');
  assert.equal(applyReview(snapshot, reheadlined, 'review.md').eras[0].title, 'Initial commit');
});

test('a review edit that changes a title or a subject is rejected', () => {
  const snapshot = narratable();
  snapshot.eras[0] = {
    ...snapshot.eras[0],
    ...grounded,
    title: 'Add the Fiber reconciler',
    beats,
    narration: 'model',
  };
  const retitled = writeReview(snapshot)
    .replace('status: draft', 'status: accepted')
    .replace('title: Add the Fiber reconciler', 'title: Initial commit');
  assert.throws(() => applyReview(snapshot, retitled, 'review.md'), /does not match its headline/);
  const resubjected = writeReview(snapshot)
    .replace('status: draft', 'status: accepted')
    .replace(
      '- c2 bbbbbbbbb 1970-01-02 Add the Fiber reconciler (#6690)',
      '- c2 bbbbbbbbb 1970-01-02 Dan Abramov adds the Fiber reconciler',
    );
  assert.throws(() => applyReview(snapshot, resubjected, 'review.md'), /does not match its commit/);
});

test('an unreadable commit line in an accepted chapter fails instead of being dropped', () => {
  const snapshot = narratable();
  snapshot.eras[0] = {
    ...snapshot.eras[0],
    ...grounded,
    title: 'Add the Fiber reconciler',
    beats,
    narration: 'model',
  };
  const accepted = writeReview(snapshot)
    .replace('status: draft', 'status: accepted')
    .replace('- c2 bbbbbbbbb', '- c2 BBBBBBBBB');
  assert.throws(() => applyReview(snapshot, accepted, 'review.md'), /unreadable commit line/);
});

test('beats are sorted by commit date', async () => {
  const snapshot = narratable();
  const reordered = { ...grounded, commits: ['c3', 'c1', 'c2'] };
  const { model } = scripted([reordered]);
  const era = await narrateEra(snapshot.eras[0], snapshot.repository, model);
  assert.deepEqual(
    era.beats.map((beat) => beat.ref),
    ['c1', 'c2', 'c3'],
  );
});

test('a chapter with oversized sheet items never prompts above 32 KB', async () => {
  const snapshot = narratable();
  const era = snapshot.eras[0];
  for (const item of era.sheet) item.text = `${item.text}${'x'.repeat(50_000)}`;
  era.sheet.push(
    {
      id: 'd3',
      kind: 'directory',
      text: `${'deep/'.repeat(10_000)} created`,
      time: times[1],
      commits: [shas[1]],
    },
    {
      id: 't1',
      kind: 'term',
      text: 'w'.repeat(50_000),
      time: times[2],
      commits: [shas[2]],
    },
  );
  const { model, prompts } = scripted([grounded]);
  const result = await narrateEra(era, snapshot.repository, model);
  assert.equal(prompts.length, 1);
  assert.ok(Buffer.byteLength(prompts[0], 'utf8') < 32 * 1024);
  assert.equal(result.narration, 'model');
});

test('a prompt above 32 KB falls back to facts without calling the model', async (context) => {
  const snapshot = narratable();
  const warnings: unknown[][] = [];
  context.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args));
  const { model, prompts } = scripted([grounded]);
  const era = await narrateEra(
    snapshot.eras[0],
    { ...snapshot.repository, description: 'd'.repeat(40_000) },
    model,
  );
  assert.equal(prompts.length, 0);
  assert.equal(era.narration, 'facts');
  assert.ok(warnings.some((args) => JSON.stringify(args).includes('32768')));
});
