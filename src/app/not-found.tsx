import { IndexList, IndexRow, IndexSection, Lede } from '@/components/Index';

export default function NotFound() {
  return (
    <>
      <h1 className="sr-only">Not found</h1>
      <Lede>Nothing lives at this address, no repository and no page.</Lede>
      <IndexSection label="404">
        <IndexList>
          <IndexRow href="/" lead="home" main="Back to the collection" />
        </IndexList>
      </IndexSection>
    </>
  );
}
