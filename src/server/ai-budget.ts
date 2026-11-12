import { z } from 'zod';
import { key, redis } from './config';

const INPUT_MICRODOLLARS = 10;
const OUTPUT_MICRODOLLARS = 50;
const priceSchema = z.object({
  input: z.coerce.number().nonnegative(),
  output: z.coerce.number().nonnegative(),
  input_cache_write: z.coerce.number().nonnegative().optional(),
});
const modelsSchema = z.object({
  data: z.array(z.object({ id: z.string(), pricing: z.unknown() })),
});
const modelPriceSchema = priceSchema.extend({
  regional: z.record(z.string(), priceSchema).optional(),
});
let priceCheck:
  { model: string; expiresAt: number; allowed: boolean; input: number; output: number } | undefined;

export type Usage = { inputTokens?: number; outputTokens?: number };

const DEFAULT_MONTHLY_USD = 20;
let monthlyLimit: number | null | undefined;

function monthlyUsd(): number | null {
  if (monthlyLimit !== undefined) return monthlyLimit;
  const raw = process.env.LORE_AI_MONTHLY_USD;
  const value = raw === undefined || raw === '' ? DEFAULT_MONTHLY_USD : Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > DEFAULT_MONTHLY_USD) {
    console.error('lore.ai-budget-invalid', {
      variable: 'LORE_AI_MONTHLY_USD',
      value: raw,
      reason: `must be a number above 0 and at most ${DEFAULT_MONTHLY_USD}`,
    });
    monthlyLimit = null;
    return null;
  }
  monthlyLimit = value;
  return value;
}

export const AI_BUDGET_SCRIPT = `
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local reserved = tonumber(ARGV[1])
if used + reserved > tonumber(ARGV[2]) then return 0 end
redis.call('INCRBY', KEYS[1], reserved)
redis.call('EXPIRE', KEYS[1], 5356800)
return 1
`;

export function narrationReservation(prompt: string, outputTokens: number): number {
  return (
    (Buffer.byteLength(prompt, 'utf8') + 4096) * INPUT_MICRODOLLARS +
    outputTokens * OUTPUT_MICRODOLLARS
  );
}

export async function reserveNarration(
  model: string,
  prompt: string,
  outputTokens: number,
): Promise<((usage: Usage) => Promise<number>) | null> {
  const dollars = monthlyUsd();
  if (dollars === null) return null;
  if (!priceCheck || priceCheck.model !== model || priceCheck.expiresAt < Date.now()) {
    const response = await fetch('https://ai-gateway.vercel.sh/v1/models', {
      signal: AbortSignal.timeout(5000),
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const entry = modelsSchema
      .parse(await response.json())
      .data.find((value) => value.id === model);
    const modelPrice = entry ? modelPriceSchema.parse(entry.pricing) : null;
    const prices = modelPrice ? [modelPrice, ...Object.values(modelPrice.regional ?? {})] : [];
    const allowed =
      prices.length > 0 &&
      prices.every(
        (price) =>
          price.input * 1_000_000 <= INPUT_MICRODOLLARS &&
          price.output * 1_000_000 <= OUTPUT_MICRODOLLARS &&
          (price.input_cache_write ?? 0) * 1_000_000 <= INPUT_MICRODOLLARS,
      );
    priceCheck = {
      model,
      allowed,
      expiresAt: Date.now() + 300_000,
      input: Math.max(0, ...prices.flatMap((price) => [price.input, price.input_cache_write ?? 0])),
      output: Math.max(0, ...prices.map((price) => price.output)),
    };
  }
  if (!priceCheck.allowed) return null;
  const { input, output } = priceCheck;
  const month = key(`ai-reserved:${new Date().toISOString().slice(0, 7)}`);
  const reserved = narrationReservation(prompt, outputTokens);
  const accepted =
    (await redis().eval(AI_BUDGET_SCRIPT, [month], [reserved, Math.floor(dollars * 1_000_000)])) ===
    1;
  if (!accepted) return null;
  return async (usage) => {
    if (usage.inputTokens === undefined || usage.outputTokens === undefined) return reserved;
    const spent = Math.ceil((usage.inputTokens * input + usage.outputTokens * output) * 1_000_000);
    if (spent < reserved) await redis().decrby(month, reserved - spent);
    return Math.min(spent, reserved);
  };
}
