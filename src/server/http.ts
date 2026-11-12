import { isIP } from 'node:net';
import { checkBotId } from 'botid/server';
import { z } from 'zod';
import { PublicError } from './config';

export function parseRequest<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new PublicError('The request contains invalid data.', 400);
  return result.data;
}

export function errorResponse(
  error: unknown,
  context: { operation: string } = { operation: 'unknown' },
): Response {
  if (error instanceof PublicError)
    return Response.json(
      { error: error.message },
      { status: error.status, headers: { 'Cache-Control': 'no-store' } },
    );
  console.error('request_failed', { ...context, error });
  return Response.json(
    { error: 'Lore is temporarily unavailable. Please try again shortly.' },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function mutationBody(request: Request): Promise<unknown> {
  const origin = request.headers.get('origin');
  const expected = new URL(request.url).origin;
  if (!origin || origin !== expected)
    throw new PublicError('This request must come from the Lore website.', 403);
  if (request.headers.get('sec-fetch-site') === 'cross-site')
    throw new PublicError('Cross-site requests are not accepted.', 403);
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
  )
    throw new PublicError('Send a JSON request.', 415);
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > 4096) throw new PublicError('This request is too large.', 413);
  const verification = await checkBotId();
  if (verification.isBot !== false)
    throw new PublicError('This request could not be verified. Please use your browser.', 403);
  if (!request.body) throw new PublicError('A JSON request body is required.');
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 4096) throw new PublicError('This request is too large.', 413);
      parts.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new PublicError('The request contains invalid JSON.', 400);
    throw error;
  }
}

export function requestIp(request: Request): string {
  const forwarded =
    request.headers.get('x-vercel-forwarded-for') ?? request.headers.get('x-forwarded-for') ?? '';
  return rateLimitIdentity(forwarded.split(',')[0]?.trim() ?? '');
}

function rateLimitIdentity(value: string): string {
  const address = value.trim().toLowerCase();
  const version = isIP(address);
  if (version === 4) return value.trim();
  if (version !== 6) return 'unknown';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped) return mapped[1]!;
  const [head = '', tail = ''] = address.split('::');
  const leading = head ? head.split(':') : [];
  const trailing = tail ? tail.split(':') : [];
  const groups = [
    ...leading,
    ...Array<string>(8 - leading.length - trailing.length).fill('0'),
    ...trailing,
  ];
  return groups
    .slice(0, 4)
    .map((group) => group.padStart(4, '0'))
    .join(':');
}
