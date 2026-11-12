import { memo } from 'react';
import type { ChapterView } from '@/viewer/story';
import { ExternalLink } from '../Index';

export function reportUrl(repository: string, chapter: ChapterView): string {
  const subject = `Wrong claim in ${repository}, chapter ${chapter.number}: ${chapter.title}`;
  const commits = chapter.beats.flatMap((beat) =>
    beat.kind === 'commit' ? [`${beat.date} ${beat.sha} ${beat.subject}`] : [],
  );
  const body = [
    `Repository: ${repository}`,
    `Chapter ${chapter.number}: ${chapter.title}`,
    ...commits,
    '',
    'What is wrong with the title or a commit line:',
  ].join('\n');
  return `mailto:bartosz@jarocki.me?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export const Chapter = memo(function Chapter({
  chapter,
  repository,
}: {
  chapter: ChapterView;
  repository: string;
}) {
  return (
    <article className="chapter">
      <p className="tone-faint">{chapter.dateRange}</p>
      <h2 className="chapter-title">{chapter.title}</h2>
      <ol className="chapter-beats">
        {chapter.beats.map((beat) =>
          beat.kind === 'commit' ? (
            <li
              key={beat.ref}
              className={`index-row chapter-beat${beat.ref === chapter.headline ? ' chapter-beat-headline' : ''}`}
            >
              <span className="tone-faint chapter-beat-date">{beat.date.slice(0, 7)}</span>
              <span className="tone-ink chapter-beat-subject cased">{beat.subject}</span>
              <span className="tone-faint chapter-beat-trail">
                <ExternalLink
                  className="sha cased"
                  href={`https://github.com/${repository}/commit/${beat.sha}`}
                >
                  {beat.sha}
                </ExternalLink>
              </span>
            </li>
          ) : (
            <li key={beat.ref} className="chapter-fact">
              {beat.text}
            </li>
          ),
        )}
      </ol>
      <p className="chapter-report">
        <a href={reportUrl(repository, chapter)}>report a wrong claim</a>
      </p>
      {chapter.note && <p className="chapter-note tone-faint">{chapter.note}</p>}
    </article>
  );
});
