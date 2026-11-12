import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { Analytics } from '@vercel/analytics/next';
import { SiteFooter, SiteHeader } from '@/components/Shell';
import { siteUrl } from '@/lib/site';
import './globals.css';

const GeistMono = localFont({
  src: '../fonts/GeistMono-Variable.woff2',
  variable: '--font-geist-mono',
  weight: '100 900',
  adjustFontFallback: false,
});

const GeistPixelSquare = localFont({
  src: '../fonts/GeistPixel-Square.woff2',
  variable: '--font-geist-pixel-square',
  weight: '500',
  adjustFontFallback: false,
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: 'lore', template: '%s · lore' },
  description:
    'watch a public github repository take shape. a point is a file, and each chapter links the commits behind it.',
};
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fafaf8' },
    { media: '(prefers-color-scheme: dark)', color: '#0d0c0a' },
  ],
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${GeistMono.variable} ${GeistPixelSquare.variable}`}>
      <body>
        <div className="page">
          <div className="column">
            <a className="skip-link" href="#main">
              skip to content
            </a>
            <SiteHeader />
            <main id="main" tabIndex={-1}>
              {children}
            </main>
            <SiteFooter />
          </div>
        </div>
        <Analytics />
      </body>
    </html>
  );
}
