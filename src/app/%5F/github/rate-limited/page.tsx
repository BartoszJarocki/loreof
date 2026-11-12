import type { Metadata } from 'next';
import { GitHubOutage } from '@/components/GitHubOutage';

export const metadata: Metadata = { title: 'github unavailable', robots: { index: false } };
export default function GitHubOutagePage() {
  return <GitHubOutage outage="rate-limited" />;
}
