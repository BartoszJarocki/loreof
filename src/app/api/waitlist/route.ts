import { errorResponse, mutationBody, parseRequest, requestIp } from '@/server/http';
import { joinWaitlist, waitlistSchema } from '@/server/waitlist';

export const runtime = 'nodejs';
export async function POST(request: Request): Promise<Response> {
  try {
    await joinWaitlist(
      parseRequest(waitlistSchema, await mutationBody(request)),
      requestIp(request),
    );
    return Response.json({ ok: true }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return errorResponse(error, { operation: 'waitlist.join' });
  }
}
