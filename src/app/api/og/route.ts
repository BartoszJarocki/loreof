import { z } from 'zod';
import { snapshotIdSchema } from '@/lib/schema';
import { getManifest } from '@/server/catalog';
import { errorResponse, parseRequest } from '@/server/http';
import { renderStill } from '@/server/still';

export const runtime = 'nodejs';
const PARAMETERS = ['repo', 's', 'era'];

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const extra = [...new Set(url.searchParams.keys())].filter(
      (name) => !PARAMETERS.includes(name),
    );
    if (extra.length) {
      const [base, query = ''] = request.url.split('?');
      const kept = query.split('&').filter((pair) => {
        try {
          return PARAMETERS.includes(decodeURIComponent(pair.split('=')[0] ?? ''));
        } catch {
          return false;
        }
      });
      return Response.redirect(`${base}${kept.length ? `?${kept.join('&')}` : ''}`, 308);
    }
    const params = url.searchParams;
    const slug = params.get('repo') ?? '';
    const requestedId = params.get('s');
    const manifest = await getManifest(
      slug,
      requestedId ? parseRequest(snapshotIdSchema, requestedId) : undefined,
    );
    if (!manifest)
      return Response.json({ error: 'This repository snapshot was not found.' }, { status: 404 });
    const index = parseRequest(
      z.coerce
        .number()
        .int()
        .nonnegative()
        .max(manifest.eras.length - 1),
      params.get('era') ?? 0,
    );
    const png = await renderStill(manifest, index);
    return new Response(new Uint8Array(png), {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': requestedId
          ? 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=3600'
          : 'public, max-age=300, s-maxage=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return errorResponse(error, { operation: 'snapshots.render' });
  }
}
