import type { Metadata } from 'next';
import { cache } from 'react';
import { headers } from 'next/headers';
import { notFound, permanentRedirect } from 'next/navigation';
import { ACCESS_HEADER, viewRepository } from '@/server/catalog';
import { repositorySlugSchema, snapshotIdSchema } from '@/lib/schema';
import { selectedEraForPin } from '@/viewer/era-pin';
import { storyOf } from '@/lib/snapshot-pack';
import { RepositoryViewer } from '@/components/RepositoryViewer';
import { RepositoryProgress } from '@/components/RepositoryProgress';
import { GitHubOutage, outages } from '@/components/GitHubOutage';
import { NotConfigured } from '@/components/NotConfigured';

type Props = {
  params: Promise<{ owner: string; name: string }>;
  searchParams: Promise<{ s?: string | string[]; t?: string | string[] }>;
};
export const dynamic = 'force-dynamic';

const loadView = cache(viewRepository);

async function resolve(props: Props) {
  const { owner, name } = await props.params;
  const search = await props.searchParams;
  const slug = repositorySlugSchema.safeParse(`${owner}/${name}`);
  if (!slug.success) notFound();
  const pin = snapshotIdSchema.safeParse(search.s);
  if (search.s !== undefined && !pin.success) notFound();
  const timePin = typeof search.t === 'string' ? search.t : null;
  if ((await headers()).get(ACCESS_HEADER) === 'missing') notFound();
  const view = await loadView(slug.data, pin.success ? pin.data : undefined);
  if (view.kind === 'missing') notFound();
  if (view.kind === 'moved') {
    const query = new URLSearchParams();
    if (pin.success) query.set('s', pin.data);
    if (timePin !== null) query.set('t', timePin);
    const queryString = query.toString();
    permanentRedirect(`/${view.slug}${queryString ? `?${queryString}` : ''}`);
  }
  return { owner, name, view, timePin };
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { owner, name, view, timePin } = await resolve(props);
  const defaultTitle = `${owner}/${name}, through time`;
  if (view.kind !== 'ready')
    return {
      title: defaultTitle,
      description:
        view.kind === 'uncached'
          ? 'Lore is reading this public repository’s Git history.'
          : view.kind === 'not-configured'
            ? 'Lore is not configured.'
            : outages[view.kind],
      robots: { index: false, follow: false },
    };
  const { manifest } = view;
  const eraIndex = selectedEraForPin(manifest.eras, timePin);
  const chapter = eraIndex === null ? null : manifest.eras[eraIndex];
  const title = chapter ? `${owner}/${name} · ${chapter.title}` : defaultTitle;
  const headline =
    chapter?.beats.find((beat) => beat.ref === chapter.headline) ?? chapter?.beats[0];
  const description =
    (headline?.kind === 'commit' ? headline.subject : headline?.text) ||
    manifest.repository.description ||
    undefined;
  const image = `/api/og?repo=${encodeURIComponent(manifest.repository.slug)}&s=${manifest.id}&era=${eraIndex ?? 0}`;
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: [
        {
          url: image,
          width: 1200,
          height: 630,
          alt: chapter
            ? `${owner}/${name} · ${chapter.title}`
            : `${owner}/${name} repository history`,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [image],
    },
  };
}

export default async function RepositoryPage(props: Props) {
  const { view, timePin } = await resolve(props);
  if (view.kind === 'ready')
    return (
      <RepositoryViewer
        key={view.manifest.id}
        story={storyOf(view.manifest)}
        timePin={timePin}
        debug={process.env.NODE_ENV !== 'production'}
      />
    );
  if (view.kind === 'uncached') return <RepositoryProgress slug={view.slug} />;
  if (view.kind === 'not-configured') return <NotConfigured />;
  return <GitHubOutage outage={view.kind} />;
}
