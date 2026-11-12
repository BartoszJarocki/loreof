import { memo, useMemo, type KeyboardEvent } from 'react';
import type { Commit, Era } from '@/lib/schema';
import { commitAtSeconds, eraIndexAt, formatDate, TOUR_SECONDS } from '@/viewer/playback';
import { commitBins, tourAtCommit } from '@/viewer/beats';

const BINS = 120;

export function Timeline({
  commits,
  eras,
  cursor,
  activity,
  disabled,
  onSeek,
  onSeekEnd,
  onSelectChapter,
}: {
  commits: Pick<Commit, 'time'>[];
  eras: Era[];
  cursor: number;
  activity: Uint32Array | null;
  disabled: boolean;
  onSeek: (commit: number) => void;
  onSeekEnd: () => void;
  onSelectChapter: (chapter: number) => void;
}) {
  const bins = useMemo(() => commitBins(eras, commits, BINS, activity), [commits, eras, activity]);
  const tour = tourAtCommit(eras, cursor);
  const chapter = eraIndexAt(eras, cursor);
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    const step = Math.max(1, Math.ceil(commits.length / BINS));
    const next = {
      ArrowRight: cursor + step,
      ArrowUp: cursor + step,
      ArrowLeft: cursor - step,
      ArrowDown: cursor - step,
      PageDown: eras[Math.min(eras.length - 1, chapter + 1)].start,
      PageUp: eras[Math.max(0, chapter - 1)].start,
      Home: 0,
      End: commits.length - 1,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    onSeek(Math.max(0, Math.min(commits.length - 1, next)));
  }
  const seek = (value: number) =>
    onSeek(commitAtSeconds(eras, commits.length, (value / 10_000) * TOUR_SECONDS));
  return (
    <div className="timeline">
      <Bars bins={bins} current={Math.floor(tour * BINS)} />
      <span
        className="timeline-playhead"
        style={{ left: `${Math.min(100, Math.max(0, tour * 100))}%` }}
        aria-hidden="true"
      />
      <input
        type="range"
        aria-label="position in history"
        aria-valuetext={`${formatDate(commits[cursor].time)}, chapter ${chapter + 1} of ${eras.length}, commit ${cursor + 1} of ${commits.length}`}
        min={0}
        max={10_000}
        step={1}
        value={Math.round(tour * 10_000)}
        disabled={disabled}
        onKeyDown={keyDown}
        onChange={(event) => seek(Number(event.target.value))}
        onPointerUp={onSeekEnd}
        onPointerCancel={onSeekEnd}
        onKeyUp={onSeekEnd}
        onBlur={onSeekEnd}
      />
      <div className="timeline-ticks">
        {eras.map((era, index) => (
          <button
            key={era.id}
            type="button"
            className="tick"
            style={{ left: `${(index / eras.length) * 100}%` }}
            aria-label={`chapter ${index + 1}: ${era.title.toLowerCase()}`}
            aria-current={index === chapter ? 'true' : undefined}
            title={era.title}
            onClick={() => onSelectChapter(index)}
          >
            {index + 1}
          </button>
        ))}
      </div>
    </div>
  );
}

const Bars = memo(function Bars({ bins, current }: { bins: number[]; current: number }) {
  const max = Math.max(1, ...bins);
  return (
    <div className="timeline-bars" aria-hidden="true">
      {bins.map((count, bin) => (
        <i
          key={bin}
          className={bin <= current ? 'past' : undefined}
          style={{ height: `${count ? Math.max(6, Math.pow(count / max, 0.4) * 100) : 0}%` }}
        />
      ))}
    </div>
  );
});
