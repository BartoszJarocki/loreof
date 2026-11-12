import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';

export async function blobProxy(
  intercept: (method: string, path: string) => Promise<number | void>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = process.env.VERCEL_BLOB_API_URL;
  const upstream = previous ?? 'https://vercel.com/api/blob';
  const proxy = createServer(async (request, response) => {
    try {
      const pathname =
        new URL(request.url ?? '/', 'http://localhost').searchParams.get('pathname') ?? '';
      const status = await intercept(request.method ?? '', pathname);
      if (status) {
        response.writeHead(status, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            error: { code: 'forbidden', message: 'Injected Blob service failure' },
          }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers))
        if (value !== undefined && !['host', 'connection', 'content-length'].includes(name))
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      const body = Buffer.concat(chunks);
      const result = await fetch(upstream + (request.url ?? '/'), {
        method: request.method,
        headers,
        body: body.length ? new Uint8Array(body) : undefined,
      });
      response.statusCode = result.status;
      for (const [name, value] of result.headers)
        if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(name))
          response.setHeader(name, value);
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      response.writeHead(502).end('Test proxy failed');
    }
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const address = proxy.address();
  assert.ok(address && typeof address !== 'string');
  process.env.VERCEL_BLOB_API_URL = `http://127.0.0.1:${address.port}`;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.VERCEL_BLOB_API_URL;
    else process.env.VERCEL_BLOB_API_URL = previous;
    proxy.close();
  }
}
