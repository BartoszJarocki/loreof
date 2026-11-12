import { NextResponse, type NextRequest } from 'next/server';
import { repositorySlugSchema } from '@/lib/schema';
import { ACCESS_HEADER, denial, type Denial } from '@/server/github';
import { assertReachable, assertVisible } from '@/server/storage';

async function access(slug: string, pinned: boolean): Promise<Denial | null> {
  try {
    await (pinned ? assertVisible(slug) : assertReachable(slug));
    return null;
  } catch (error) {
    return denial(error);
  }
}

export async function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.delete(ACCESS_HEADER);
  const [, owner, name] = request.nextUrl.pathname.split('/');
  const slug = repositorySlugSchema.safeParse(`${owner}/${name}`);
  const repository =
    owner !== 'api' && !request.headers.has('next-router-prefetch') && slug.success;
  const denied = repository
    ? await access(slug.data.toLowerCase(), request.nextUrl.searchParams.has('s'))
    : null;
  if (!denied) return NextResponse.next({ request: { headers } });
  headers.set(ACCESS_HEADER, denied);
  if (denied === 'missing') return NextResponse.next({ request: { headers } });
  const destination = denied === 'not-configured' ? '/_/not-configured' : `/_/github/${denied}`;
  const response = NextResponse.rewrite(new URL(destination, request.url), {
    status: 503,
  });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export const config = { matcher: '/:owner/:name' };
