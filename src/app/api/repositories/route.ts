import { z } from 'zod';
import { submitRepository } from '@/server/catalog';
import { errorResponse, mutationBody, parseRequest, requestIp } from '@/server/http';

export const runtime = 'nodejs';
export async function POST(request: Request): Promise<Response> {
  try {
    const input = parseRequest(
      z.object({ repository: z.string().min(1).max(250) }).strict(),
      await mutationBody(request),
    );
    const result = await submitRepository({ input: input.repository, ip: requestIp(request) });
    return Response.json(result, {
      status: result.kind === 'ready' ? 200 : 202,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return errorResponse(error, { operation: 'repositories.submit' });
  }
}
