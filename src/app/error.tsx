'use client';
import { IndexList, IndexRow, IndexSection, Lede } from '@/components/Index';

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <>
      <h1 className="sr-only">Something went wrong</h1>
      <Lede>Lore could not open this page. The service may be down for a moment.</Lede>
      <p className="page-actions">
        <button className="text-button" onClick={reset}>
          try again
        </button>
      </p>
      <IndexSection label="500">
        <IndexList>
          <IndexRow href="/" lead="home" main="Back to the collection" />
        </IndexList>
      </IndexSection>
    </>
  );
}
