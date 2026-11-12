import { z } from 'zod';
import { hash, hashIp, key, PublicError, redis } from './config';
import { parseRepository } from './github';

export const waitlistSchema = z
  .object({
    email: z.email().max(254),
    repository: z.string().max(250).optional(),
    consent: z.literal(true),
  })
  .strict();
export const WAITLIST_SCRIPT = `
if tonumber(redis.call('GET', KEYS[2]) or '0') >= 3 then return 'limited' end
redis.call('INCR', KEYS[2]); redis.call('EXPIRE', KEYS[2], 172800)
if redis.call('EXISTS', KEYS[1]) == 1 then return 'existing' end
redis.call('SET', KEYS[1], ARGV[1], 'EX', 15552000)
return 'saved'
`;

export async function joinWaitlist(
  input: z.infer<typeof waitlistSchema>,
  ip: string,
): Promise<void> {
  const email = input.email.trim().toLowerCase();
  const repository = input.repository ? parseRepository(input.repository) : undefined;
  const now = new Date().toISOString();
  const result = await redis().eval(
    WAITLIST_SCRIPT,
    [key(`waitlist:${hash(email)}`), key(`waitlist-ip:${now.slice(0, 10)}:${hashIp(ip)}`)],
    [
      JSON.stringify({
        email,
        repository,
        consent: true,
        consentVersion: 'private-repository-updates-v1',
        joinedAt: now,
      }),
    ],
  );
  if (result === 'limited')
    throw new PublicError('Too many signups today. Try again tomorrow.', 429);
}

export async function removeWaitlistEmail(value: string): Promise<void> {
  const email = z.email().max(254).parse(value.trim().toLowerCase());
  await redis().del(key(`waitlist:${hash(email)}`));
}
