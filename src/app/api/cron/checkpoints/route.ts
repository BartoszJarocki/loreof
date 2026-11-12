import { timingSafeEqual } from 'node:crypto';
import { sweepCheckpoints } from '@/server/storage';

export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return new Response('Cleanup is not configured.', { status: 503 });
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(request.headers.get('authorization') ?? '');
  if (expected.length !== received.length || !timingSafeEqual(expected, received))
    return new Response('Unauthorized', { status: 401 });
  return Response.json(await sweepCheckpoints());
}
