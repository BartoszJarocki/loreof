import type { Beat } from '@/viewer/beats';
import type { ChapterView } from '@/viewer/story';
import { ExternalLink } from '../Index';
import { reportUrl } from './Chapter';

/** The theater's chapter plate: range, title, then each commit line as the playhead reaches it. */
export function ChapterCard({
  chapter,
  beats,
  cursor,
  repository,
  expanded,
  onToggle,
}: {
  chapter: ChapterView;
  beats: Beat[];
  cursor: number;
  repository: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const revealed = beats.filter((beat) => beat.era === chapter.number - 1 && beat.tick <= cursor);
  return (
    <aside
      className="chapter-card"
      data-expanded={expanded ? 'true' : 'false'}
      aria-label="chapter"
    >
      <button type="button" className="card-head" aria-expanded={expanded} onClick={onToggle}>
        <span className="card-range">{chapter.dateRange}</span>
        <span className="card-title">{chapter.title}</span>
        <span className="cue" aria-hidden="true" />
      </button>
      <ol className="card-lines" hidden={revealed.length === 0}>
        {revealed.map((beat) => (
          <li key={`${beat.tick}-${beat.sha}`} className="card-line">
            <div className="card-line-meta">
              <span className="card-date">{beat.date.slice(0, 7)}</span>
              <ExternalLink
                className="card-sha cased"
                href={`https://github.com/${repository}/commit/${beat.fullSha}`}
              >
                {beat.sha}
              </ExternalLink>
            </div>
            <p className="subject cased">{beat.subject}</p>
          </li>
        ))}
      </ol>
      <details className="card-more">
        <summary>about this chapter</summary>
        <p className="chapter-report">
          <a href={reportUrl(repository, chapter)}>report a wrong claim</a>
        </p>
        {chapter.note && <p className="chapter-note tone-faint">{chapter.note}</p>}
      </details>
    </aside>
  );
}
