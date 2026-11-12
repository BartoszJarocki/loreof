export type Rgb = [number, number, number];
export type Palette = Record<'bg' | 'ink' | 'body' | 'faint' | 'rule' | 'value', Rgb>;

const names = ['bg', 'ink', 'body', 'faint', 'rule', 'value'] as const;

/** Reads the color tokens as sRGB bytes. WebGL can't parse oklch, so a 1x1 canvas resolves them. */
export function readPalette(): Palette {
  const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!probe) throw new Error('This browser cannot read the page colors for the map.');
  const style = getComputedStyle(document.documentElement);
  const palette = {} as Palette;
  for (const name of names) {
    probe.fillStyle = '#000';
    probe.fillStyle = style.getPropertyValue(`--${name}`).trim();
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
    palette[name] = [r, g, b];
  }
  return palette;
}

export const css = ([r, g, b]: Rgb) => `rgb(${r} ${g} ${b})`;
