// Label colors shared by the niivue view and large-volume mode.

import { PALETTE_DATA } from './palettes';

// Colormap values for label overlays: `solid:N` (every label one color) or `palette:N`.
const SOLID_PREFIX = 'solid:';
const PALETTE_PREFIX = 'palette:';

const SOLID: { name: string; rgb: [number, number, number] }[] = [
  { name: 'Green', rgb: [0, 230, 60] },
  { name: 'Red', rgb: [255, 50, 50] },
  { name: 'Blue', rgb: [50, 130, 255] },
  { name: 'Yellow', rgb: [255, 220, 0] },
  { name: 'Cyan', rgb: [0, 230, 230] },
  { name: 'Magenta', rgb: [255, 0, 255] },
  { name: 'Orange', rgb: [255, 140, 0] },
  { name: 'Purple', rgb: [160, 90, 255] },
];

export const SOLID_OPTIONS = SOLID.map((c, i) => ({ value: `${SOLID_PREFIX}${i}`, label: c.name }));
export const PALETTE_OPTIONS = PALETTE_DATA.map((p, i) => ({ value: `${PALETTE_PREFIX}${i}`, label: p.name }));

export const isLabelScheme = (cm: string) => cm.startsWith(SOLID_PREFIX) || cm.startsWith(PALETTE_PREFIX);

const DECODED: Uint8Array[] = PALETTE_DATA.map((p) => {
  const n = p.hex.length / 2;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(p.hex.substr(i * 2, 2), 16);
  return out;
});

export const solidName = (index: number) => `${SOLID_PREFIX}${index % SOLID.length}`;
export const paletteName = (index: number) => `${PALETTE_PREFIX}${index % DECODED.length}`;

// Color for `label` (>= 1). Label numbers past the end of a palette wrap around.
export function labelRGB(label: number, scheme: string): [number, number, number] {
  if (scheme.startsWith(SOLID_PREFIX)) return SOLID[Number(scheme.slice(SOLID_PREFIX.length)) % SOLID.length].rgb;
  const p = DECODED[Number(scheme.slice(PALETTE_PREFIX.length)) % DECODED.length];
  const i = ((label - 1) % (p.length / 3)) * 3;
  return [p[i], p[i + 1], p[i + 2]];
}

// Lowest free slot, so a removed overlay's color or palette is reused first.
export class SlotPool {
  private used = new Set<number>();
  take(): number {
    let s = 0;
    while (this.used.has(s)) s++;
    this.used.add(s);
    return s;
  }
  release(s: number) { this.used.delete(s); }
  clear() { this.used.clear(); }
}
