import { IndexList, IndexRow, IndexSection, Lede } from './Index';

export function NotConfigured({ home = false }: { home?: boolean }) {
  return (
    <>
      <h1 className="sr-only">Lore is not configured</h1>
      <Lede>Lore is not configured. This deployment is missing its storage settings.</Lede>
      {!home && (
        <IndexSection label="503">
          <IndexList>
            <IndexRow href="/" lead="home" main="Back to the collection" />
          </IndexList>
        </IndexSection>
      )}
    </>
  );
}
