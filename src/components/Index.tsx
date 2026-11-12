import Link from 'next/link';
import type { ComponentPropsWithoutRef, CSSProperties, ReactNode } from 'react';

type Tone = 'ink' | 'body' | 'faint';

export function ExternalLink({ children, ...props }: ComponentPropsWithoutRef<'a'>) {
  return (
    <a target="_blank" rel="noopener noreferrer" {...props}>
      {children}
      <span className="sr-only"> (opens in new tab)</span>
    </a>
  );
}

export function Lede({ children }: { children: ReactNode }) {
  return <div className="lede">{children}</div>;
}

type SectionProps = {
  id?: string;
  label: string;
  more?: { href: string; label: string; context: string; external?: boolean };
  children: ReactNode;
};

export function IndexSection({ id, label, more, children }: SectionProps) {
  const moreText = more && (
    <>
      {more.label}
      <span className="sr-only"> {more.context}</span>{' '}
      <span aria-hidden="true">{more.external ? '↗' : '→'}</span>
    </>
  );
  return (
    <section id={id} className="index-section">
      <div className="index-label">
        <h2>{label}</h2>
        {more &&
          (more.external ? (
            <ExternalLink href={more.href} className="faint-link">
              {moreText}
            </ExternalLink>
          ) : (
            <Link href={more.href} className="faint-link">
              {moreText}
            </Link>
          ))}
      </div>
      {children}
    </section>
  );
}

type ListProps = {
  lead?: string;
  leadMobile?: string;
  children: ReactNode;
};

export function IndexList({ lead, leadMobile, children }: ListProps) {
  const columns = { '--c1': lead, '--c1m': leadMobile } as CSSProperties;
  return <ul style={columns}>{children}</ul>;
}

type RowProps = {
  href?: string;
  external?: boolean;
  lead: ReactNode;
  main: ReactNode;
  trail?: ReactNode;
  leadTone?: Tone;
  mainTone?: Tone;
  clip?: boolean;
  clipMobile?: boolean;
  stackTrail?: boolean;
};

export function IndexRow({
  href,
  external,
  lead,
  main,
  trail,
  leadTone = 'faint',
  mainTone = 'ink',
  clip,
  clipMobile,
  stackTrail,
}: RowProps) {
  const mainClass = [
    `tone-${mainTone}`,
    clip && 'index-clip',
    clip && clipMobile && 'index-clip-mobile',
  ]
    .filter(Boolean)
    .join(' ');
  const rowClass = stackTrail ? 'index-row index-row-stack' : 'index-row';
  const cells = (
    <>
      <span className={`index-cell-lead tone-${leadTone}`}>{lead}</span>
      <span className={`index-cell-main ${mainClass}`}>{main}</span>
      {trail && (
        <span
          className={
            stackTrail
              ? 'index-cell-trail tone-faint index-trail index-trail-stack'
              : 'index-cell-trail tone-faint index-trail'
          }
        >
          {trail}
        </span>
      )}
    </>
  );
  return (
    <li>
      {href && external ? (
        <ExternalLink href={href} className={rowClass}>
          {cells}
        </ExternalLink>
      ) : href ? (
        <Link href={href} className={rowClass}>
          {cells}
        </Link>
      ) : (
        <div className={rowClass}>{cells}</div>
      )}
    </li>
  );
}
