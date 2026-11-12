import { Suspense } from 'react';
import { GALLERY } from '@/lib/gallery';
import type { Manifest } from '@/lib/schema';
import { summary, years } from '@/lib/collection';
import { listGallery } from '@/server/catalog';
import { ConfigurationError, redis } from '@/server/config';
import { IndexList, IndexRow, IndexSection, Lede } from '@/components/Index';
import { NotConfigured } from '@/components/NotConfigured';
import { RepositoryForm } from '@/components/RepositoryForm';
import { Waitlist } from '@/components/Waitlist';
import './home.css';

async function Collection() {
  const gallery = await listGallery();
  const width = (pick: (manifest: Manifest) => string) =>
    `${Math.max(10, ...gallery.map((manifest) => pick(manifest).length))}ch`;
  return gallery.length ? (
    <IndexList lead={width((manifest) => manifest.repository.slug)} leadMobile="auto">
      {gallery.map((manifest) => (
        <IndexRow
          key={manifest.id}
          href={`/${manifest.repository.slug}?s=${manifest.id}`}
          lead={
            <span className="index-lead">
              <span className="index-owner tone-faint">{manifest.repository.owner}/</span>
              <span className="index-name">{manifest.repository.name}</span>
            </span>
          }
          leadTone="ink"
          main={summary(manifest)}
          mainTone="body"
          clip
          clipMobile
          trail={years(manifest)}
          stackTrail
        />
      ))}
    </IndexList>
  ) : (
    <p className="tone-body">The collection is being prepared. Read any public repository above.</p>
  );
}

export const dynamic = 'force-dynamic';
export default async function Home() {
  try {
    redis();
  } catch (error) {
    if (error instanceof ConfigurationError) return <NotConfigured home />;
    throw error;
  }
  return (
    <>
      <h1 className="sr-only">Lore</h1>
      <Lede>
        Watch a repository’s history. A point is a file, files that change together sit together,
        and each chapter links the commits behind it.
      </Lede>
      <RepositoryForm />
      <IndexSection id="collection" label="collection">
        <Suspense
          fallback={
            <p className="tone-faint" style={{ minHeight: `${GALLERY.length}lh` }}>
              Opening the collection…
            </p>
          }
        >
          <Collection />
        </Suspense>
      </IndexSection>
      <Waitlist />
    </>
  );
}
