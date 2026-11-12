import type { Metadata } from 'next';
import { ExternalLink, IndexList, IndexRow, IndexSection, Lede } from '@/components/Index';

export const metadata: Metadata = { title: 'privacy' };
export default function Privacy() {
  return (
    <>
      <h1 className="sr-only">Privacy</h1>
      <Lede>
        Lore reads public GitHub repositories only. It never asks for access to a private one.
      </Lede>
      <IndexSection label="what lore keeps">
        <IndexList lead="12ch">
          <IndexRow
            lead="repository"
            leadTone="ink"
            main="Public metadata, commit ids and subjects, file paths, and the map made from them."
            mainTone="body"
          />
          <IndexRow
            lead="authors"
            leadTone="ink"
            main="A GitHub handle when the commit’s noreply address names one, else a neutral label. Never an email address."
            mainTone="body"
          />
          <IndexRow
            lead="requests"
            leadTone="ink"
            main="Used to stop abuse and to limit expensive analysis."
            mainTone="body"
          />
          <IndexRow
            lead="analytics"
            leadTone="ink"
            main="Vercel Web Analytics counts page views and visits in aggregate."
            mainTone="body"
          />
          <IndexRow
            lead="email"
            leadTone="ink"
            main="Only if you join the list. Kept up to 180 days for one email when private repositories ship."
            mainTone="body"
          />
        </IndexList>
      </IndexSection>
      <div className="prose page-prose">
        <h2>Removal and corrections</h2>
        <p>
          To remove a repository’s data or a saved email, or to report a wrong account association,
          write through <ExternalLink href="https://jarocki.me">jarocki.me</ExternalLink> with the
          repository URL or the email you gave. Don’t submit secrets or private repository URLs.
        </p>
      </div>
    </>
  );
}
