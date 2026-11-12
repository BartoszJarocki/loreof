import { IndexList, IndexRow, IndexSection, Lede } from './Index';
import type { Denial } from '@/server/github';

export type Outage = Exclude<Denial, 'missing' | 'not-configured'>;
export const outages: Record<Outage, string> = {
  'rate-limited': 'github is rate limiting lore, try again in a few minutes.',
  unreachable: 'github could not be reached, try again in a few minutes.',
};

export function GitHubOutage({ outage }: { outage: Outage }) {
  return (
    <>
      <h1 className="sr-only">GitHub unavailable</h1>
      <Lede>{outages[outage]}</Lede>
      <IndexSection label="503">
        <IndexList>
          <IndexRow href="/" lead="home" main="Back to the collection" />
        </IndexList>
      </IndexSection>
    </>
  );
}
