import { randomUUID } from 'node:crypto';
import { FatalError } from 'workflow';
import { z } from 'zod';
import { repositorySchema, type Repository, type Job } from '@/lib/schema';
import { hashIp, key, positiveEnv, PublicError, redis } from './config';

export const ADMISSION_SCRIPT = `
if redis.call('EXISTS', KEYS[8]) == 1 then return 'removed' end
local job = redis.call('GET', KEYS[1])
if job then
  local state = cjson.decode(job).state
  if state == 'ready' then return 'ready' end
  if state == 'failed' and cjson.decode(job).retryable == false then return 'refused' end
  if state == 'queued' or state == 'running' then
    local lease = tonumber(redis.call('ZSCORE', KEYS[5], ARGV[1]) or '0')
    local raw = redis.call('GET', KEYS[6])
    if lease > tonumber(ARGV[3]) and raw then
      local context = cjson.decode(raw)
      if context.attemptId then
        context.observedAt = math.max(context.observedAt, cjson.decode(ARGV[9]).observedAt)
        redis.call('SET', KEYS[6], cjson.encode(context), 'EX', 604800)
        return 'existing'
      end
    end
  end
end
redis.call('ZREMRANGEBYSCORE', KEYS[5], '-inf', ARGV[3])
if tonumber(redis.call('GET', KEYS[2]) or '0') >= tonumber(ARGV[5]) then return 'daily' end
if tonumber(redis.call('GET', KEYS[3]) or '0') >= tonumber(ARGV[6]) then return 'monthly' end
if tonumber(redis.call('GET', KEYS[4]) or '0') >= tonumber(ARGV[7]) then return 'ip' end
if redis.call('ZCARD', KEYS[5]) >= tonumber(ARGV[8]) then return 'concurrent' end
redis.call('INCR', KEYS[2]); redis.call('EXPIRE', KEYS[2], 172800)
redis.call('INCR', KEYS[3]); redis.call('EXPIRE', KEYS[3], 5356800)
redis.call('INCR', KEYS[4]); redis.call('EXPIRE', KEYS[4], 172800)
redis.call('ZADD', KEYS[5], ARGV[4], ARGV[1])
redis.call('SET', KEYS[1], ARGV[2], 'EX', 604800)
redis.call('SET', KEYS[6], ARGV[9], 'EX', 604800)
redis.call('SADD', KEYS[7], ARGV[1])
return 'admitted'
`;

export const attemptSchema = z.object({ id: z.string(), attemptId: z.string().uuid() });
export type JobAttempt = z.infer<typeof attemptSchema>;
const contextSchema = z.object({
  repository: repositorySchema,
  observedAt: z.number().int().nonnegative(),
  attemptId: attemptSchema.shape.attemptId,
});

export const ACTIVE_ATTEMPT_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw or cjson.decode(raw).attemptId ~= ARGV[1] then return false end
local lease = tonumber(redis.call('ZSCORE', KEYS[2], ARGV[2]) or '0')
if lease <= tonumber(ARGV[3]) then return false end
local job = redis.call('GET', KEYS[3])
if not job then return false end
local state = cjson.decode(job).state
if state ~= 'queued' and state ~= 'running' then return false end
`;

export const UPDATE_JOB_SCRIPT =
  ACTIVE_ATTEMPT_SCRIPT +
  `
local update = cjson.decode(ARGV[4])
local state = update.state
local ttl = 604800
if state == 'failed' and update.retryable == false then ttl = 86400 end
redis.call('SET', KEYS[3], ARGV[4], 'EX', ttl)
if state == 'ready' or state == 'failed' then
  redis.call('ZREM', KEYS[2], ARGV[2])
else
  redis.call('ZADD', KEYS[2], ARGV[5], ARGV[2])
end
return true
`;

export const SAVE_NARRATION_SCRIPT =
  ACTIVE_ATTEMPT_SCRIPT +
  `
redis.call('SET', KEYS[4], ARGV[4], 'EX', 604800, 'NX')
return true
`;

export async function readAttempt(attempt: JobAttempt) {
  const raw = await redis().eval(
    ACTIVE_ATTEMPT_SCRIPT + 'return raw',
    [key(`context:${attempt.id}`), key('leases'), key(`job:${attempt.id}`)],
    [attempt.attemptId, attempt.id, Date.now()],
  );
  if (!raw) throw new FatalError('Repository processing attempt is no longer active.');
  return contextSchema.parse(typeof raw === 'string' ? JSON.parse(raw) : raw);
}

export type Admission =
  | {
      kind: 'admitted';
      attempt: JobAttempt;
      release: (failed: Extract<Job, { state: 'failed' }>) => Promise<boolean>;
    }
  | { kind: 'existing' }
  | { kind: 'ready' };

export async function admit({
  id,
  repository,
  ip,
  observedAt,
}: {
  id: string;
  repository: Repository;
  ip: string;
  observedAt: number;
}): Promise<Admission> {
  const attempt: JobAttempt = { id, attemptId: randomUUID() };
  const now = Date.now();
  const date = new Date(now).toISOString();
  const dailyKey = key(`daily:${date.slice(0, 10)}`);
  const monthlyKey = key(`monthly:${date.slice(0, 7)}`);
  const ipKey = key(`ip:${date.slice(0, 10)}:${hashIp(ip)}`);
  const job: Job = { id, slug: repository.slug, state: 'queued', updatedAt: date };
  const result = z
    .enum([
      'admitted',
      'existing',
      'ready',
      'refused',
      'daily',
      'monthly',
      'ip',
      'concurrent',
      'removed',
    ])
    .parse(
      await redis().eval(
        ADMISSION_SCRIPT,
        [
          key(`job:${id}`),
          dailyKey,
          monthlyKey,
          ipKey,
          key('leases'),
          key(`context:${id}`),
          key(`snapshots:${repository.slug}`),
          key(`removed:${repository.slug}`),
        ],
        [
          id,
          JSON.stringify(job),
          now,
          now + 20 * 60_000,
          positiveEnv('LORE_DAILY_LIMIT', 10),
          positiveEnv('LORE_MONTHLY_LIMIT', 100),
          positiveEnv('LORE_IP_DAILY_LIMIT', 3),
          positiveEnv('LORE_CONCURRENT_LIMIT', 2),
          JSON.stringify({ repository, observedAt, attemptId: attempt.attemptId }),
        ],
      ),
    );
  if (result === 'removed')
    throw new PublicError('This repository has been removed from Lore.', 410);
  if (result === 'refused') {
    const refused = z.object({ message: z.string() }).parse(await redis().get(key(`job:${id}`)));
    throw new PublicError(refused.message, 422);
  }
  if (result === 'daily')
    throw new PublicError(
      `lore has read today's share of new repositories. ${resets(now, 'day')}`,
      429,
    );
  if (result === 'monthly')
    throw new PublicError(
      `lore has read this month's share of new repositories. ${resets(now, 'month')}`,
      429,
    );
  if (result === 'ip')
    throw new PublicError(
      `you have started today's share of new repositories. ${resets(now, 'day')}`,
      429,
    );
  if (result === 'concurrent')
    throw new PublicError('lore is reading other repositories. try again in a few minutes.', 429);
  if (result !== 'admitted') return { kind: result };
  return {
    kind: result,
    attempt,
    release: (failed) => releaseAdmission(attempt, failed, [dailyKey, monthlyKey, ipKey]),
  };
}

export function resets(now: number, period: 'day' | 'month'): string {
  const date = new Date(now);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const reset =
    period === 'day' ? Date.UTC(year, month, date.getUTCDate() + 1) : Date.UTC(year, month + 1, 1);
  if (period === 'month')
    return `it resets on ${new Date(reset).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' }).toLowerCase()} at 00:00 utc.`;
  const minutes = Math.ceil((reset - now) / 60_000);
  return `it resets at 00:00 utc, in ${Math.floor(minutes / 60)} h ${minutes % 60} min.`;
}

export const RELEASE_ADMISSION_SCRIPT =
  ACTIVE_ATTEMPT_SCRIPT +
  `
redis.call('SET', KEYS[3], ARGV[4], 'EX', 604800)
redis.call('ZREM', KEYS[2], ARGV[2])
for index = 4, #KEYS do
  if tonumber(redis.call('GET', KEYS[index]) or '0') > 0 then redis.call('DECR', KEYS[index]) end
end
return true
`;

async function releaseAdmission(
  attempt: JobAttempt,
  failed: Extract<Job, { state: 'failed' }>,
  charges: string[],
): Promise<boolean> {
  return Boolean(
    await redis().eval(
      RELEASE_ADMISSION_SCRIPT,
      [key(`context:${attempt.id}`), key('leases'), key(`job:${attempt.id}`), ...charges],
      [attempt.attemptId, attempt.id, Date.now(), JSON.stringify(failed)],
    ),
  );
}

export async function updateJob(attempt: JobAttempt, job: Job): Promise<boolean> {
  if (job.id !== attempt.id) throw new Error('Job attempt identity mismatch.');
  const now = Date.now();
  return Boolean(
    await redis().eval(
      UPDATE_JOB_SCRIPT,
      [key(`context:${attempt.id}`), key('leases'), key(`job:${attempt.id}`)],
      [attempt.attemptId, attempt.id, now, JSON.stringify(job), now + 20 * 60_000],
    ),
  );
}
