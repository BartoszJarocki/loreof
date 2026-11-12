import { key, redis } from './config';

export async function observeRepository(): Promise<number> {
  const value = Number(
    await redis().eval(
      "local previous = tonumber(redis.call('GET', KEYS[1]) or '0'); local value = math.max(tonumber(ARGV[1]), previous + 1); redis.call('SET', KEYS[1], value); return value",
      [key('observations')],
      [Date.now()],
    ),
  );
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid repository observation time');
  return value;
}
