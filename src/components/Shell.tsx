'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ExternalLink } from './Index';

const sections = [
  { href: '/#collection', path: '/', label: 'collection' },
  { href: '/_/method', path: '/_/method', label: 'method' },
  { href: '/_/about', path: '/_/about', label: 'about' },
];

export function SiteHeader() {
  const pathname = usePathname();
  return (
    <header className="site-header">
      <Link href="/" className="name">
        lore
      </Link>
      <nav className="site-nav" aria-label="site">
        {sections.map((section) => (
          <Link
            key={section.label}
            href={section.href}
            aria-current={pathname === section.path ? 'page' : undefined}
            className="faint-link"
          >
            {section.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <Link href="/_/privacy" className="faint-link">
        privacy
      </Link>
      <ExternalLink href="https://github.com/BartoszJarocki/loreof" className="faint-link">
        source <span aria-hidden="true">↗</span>
      </ExternalLink>
      <ExternalLink href="https://jarocki.me" className="faint-link">
        jarocki.me <span aria-hidden="true">↗</span>
      </ExternalLink>
    </footer>
  );
}
