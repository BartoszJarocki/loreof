import {
  factualNarration,
  factualTitleError,
  ground,
  isFactualTitle,
  isoDate,
  mergeNumber,
  sheetFor,
  sheetSubject,
  titleFromSubject,
} from './grounding';
import { PIPELINE_VERSION, snapshotSchema, type Era, type Snapshot } from './schema';

// extractHistory credits a commit's author unless a merge bot merged it, its merged branch's author, and the pull request that branch merged.
const CREDITS_PER_COMMIT = 3;

export function parseSnapshot(value: unknown): Snapshot {
  const snapshot = snapshotSchema.parse(value);
  const legacy = snapshot.pipelineVersion !== PIPELINE_VERSION;
  const { commits, coverage } = snapshot;
  const count = commits.length;
  const filesSampled = coverage.displayedFiles < coverage.totalFiles;
  const authors = new Map(snapshot.authors.map((author) => [author.id, author]));
  const commitIds = new Set(commits.map((commit) => commit.sha));
  if (authors.size !== snapshot.authors.length || commitIds.size !== count)
    throw new Error('Snapshot has duplicate author or commit identifiers');
  if (
    coverage.analyzedCommits !== count ||
    coverage.totalCommits < count ||
    coverage.displayedFiles !== snapshot.files.length ||
    coverage.totalFiles < coverage.displayedFiles ||
    coverage.selectedGraphCommits > coverage.eligibleGraphCommits ||
    coverage.eligibleGraphCommits > count ||
    coverage.edges > coverage.pairUpdates ||
    coverage.filesSampled !== filesSampled ||
    (!coverage.graphSampled && coverage.selectedGraphCommits !== coverage.eligibleGraphCommits)
  )
    throw new Error('Snapshot has inconsistent coverage counts');
  if (snapshot.startTime !== commits[0].time || snapshot.endTime !== commits[count - 1].time)
    throw new Error('Snapshot dates do not match its history');
  for (const [index, commit] of commits.entries()) {
    if (!authors.has(commit.author)) throw new Error('Snapshot has an unknown author');
    if (index > 0 && commit.time < commits[index - 1].time)
      throw new Error('Snapshot presentation dates go backward');
  }
  const files = new Set<number>();
  for (const file of snapshot.files) {
    if (
      files.has(file.id) ||
      file.born >= count ||
      (file.died !== null && (file.died <= file.born || file.died >= count))
    )
      throw new Error('Snapshot has an invalid file lifetime');
    files.add(file.id);
    if (
      file.touches.some(
        (tick, index) =>
          tick < file.born ||
          tick > (file.died ?? count - 1) ||
          (index > 0 && tick <= file.touches[index - 1]),
      )
    )
      throw new Error('Snapshot has duplicate, unordered, or invalid file touches');
    if (
      file.paths[0][0] !== file.born ||
      file.paths.at(-1)?.[1] !== file.path ||
      file.paths.some(
        ([tick], index) =>
          tick < file.born ||
          tick >= (file.died ?? count) ||
          (index > 0 && tick <= file.paths[index - 1][0]),
      )
    )
      throw new Error('Snapshot has invalid path intervals');
    if (file.authors.some((author) => !authors.has(author.id)))
      throw new Error('Snapshot has an unknown file author');
  }
  const firstCommits = new Map<number, number>();
  commits.forEach((commit, index) => {
    if (!firstCommits.has(commit.author)) firstCommits.set(commit.author, index);
  });
  let end = 0;
  const eras = new Set<number>();
  for (const era of snapshot.eras) {
    if (era.start !== end || era.end <= era.start || era.end > count)
      throw new Error('Snapshot chapters do not partition its history');
    end = era.end;
    if (eras.has(era.id)) throw new Error('Snapshot has an invalid era identifier');
    eras.add(era.id);
    const chapter = commits.slice(era.start, era.end);
    const human = chapter.filter((commit) => authors.get(commit.author)?.kind !== 'bot');
    if (
      era.startTime !== chapter[0].time ||
      era.endTime !== chapter[chapter.length - 1].time ||
      era.created !== human.reduce((total, commit) => total + commit.created, 0) ||
      era.deleted !== human.reduce((total, commit) => total + commit.deleted, 0) ||
      era.contributors <
        new Set(human.filter((commit) => !commit.merge).map((commit) => commit.author)).size ||
      era.contributors > CREDITS_PER_COMMIT * chapter.length
    )
      throw new Error('Snapshot chapter dates or totals do not match its commits');
    const hashes = new Set(chapter.map((commit) => commit.sha));
    const facts = new Map(era.facts.map((fact) => [fact.id, fact]));
    if (facts.size !== era.facts.length) throw new Error('Snapshot has duplicate fact identifiers');
    for (const fact of era.facts) {
      if (fact.commits.some((sha) => !commitIds.has(sha)))
        throw new Error('Snapshot fact cites an unknown commit');
      if (fact.commits.some((sha) => !hashes.has(sha)))
        throw new Error('Snapshot fact evidence is outside its chapter');
    }
    checkSheet(era, chapter, authors, firstCommits);
  }
  if (end !== count) throw new Error('Snapshot chapters do not partition its history');
  const humanCommits = new Map(
    snapshot.eras.map((era) => [
      era.id,
      commits
        .slice(era.start, era.end)
        .filter((commit) => authors.get(commit.author)?.kind !== 'bot').length,
    ]),
  );
  return {
    ...snapshot,
    eras: snapshot.eras.map((era) => checkNarration(era, humanCommits.get(era.id) ?? 0, legacy)),
  };
}

function commitItemMatches(
  item: Era['sheet'][number],
  commit: Snapshot['commits'][number] | undefined,
): boolean {
  if (!commit) return false;
  if (item.text === commit.subject) return commit.merge || item.title === undefined;
  if (!commit.merge) return false;
  const number = mergeNumber(commit.subject);
  const title = commit.mergeTitle;
  if (!number || !title) return false;
  const shown = /^(.*) \(#(\d+)\)$/.exec(item.text);
  if (!shown || shown[2] !== number) return false;
  if (item.title !== title) return false;
  return sheetSubject(commit.subject, title) === item.text;
}

function checkSheet(
  era: Era,
  chapter: Snapshot['commits'],
  authors: Map<number, Snapshot['authors'][number]>,
  firstCommits: Map<number, number>,
) {
  const bySha = new Map(chapter.map((commit) => [commit.sha, commit]));
  const titles = new Map(
    era.sheet.flatMap((item) =>
      item.kind === 'commit' && item.title ? [[item.commits[0], item.title] as const] : [],
    ),
  );
  if (new Set(era.sheet.map((item) => item.id)).size !== era.sheet.length)
    throw new Error('Snapshot has duplicate fact sheet identifiers');
  for (const item of era.sheet) {
    const cited = item.commits.map((sha) => bySha.get(sha));
    if (cited.some((commit) => !commit))
      throw new Error('Snapshot fact sheet evidence is outside its chapter');
    const [first] = cited;
    const author = first && authors.get(first.author);
    if (item.time !== undefined && item.time !== first?.time)
      throw new Error('Snapshot fact sheet item date does not match its commit');
    if (
      (item.kind === 'commit' && !commitItemMatches(item, first)) ||
      (item.kind === 'term' &&
        !cited.some((commit) =>
          `${commit?.subject} ${titles.get(commit?.sha ?? '') ?? ''}`
            .toLowerCase()
            .includes(item.text.toLowerCase()),
        )) ||
      (item.kind === 'newcomer' &&
        (author?.kind !== 'github' ||
          `@${author.handle}` !== item.text ||
          (firstCommits.get(author.id) ?? 0) < era.start))
    )
      throw new Error('Snapshot fact sheet item does not match its commit');
  }
}

function checkBeats(era: Era, humanCommits: number, legacy: boolean): void {
  const byId = new Map(era.sheet.map((item) => [item.id, item]));
  if (era.narration === 'facts') {
    const facts = new Map(era.facts.map((fact) => [fact.id, fact]));
    if (!isFactualTitle(era.title)) throw new Error('Snapshot factual chapter has free text');
    const error = factualTitleError(era, era.title, humanCommits, legacy);
    if (error) throw new Error(`Snapshot factual chapter has ${error}`);
    for (const beat of era.beats)
      if (beat.kind !== 'fact' || facts.get(beat.ref)?.text !== beat.text)
        throw new Error('Snapshot factual caption does not match its fact');
    return;
  }
  if (era.beats.length < 2 || era.beats.length > 4)
    throw new Error('Snapshot chapter does not cite two to four commits');
  const refs = new Set<string>();
  let previous = '';
  for (const beat of era.beats) {
    if (beat.kind !== 'commit')
      throw new Error('Snapshot model chapter has a caption instead of a commit');
    if (refs.has(beat.ref)) throw new Error('Snapshot chapter repeats a commit');
    refs.add(beat.ref);
    const item = byId.get(beat.ref);
    if (!item || item.kind !== 'commit')
      throw new Error('Snapshot beat cites a ref outside its fact sheet');
    const sha = item.commits[0];
    if (!sha.startsWith(beat.sha) || beat.sha.length < 7)
      throw new Error('Snapshot beat short SHA does not match its commit');
    if (item.time === undefined || beat.date !== isoDate(item.time))
      throw new Error('Snapshot beat date does not match its commit');
    if (beat.subject !== item.text)
      throw new Error('Snapshot beat subject does not match its fact sheet item');
    if (previous && beat.date < previous) throw new Error('Snapshot beats are not sorted by date');
    previous = beat.date;
  }
}

function checkNarration(era: Era, humanCommits: number, legacy: boolean): Era {
  checkBeats(era, humanCommits, legacy);
  if (era.narration === 'facts') return era;
  const beats = era.beats.filter(
    (beat): beat is Extract<Era['beats'][number], { kind: 'commit' }> => beat.kind === 'commit',
  );
  const refs = beats.map((beat) => beat.ref);
  let headline = era.headline;
  if (!headline) {
    const matches = beats.filter((beat) => titleFromSubject(beat.subject) === era.title);
    if (matches.length !== 1) {
      console.warn('lore.narration-legacy', { era: era.id, title: era.title });
      return {
        ...era,
        ...factualNarration({ ...era, sheet: era.sheet }),
        narration: 'facts',
        headline: undefined,
      };
    }
    headline = matches[0].ref;
  }
  const errors = ground({ commits: refs, headline }, sheetFor(era));
  if (errors.length) throw new Error(`Snapshot chapter is not grounded: ${errors.join('; ')}`);
  const headlineSubject = beats.find((beat) => beat.ref === headline)!.subject;
  const title = titleFromSubject(headlineSubject);
  if (isFactualTitle(title)) throw new Error('Snapshot model chapter has a factual-shaped title');
  if (era.title !== title)
    throw new Error('Snapshot chapter title does not match its headline commit');
  return { ...era, headline, title };
}
