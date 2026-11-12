const FORMATTING = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Repository text is attacker-chosen: strip characters that can reorder or hide
 * surrounding UI, then bound the length without splitting a surrogate pair.
 */
export function boundText(value: string, max: number): string {
  const clean = value.replace(FORMATTING, '');
  if (clean.length <= max) return clean;
  const points = Array.from(clean);
  if (points.length <= max) return clean;
  return `${points.slice(0, max).join('')}…`;
}
