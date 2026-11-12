import type { Metadata } from 'next';
import { ExternalLink, IndexList, IndexRow, IndexSection, Lede } from '@/components/Index';

export const metadata: Metadata = { title: 'about' };
export default function About() {
  return (
    <>
      <h1 className="sr-only">About</h1>
      <Lede>
        Lore turns the Git history of a public GitHub repository into a short film. A point is a
        file, files that change together sit together, and each chapter links the commits behind it.
      </Lede>
      <IndexSection label="lore">
        <IndexList>
          <IndexRow href="https://jarocki.me" external lead="by" main="Bartosz Jarocki" />
          <IndexRow
            href="https://github.com/BartoszJarocki/loreof"
            external
            lead="source"
            main="BartoszJarocki/loreof"
          />
          <IndexRow href="/_/method" lead="method" main="How Lore reads a repository" />
          <IndexRow href="/_/privacy" lead="privacy" main="What Lore stores" />
        </IndexList>
      </IndexSection>
      <div className="prose page-prose">
        <h2>A view, with limits</h2>
        <p>
          The film follows first-parent history. Its map is a reading of directory structure and of
          files that change together. It cannot tell you why someone made a change or what their
          work was worth. For that, follow a chapter to its commits, or{' '}
          <ExternalLink href="https://github.com/BartoszJarocki/loreof/issues">
            open an issue
          </ExternalLink>{' '}
          when a caption gets one wrong.
        </p>
      </div>
    </>
  );
}
