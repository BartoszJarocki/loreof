import { memo, useEffect, useRef, type KeyboardEvent } from 'react';
import Link from 'next/link';
import type { Era } from '@/lib/schema';
import { formatNumber } from '@/viewer/playback';
import { yearSpan } from '@/viewer/story';
import { IndexList, IndexSection } from '../Index';

export const Chapters = memo(function Chapters({
  eras,
  current,
  onSelect,
}: {
  eras: Era[];
  current: number;
  onSelect: (index: number) => void;
}) {
  return (
    <IndexSection label="chapters">
      <IndexList>
        {eras.map((era, index) => (
          <li key={era.id}>
            <button
              type="button"
              className="index-row chapter-row"
              aria-current={index === current ? 'true' : undefined}
              onClick={() => onSelect(index)}
            >
              <span className="tone-faint">{yearSpan(era)}</span>
              <span className="tone-ink">{era.title}</span>
              <span className="tone-faint index-trail">
                {formatNumber(era.end - era.start)} commits
              </span>
            </button>
          </li>
        ))}
      </IndexList>
    </IndexSection>
  );
});

/** The chapters as a modal index over the map. A native dialog traps focus and closes on escape. */
export function ChaptersDialog({
  open,
  eras,
  current,
  onClose,
  onSelect,
}: {
  open: boolean;
  eras: Era[];
  current: number;
  onClose: () => void;
  onSelect: (index: number) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    else if (!open && element.open) element.close();
  }, [open]);
  function trapFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== 'Tab') return;
    const items = dialog.current?.querySelectorAll<HTMLElement>(
      'button, a[href], input, [tabindex]',
    );
    if (!items || items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  return (
    <dialog
      ref={dialog}
      className="chapters-dialog"
      aria-labelledby="chapters-title"
      onKeyDown={trapFocus}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <div className="chapters-head">
        <h2 id="chapters-title">chapters</h2>
        <button type="button" onClick={onClose}>
          close
        </button>
      </div>
      <ol className="crows">
        {eras.map((era, index) => (
          <li key={era.id}>
            <button
              type="button"
              className="crow index-row"
              aria-current={index === current ? 'true' : undefined}
              onClick={() => onSelect(index)}
            >
              <span className="lead tone-faint">{yearSpan(era)}</span>
              <span className="main tone-ink">{era.title}</span>
              <span className="trail tone-faint">{formatNumber(era.end - era.start)} commits</span>
            </button>
          </li>
        ))}
      </ol>
      <nav className="dialog-nav site-nav" aria-label="site">
        <Link href="/#collection" className="faint-link">
          collection
        </Link>
        <Link href="/_/method" className="faint-link">
          method
        </Link>
        <Link href="/_/about" className="faint-link">
          about
        </Link>
      </nav>
    </dialog>
  );
}
