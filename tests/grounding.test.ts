import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  factualNarration,
  factualTitleError,
  ground,
  isFactualTitle,
  sheetSubject,
  sheetFor,
  titleFromSubject,
  type FactSheet,
} from '../src/lib/grounding';

const sha = (value: string) => value.padEnd(40, '0');
const sheet: FactSheet = {
  from: Date.UTC(2016, 0, 1) / 1000,
  to: Date.UTC(2018, 0, 1) / 1000,
  items: [
    {
      id: 'c1',
      kind: 'commit',
      text: 'Rename experimental react-ui to react-interactions (#16842)',
      time: Date.UTC(2017, 8, 20) / 1000,
      commits: [sha('a')],
    },
    {
      id: 'c2',
      kind: 'commit',
      text: 'Remove Stack (part 4: remove Stack-only branches and types) (#10798)',
      time: Date.UTC(2017, 9, 2) / 1000,
      commits: [sha('b')],
    },
    {
      id: 'c3',
      kind: 'commit',
      text: 'React Fiber Reconciler (#6690)',
      time: Date.UTC(2016, 4, 15) / 1000,
      commits: [sha('c')],
    },
    {
      id: 'r1',
      kind: 'release',
      text: 'v16.0.0',
      time: Date.UTC(2017, 8, 26) / 1000,
      commits: [sha('f')],
    },
  ],
};

test('a title is the headline subject without its pull request number', () => {
  assert.equal(titleFromSubject('React Fiber Reconciler (#6690)'), 'React Fiber Reconciler');
  assert.equal(titleFromSubject('Add turbopack example (#41789)'), 'Add turbopack example');
  assert.equal(titleFromSubject('Use Prettier'), 'Use Prettier');
  assert.equal(
    titleFromSubject('feat(design): rebuild the site as an index (#27)'),
    'rebuild the site as an index',
  );
  assert.equal(
    titleFromSubject('refactor!: merge turbopack crates into next.js'),
    'merge turbopack crates into next.js',
  );
  assert.equal(
    titleFromSubject('BREAKING CHANGE: rename next/image to next/legacy/image'),
    'rename next/image to next/legacy/image',
  );
  assert.equal(titleFromSubject('rustc: Remove some dead code'), 'rustc: Remove some dead code');
  assert.equal(
    titleFromSubject('A very long commit subject that keeps going past the sixty character limit'),
    'A very long commit subject that keeps going past the sixty…',
  );
  assert.ok(
    titleFromSubject('A very long commit subject that keeps going past the sixty character limit')
      .length <= 60,
  );
});

test('a selection is two to four unique commits and a headline among them', () => {
  assert.deepEqual(ground({ commits: ['c3', 'c1'], headline: 'c3' }, sheet), []);
  assert.ok(
    ground({ commits: [], headline: 'c3' }, sheet).some((error) =>
      error.startsWith('commits: choose'),
    ),
  );
  assert.ok(
    ground({ commits: ['c3', 'c1', 'c1'], headline: 'c3' }, sheet).includes('commits: duplicate'),
  );
  assert.ok(
    ground({ commits: ['c3', 'r1'], headline: 'c3' }, sheet).includes(
      'commits: r1 is not a commit in this chapter',
    ),
  );
  assert.ok(
    ground({ commits: ['c3', 'c1', 'c2', 'c3', 'r1'], headline: 'c3' }, sheet).includes(
      'commits: choose 2 to 4',
    ),
  );
  assert.ok(
    ground({ commits: ['c3', 'c1'] }, sheet).includes(
      'headline: choose one of the selected commits',
    ),
  );
  assert.ok(
    ground({ commits: ['c3', 'c1'], headline: 'c2' }, sheet).includes(
      'headline: not among the selected commits',
    ),
  );
});

test('a factual-shaped headline is rejected', () => {
  const historical: FactSheet = {
    ...sheet,
    items: [...sheet.items, { id: 'c9', kind: 'commit', text: 'Chapter 9', commits: [sha('z')] }],
  };
  assert.ok(
    ground({ commits: ['c9', 'c3'], headline: 'c9' }, historical).includes(
      'headline: title is factual-shaped',
    ),
  );
});

test('a merge pull request subject becomes its own PR title with the number', () => {
  assert.equal(
    sheetSubject('Merge pull request #6690 from acdlite/fiber', 'React Fiber Reconciler'),
    'React Fiber Reconciler (#6690)',
  );
  assert.equal(
    sheetSubject('Merge pull request #6690 from acdlite/fiber', 'React Fiber Reconciler (#6690)'),
    'React Fiber Reconciler (#6690)',
  );
  assert.equal(
    sheetSubject(
      'Merge pull request #6690 from acdlite/fiber',
      'Merge pull request #6690 from acdlite/fiber',
    ),
    'Merge pull request #6690 from acdlite/fiber',
  );
  assert.equal(
    sheetSubject('Add turbopack example (#41789)', 'ignored'),
    'Add turbopack example (#41789)',
  );
  assert.equal(
    sheetSubject('Auto merge of #12345 - matthiaskrgr:rollup, r=matthiaskrgr', 'Update the solver'),
    'Auto merge of #12345 - matthiaskrgr:rollup, r=matthiaskrgr',
  );
});

test('a factual title is recognised without grounding', () => {
  assert.ok(isFactualTitle('May 2016 to Oct 2017'));
  assert.ok(isFactualTitle('The v16.0.0 tag'));
  assert.ok(!isFactualTitle('React Fiber Reconciler'));
});

test('a factual title has to match its chapter sheet', () => {
  const era = {
    id: 1,
    startTime: Date.UTC(2016, 4, 1) / 1000,
    endTime: Date.UTC(2017, 9, 1) / 1000,
    sheet: [{ kind: 'release', text: 'v16.0.0' }],
  };
  assert.equal(factualTitleError(era, 'The v16.0.0 tag', 1234), undefined);
  assert.match(factualTitleError(era, 'The v99.0.0 tag', 1234) ?? '', /not a release tag/);
  assert.equal(factualTitleError(era, 'May 2016 to Oct 2017', 1234), undefined);
  assert.match(
    factualTitleError(era, 'Jan 1999 to Dec 2001', 1234) ?? '',
    /not this chapter's dates/,
  );
  assert.equal(factualTitleError(era, 'Chapter 2', 1234), undefined);
  assert.match(factualTitleError(era, 'Chapter 42', 1234) ?? '', /not this chapter's number/);
  assert.match(
    factualTitleError(era, 'The first chapter', 1234) ?? '',
    /not this chapter's position/,
  );
  assert.equal(factualTitleError({ ...era, id: 0 }, 'The first chapter', 1234), undefined);
  assert.equal(factualTitleError(era, '1,234 non-bot integration commits', 1234), undefined);
  assert.match(
    factualTitleError(era, '99,999 non-bot integration commits', 1234) ?? '',
    /does not match/,
  );
});

test('fallback titles use a release tag or the date range', () => {
  const startTime = Date.UTC(2016, 4, 1) / 1000;
  const endTime = Date.UTC(2017, 9, 1) / 1000;
  assert.equal(
    factualNarration({
      id: 1,
      facts: [],
      startTime,
      endTime,
      sheet: [{ kind: 'release', text: 'v16.0.0' }],
    }).title,
    'The v16.0.0 tag',
  );
  assert.equal(
    factualNarration({ id: 0, facts: [], startTime, endTime }).title,
    'May 2016 to Oct 2017',
  );
  assert.deepEqual(
    factualNarration({
      id: 0,
      facts: [{ id: 'f1', text: 'One file was created.' }],
      startTime,
      endTime,
    }).beats,
    [{ kind: 'fact', ref: 'f1', text: 'One file was created.' }],
  );
});

test('sheetFor keeps the chapter window and items', () => {
  const factSheet = sheetFor({ startTime: 1, endTime: 2, sheet: sheet.items });
  assert.equal(factSheet.from, 1);
  assert.equal(factSheet.to, 2);
  assert.deepEqual(factSheet.items, sheet.items);
});

const REFERENCE_PREFIX =
  /^(?:BREAKING CHANGE|feat|fix|refactor|chore|perf|docs|test|build|ci|style|revert)(?:\([^)]*\))?!?:\s*/i;

const REFERENCE_LONG = `fix: ${'word '.repeat(1000)}(#123)`;

function referenceTitleFromSubject(subject: string): string {
  const stripped = subject
    .replace(REFERENCE_PREFIX, '')
    .replace(/\s*\(#\d+\)\s*$/, '')
    .trim();
  const text = stripped || subject.trim();
  if (text.length <= 60) return text;
  const cut = text.slice(0, 59);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > 0 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

function fixtureSubjects(): string[] {
  const directory = join(import.meta.dirname, 'fixtures/narration');
  const subjects: string[] = [];
  for (const name of readdirSync(directory).filter((value) => value.endsWith('.json'))) {
    const snapshot = JSON.parse(readFileSync(join(directory, name), 'utf8'));
    for (const era of snapshot.eras ?? [])
      for (const item of era.sheet ?? [])
        if (typeof item.text === 'string') subjects.push(item.text);
    for (const commit of snapshot.commits ?? [])
      if (typeof commit.subject === 'string') subjects.push(commit.subject);
  }
  return subjects;
}

test('a title is unchanged for fixture and adversarial subjects', () => {
  const spaces = (count: number) => ' '.repeat(count);
  const adversarial = [
    '',
    ' ',
    '   ',
    '(#1)',
    '   (#1)',
    '   (#1)   ',
    'a (#1)',
    'a(#1)',
    'Fix\n(#1)',
    'Fix \u00a0(#1)\u00a0',
    'Fix\u2028(#1)\u2029',
    `title${spaces(5000)}`,
    spaces(5000),
    `${spaces(5000)}a`,
    `${spaces(5000)}(#1)`,
    `${spaces(10_000)}(#123)${spaces(10_000)}`,
    `title${spaces(5000)}(#123)${spaces(5000)}`,
    'title(#1)(#2)(#3)',
    'title (#1) (#2)',
    'title (#1)\n(#2)',
    `feat: ${spaces(5000)}(#9)`,
    `x${spaces(1000)}\t\n\r\u00a0\u3000(#42)\u2028${spaces(1000)}`,
    `a${'(#1)'.repeat(5000)}`,
    `#${'9'.repeat(5000)}`,
    `(#${'9'.repeat(5000)})`,
    'a'.repeat(5000),
    `a${' )'.repeat(2000)}`,
    REFERENCE_LONG,
  ];
  const subjects = [...fixtureSubjects(), ...adversarial];
  assert.ok(subjects.length > 100);
  for (const subject of subjects)
    assert.equal(
      titleFromSubject(subject),
      referenceTitleFromSubject(subject),
      JSON.stringify(subject.slice(0, 80)),
    );
});

test('a title finishes in linear time on a long whitespace tail', () => {
  const subject = ' '.repeat(80_000);
  const before = process.hrtime.bigint();
  const title = titleFromSubject(subject);
  const elapsed = Number(process.hrtime.bigint() - before) / 1e6;
  assert.equal(title, '');
  assert.ok(elapsed < 50, `titleFromSubject took ${elapsed.toFixed(1)} ms`);
});
