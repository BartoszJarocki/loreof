import { beatsFrom, ground, sheetFor, titleFromSubject } from '../../src/lib/grounding';
import type { Era, Snapshot } from '../../src/lib/schema';

const month = (time: number) => new Date(time * 1000).toISOString().slice(0, 7);

export function reviewPath(slug: string): string {
  return `.cache/reviews/${slug.toLowerCase().replace('/', '-')}.md`;
}

export function writeReview(snapshot: Snapshot): string {
  const chapters = snapshot.eras.map((era) => {
    const cited = new Set(era.beats.flatMap((beat) => beat.ref));
    return [
      `## Chapter ${era.id + 1}, ${month(era.startTime)} to ${month(era.endTime)}`,
      '',
      `status: ${era.narration === 'reviewed' ? 'accepted' : 'draft'}`,
      `narration: ${era.narration}`,
      ...(era.headline ? [`headline: ${era.headline}`] : []),
      `title: ${era.title}`,
      '',
      ...(era.narration === 'facts'
        ? []
        : era.beats.map((beat) =>
            beat.kind === 'commit'
              ? `- ${beat.ref} ${beat.sha} ${beat.date} ${beat.subject}`
              : `- ${beat.ref} ${beat.text}`,
          )),
      '',
      'Evidence:',
      '',
      ...era.sheet.map(
        (item) =>
          `- ${cited.has(item.id) ? `**${item.id}**` : item.id} \`${item.commits[0].slice(0, 9)}\` ${item.kind}: ${item.text}${item.title ? ` (${item.title})` : ''}`,
      ),
    ].join('\n');
  });
  return [
    `# ${snapshot.repository.slug} chapters`,
    '',
    `snapshot: ${snapshot.id}`,
    `head: ${snapshot.repository.head}`,
    '',
    "Edit a chapter's commit lines or headline in place and set its status to accepted. A commit line is its ref, short SHA, ISO date, and the subject the sheet holds. Accepted chapters must keep two to four commits from the sheet, and a subject that differs from its commit is rejected. The title is derived from the headline commit, so an edited title that does not match its headline is rejected. Draft chapters keep their current narration.",
    '',
    ...chapters.flatMap((chapter) => [chapter, '']),
  ].join('\n');
}

export function reviewedSnapshot(markdown: string): string | undefined {
  return /^snapshot: (\S+)$/m.exec(markdown)?.[1];
}

export function applyReview(snapshot: Snapshot, markdown: string, file: string): Snapshot {
  const sections = markdown.split(/^## Chapter (\d+),.*$/m);
  const accepted = new Map<
    number,
    {
      title: string;
      headline: string;
      commits: { ref: string; sha: string; date: string; subject: string }[];
    }
  >();
  for (let index = 1; index < sections.length; index += 2) {
    const body = sections[index + 1].split(/^Evidence:$/m)[0];
    if (!/^status: accepted$/m.test(body)) continue;
    const field = (name: string) => new RegExp(`^${name}: ?(.*)$`, 'm').exec(body)?.[1].trim();
    if (field('narration') === 'facts') continue;
    const commits: { ref: string; sha: string; date: string; subject: string }[] = [];
    for (const line of body.split('\n').filter((value) => value.startsWith('- '))) {
      const match = /^- (\S+) ([a-f0-9]{7,9}) (\d{4}-\d{2}-\d{2}) (.+)$/.exec(line);
      if (!match)
        throw new Error(
          `${file} chapter ${sections[index]} has an unreadable commit line: ${line}`,
        );
      commits.push({ ref: match[1], sha: match[2], date: match[3], subject: match[4].trim() });
    }
    accepted.set(Number(sections[index]) - 1, {
      title: field('title') ?? '',
      headline: field('headline') ?? '',
      commits,
    });
  }
  if (!accepted.size) return snapshot;
  const id = reviewedSnapshot(markdown);
  if (id !== snapshot.id)
    throw new Error(`${file} reviews snapshot ${id}, not ${snapshot.id}. Run with --review again.`);
  const eras = snapshot.eras.map((era): Era => {
    const review = accepted.get(era.id);
    if (!review) return era;
    const items = new Map(era.sheet.map((item) => [item.id, item]));
    if (review.commits.length < 2 || review.commits.length > 4)
      throw new Error(`${file} chapter ${era.id + 1} must keep two to four commits`);
    const refs = review.commits.map((commit) => commit.ref);
    if (new Set(refs).size !== refs.length)
      throw new Error(`${file} chapter ${era.id + 1} repeats a commit`);
    for (const commit of review.commits) {
      const item = items.get(commit.ref);
      if (!item || item.kind !== 'commit' || item.time === undefined)
        throw new Error(
          `${file} chapter ${era.id + 1} cites ${commit.ref}, which is not a commit in its sheet`,
        );
      if (commit.subject !== item.text)
        throw new Error(
          `${file} chapter ${era.id + 1} beat ${commit.ref} subject "${commit.subject}" does not match its commit "${item.text}"`,
        );
      if (!item.commits[0].startsWith(commit.sha))
        throw new Error(`${file} chapter ${era.id + 1} beat ${commit.ref} has the wrong short SHA`);
      if (commit.date !== new Date(item.time * 1000).toISOString().slice(0, 10))
        throw new Error(`${file} chapter ${era.id + 1} beat ${commit.ref} has the wrong date`);
    }
    const headline = review.headline || refs[0];
    const headlineItem = items.get(headline);
    if (!headlineItem || headlineItem.kind !== 'commit' || !refs.includes(headline))
      throw new Error(
        `${file} chapter ${era.id + 1} headline ${headline} is not one of its commits`,
      );
    const title = titleFromSubject(headlineItem.text);
    if (review.title !== title)
      throw new Error(
        `${file} chapter ${era.id + 1} title "${review.title}" does not match its headline "${title}"`,
      );
    const errors = ground({ commits: refs, headline }, sheetFor(era));
    if (errors.length)
      throw new Error(`${file} chapter ${era.id + 1} is not grounded: ${errors.join('; ')}`);
    return {
      ...era,
      title,
      headline,
      beats: beatsFrom(refs, sheetFor(era)),
      narration: 'reviewed',
    };
  });
  return { ...snapshot, eras };
}
