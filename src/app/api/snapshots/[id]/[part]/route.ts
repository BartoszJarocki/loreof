import { gzipSync } from 'node:zlib';
import { z } from 'zod';
import { snapshotIdSchema } from '@/lib/schema';
import { PARTS, type Part } from '@/lib/snapshot-pack';
import { parseRepository } from '@/server/github';
import { readSnapshotPart } from '@/server/storage';
import { errorResponse, parseRequest } from '@/server/http';
import { PublicError } from '@/server/config';

/** Only the three part paths carry `Content-Encoding: gzip` from next.config. */
async function gzipError(response: Response): Promise<Response> {
  const bytes = gzipSync(new Uint8Array(await response.arrayBuffer()));
  return new Response(new Uint8Array(bytes), {
    status: response.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

const isPart = (value: string): value is Part => (PARTS as readonly string[]).includes(value);

export const runtime = 'nodejs';
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; part: string }> },
): Promise<Response> {
  const { id, part } = await context.params;
  const name = part.toLowerCase();
  if (!isPart(name))
    return errorResponse(new PublicError('The request contains invalid data.', 400), {
      operation: 'snapshots.part',
    });
  try {
    const search = new URL(request.url).searchParams;
    const bytes = await readSnapshotPart(
      parseRepository(search.get('repo') ?? ''),
      parseRequest(snapshotIdSchema, id),
      name,
      parseRequest(z.string().max(64), search.get('v') ?? ''),
    );
    if (!bytes)
      return gzipError(
        Response.json(
          { error: 'This snapshot was not found.' },
          { status: 404, headers: { 'Cache-Control': 'no-store' } },
        ),
      );
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Length': String(bytes.length),
        'Cache-Control': 'public, max-age=31536000, s-maxage=86400, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return gzipError(errorResponse(error, { operation: 'snapshots.part' }));
  }
}
