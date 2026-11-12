import { Geist } from '@/fonts/geist';

export default function PagesLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <div className={Geist.variable}>{children}</div>;
}
