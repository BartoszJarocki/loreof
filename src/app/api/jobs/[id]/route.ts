import { snapshotIdSchema } from '@/lib/schema';
import { getJob } from '@/server/catalog';
import { errorResponse, parseRequest } from '@/server/http';

export const runtime = 'nodejs';
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const job = await getJob(parseRequest(snapshotIdSchema, id));
    return job
      ? Response.json(job, { headers: { 'Cache-Control': 'no-store' } })
      : Response.json({ error: 'This processing job was not found.' }, { status: 404 });
  } catch (error) {
    return errorResponse(error, { operation: 'jobs.read' });
  }
}
