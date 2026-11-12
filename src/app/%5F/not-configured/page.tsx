import type { Metadata } from 'next';
import { NotConfigured } from '@/components/NotConfigured';

export const metadata: Metadata = { title: 'not configured', robots: { index: false } };
export default function NotConfiguredPage() {
  return <NotConfigured />;
}
