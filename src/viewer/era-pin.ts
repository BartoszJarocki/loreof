import type { Era } from '@/lib/schema';

type EraBoundary = Pick<Era, 'start' | 'end' | 'startTime' | 'endTime'>;

export function selectedEraForPin(eras: EraBoundary[], pin: string | null): number | null {
  if (pin === null || eras.length === 0) return null;
  if (/^\d+$/.test(pin)) {
    const lastCommit = Math.max(...eras.map((era) => era.end)) - 1;
    const cursor = Math.min(Number(pin), lastCommit);
    const index = eras.findIndex((era) => era.start <= cursor && cursor < era.end);
    return index === -1 ? eras.length - 1 : index;
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(pin)) return null;
  const time = Date.parse(`${pin}-01T00:00:00Z`) / 1000;
  let closest = 0;
  let distance = Infinity;
  for (const [index, era] of eras.entries()) {
    if (era.startTime <= time && time <= era.endTime) return index;
    const nextDistance = Math.min(Math.abs(era.startTime - time), Math.abs(era.endTime - time));
    if (nextDistance < distance) {
      closest = index;
      distance = nextDistance;
    }
  }
  return closest;
}
