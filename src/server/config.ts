import { createHash, createHmac } from 'node:crypto';
import { Redis } from '@upstash/redis';
import { PublicError } from '@/lib/public-error';

export { PublicError };

export class ConfigurationError extends PublicError {
  constructor() {
    super('Lore is not configured.', 503);
  }
}

const reported = new Set<string>();
function notConfigured(missing: string[]): never {
  const report = missing.join(',');
  if (!reported.has(report)) {
    reported.add(report);
    console.error('lore_not_configured', { missing });
  }
  throw new ConfigurationError();
}

export function redis(): Redis {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token)
    notConfigured([
      ...(!url ? ['KV_REST_API_URL or UPSTASH_REDIS_REST_URL'] : []),
      ...(!token ? ['KV_REST_API_TOKEN or UPSTASH_REDIS_REST_TOKEN'] : []),
    ]);
  return new Redis({ url, token });
}

export function key(value: string): string {
  return `${process.env.LORE_REDIS_PREFIX ?? 'lore:v1'}:${value}`;
}
export function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
export function hashIp(ip: string): string {
  const salt = process.env.LORE_IP_SALT;
  if (!salt) notConfigured(['LORE_IP_SALT']);
  return createHmac('sha256', salt).update(ip).digest('hex');
}
export function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid configuration ${name}`);
  return value;
}
