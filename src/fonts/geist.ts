import localFont from 'next/font/local';

export const Geist = localFont({
  src: './Geist-Variable.woff2',
  variable: '--font-geist-sans',
  weight: '100 900',
  adjustFontFallback: false,
});
