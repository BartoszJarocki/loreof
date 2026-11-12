import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { z } from 'zod';
import { eraSchema, sheetItemSchema, type Era } from '../src/lib/schema';
import { narrateEra } from '../src/server/narration';
import { replayModel } from '../scripts/lib/replay';

const skip = process.env.LORE_NARRATION_EVAL !== '1' && 'run with pnpm test:narration';
const resultSchema = z.array(
  z.object({
    era: z.number().int().nonnegative(),
    from: z.string(),
    to: z.string(),
    attempts: z.array(z.unknown()),
    denied: z.boolean().optional(),
    narration: z.string(),
    title: z.string(),
    headline: z.string().default(''),
    selected: z.array(z.string()).default([]),
    beats: z.array(
      z.object({
        kind: z.string(),
        ref: z.string(),
        sha: z.string().optional(),
        date: z.string().optional(),
        subject: z.string().optional(),
        text: z.string().optional(),
      }),
    ),
  }),
);
const fixtureSchema = z.object({
  repository: z.object({ slug: z.string(), description: z.string() }),
  head: z.string(),
  eras: z.array(
    z.object({
      id: z.number(),
      startTime: z.number(),
      endTime: z.number(),
      sheet: z.array(sheetItemSchema),
    }),
  ),
});
type Expected = { name: string; pattern: RegExp };
const expected: Record<string, Expected[]> = {
  react: [
    { name: 'Fiber', pattern: /\bfiber\b/i },
    { name: 'React Hooks', pattern: /(?:\buseState\b|\buseEffect\b|\bReact\s+Hooks\b|\bHooks\b)/ },
    { name: 'compiler', pattern: /\bcompiler\b/i },
  ],
  nextjs: [
    { name: 'app directory', pattern: /\bapp (router|dir|directory)\b/i },
    { name: 'Turbopack', pattern: /\bturbopack\b/i },
  ],
  rust: [{ name: 'editions', pattern: /\beditions?\b/i }],
  jarocki: [{ name: 'rebuild', pattern: /\brebuil(t|d|ds)\b/i }],
};
const knownMisses: Record<string, string[]> = {
  react: ['React Hooks'],
  nextjs: [],
  rust: ['editions'],
  jarocki: [],
};

async function narrate(key: string) {
  const fixture = fixtureSchema.parse(
    JSON.parse(await readFile(`tests/fixtures/narration/${key}.json`, 'utf8')),
  );
  const recording = resultSchema.parse(
    JSON.parse(await readFile(`tests/fixtures/narration/${key}.outputs.json`, 'utf8')),
  );
  assert.equal(recording.length, fixture.eras.length, `${key} records every era`);
  const model = replayModel(recording);
  const eras = await Promise.all(
    fixture.eras.map((era) =>
      narrateEra(
        eraSchema.parse({
          ...era,
          start: 0,
          end: 1,
          title: `Chapter ${era.id + 1}`,
          beats: [],
          narration: 'facts',
          facts: [],
          directories: [],
          created: 0,
          deleted: 0,
          contributors: 0,
          centroid: [0, 0, 0],
        }),
        fixture.repository,
        model,
      ),
    ),
  );
  for (const [index, era] of eras.entries()) {
    const recorded = recording[index];
    assert.equal(era.id, recorded.era);
    assert.equal(era.narration, recorded.narration);
    assert.equal(era.title, recorded.title);
    assert.equal(era.headline ?? '', recorded.headline);
    assert.deepEqual(era.beats, recorded.beats);
  }
  return eras;
}

function outputText(eras: Era[]) {
  return eras
    .filter((era) => era.narration === 'model')
    .flatMap((era) => [
      era.title,
      ...era.beats.map((beat) => (beat.kind === 'commit' ? beat.subject : beat.text)),
    ])
    .join('\n');
}

function reviewText(markdown: string) {
  const chapters = markdown.split(/^## Chapter \d+,.*$/m).slice(1);
  return chapters
    .map((chapter) => chapter.split(/^Evidence:$/m)[0])
    .flatMap((body) =>
      body
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('title:') || line.startsWith('- '))
        .map((line) => line.replace(/^title:\s*/, '')),
    )
    .join('\n');
}

function recall(text: string, terms: Expected[]) {
  return terms.map((term) => ({ term: term.name, hit: term.pattern.test(text) }));
}

function assertRecall(key: string, label: string, results: { term: string; hit: boolean }[]) {
  for (const item of results) {
    const known = knownMisses[key].includes(item.term);
    if (known)
      assert.ok(!item.hit, `${key} ${label} now hits ${item.term}; remove it from knownMisses`);
    else assert.ok(item.hit, `${key} ${label} missed ${item.term}`);
  }
}

for (const [key, terms] of Object.entries(expected))
  test(`${key} recall on the saved live outputs and the review fixture`, { skip }, async () => {
    const eras = await narrate(key);
    const outputs = recall(outputText(eras), terms);
    const review = recall(
      reviewText(await readFile(`tests/fixtures/narration/${key}.review.md`, 'utf8')),
      terms,
    );
    const model = eras.filter((era) => era.narration === 'model').length;
    console.info(
      JSON.stringify({
        key,
        eras: eras.length,
        model,
        outputs: outputs.map((item) => `${item.term}:${item.hit ? 'hit' : 'miss'}`),
        review: review.map((item) => `${item.term}:${item.hit ? 'hit' : 'miss'}`),
      }),
    );
    assertRecall(key, 'outputs', outputs);
    assertRecall(key, 'review', review);
  });
