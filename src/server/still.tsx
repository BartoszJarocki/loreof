import { ImageResponse } from 'next/og';
import type { SnapshotMeta } from '@/lib/schema';
import { siteHost } from '@/lib/site';

const clip = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length - 3)}...` : text;

export function stillImage(meta: SnapshotMeta, eraIndex: number) {
  const era = meta.eras[eraIndex];
  if (!era) throw new RangeError('This era was not found.');
  const headline = era.beats.find((beat) => beat.ref === era.headline) ?? era.beats[0];
  const caption = (headline?.kind === 'commit' ? headline.subject : headline?.text) || '';
  const touched = new Set(era.directories.map((directory) => directory.path));
  const projected = meta.directories.map((directory) => ({
    directory,
    x: directory.centroid[0] * 0.84 + directory.centroid[2] * 0.54,
    y: directory.centroid[1] * 0.9 - directory.centroid[2] * 0.18,
  }));
  const xs = projected.map((point) => point.x);
  const ys = projected.map((point) => point.y);
  const minX = Math.min(0, ...xs);
  const maxX = Math.max(1, ...xs);
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(1, ...ys);
  const scale = Math.min(1020 / (maxX - minX), 300 / (maxY - minY));
  const largest = Math.max(1, ...meta.directories.map((directory) => directory.files));
  const text = { position: 'absolute', display: 'flex' } as const;
  return (
    <div style={{ display: 'flex', width: 1200, height: 630, background: '#0b0c10' }}>
      <div
        style={{
          ...text,
          left: 40,
          top: 40,
          width: 1120,
          height: 550,
          borderRadius: 16,
          background: '#11131a',
          border: '1px solid #292b35',
        }}
      />
      <svg width="1200" height="630" viewBox="0 0 1200 630" style={{ position: 'absolute' }}>
        {projected.map(({ directory, x, y }) => (
          <circle
            key={directory.path}
            cx={(600 + (x - (minX + maxX) / 2) * scale).toFixed(2)}
            cy={(327 + (y - (minY + maxY) / 2) * scale).toFixed(2)}
            r={(2 + 14 * Math.sqrt(directory.files / largest)).toFixed(2)}
            fill={directory.color}
            fillOpacity={touched.has(directory.path) ? 0.9 : 0.3}
          />
        ))}
      </svg>
      <div style={{ ...text, left: 76, top: 68, fontSize: 24, color: '#ff745d' }}>lore</div>
      <div style={{ ...text, right: 76, top: 72, fontSize: 18, color: '#b9b9c6' }}>
        {meta.repository.slug}
      </div>
      <div style={{ ...text, left: 76, top: 124, fontSize: 32, color: '#f4f1ec' }}>
        {clip(era.title, 68)}
      </div>
      <div style={{ ...text, left: 76, top: 504, width: 1048, fontSize: 15, color: '#d0ced4' }}>
        {clip(caption, 130)}
      </div>
      <div style={{ ...text, left: 76, top: 546, fontSize: 14, color: '#9997a3' }}>
        {`first-parent history · ${meta.directories.length.toLocaleString('en-US')} directories · era ${eraIndex + 1} of ${meta.eras.length}`}
      </div>
      <div style={{ ...text, right: 76, top: 546, fontSize: 14, color: '#9997a3' }}>{siteHost}</div>
    </div>
  );
}

export async function renderStill(meta: SnapshotMeta, eraIndex: number): Promise<Buffer> {
  const image = new ImageResponse(stillImage(meta, eraIndex), { width: 1200, height: 630 });
  return Buffer.from(await image.arrayBuffer());
}
