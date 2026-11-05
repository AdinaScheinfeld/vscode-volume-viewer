// Label colors shared by the niivue view and large-volume mode.
// Each overlay gets a "slot" so different segmentations get different colors.

// Binary masks (only label 1): one solid color per overlay.
const PALETTE: [number, number, number][] = [
  [0, 230, 60],    // green
  [255, 50, 50],   // red
  [50, 130, 255],  // blue
  [255, 220, 0],   // yellow
  [0, 230, 230],   // cyan
  [255, 0, 255],   // magenta
  [255, 140, 0],   // orange
  [160, 90, 255],  // purple
];

function hsv(hDeg: number): [number, number, number] {
  const h = (((hDeg % 360) + 360) % 360) / 60;
  const s = 0.85, v = 1.0;
  const c = v * s, x = c * (1 - Math.abs((h % 2) - 1)), m = v - c;
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// Color for `label` (>= 1) in the overlay using color slot `slot`.
export function labelRGB(label: number, slot: number, maxLabel: number): [number, number, number] {
  if (maxLabel <= 1) return PALETTE[slot % PALETTE.length];
  // Multi-label: golden-angle hues, shifted per overlay so two files don't share a color set.
  return hsv(label * 137.508 + slot * 67);
}

// Lowest free slot, so a removed overlay's color is reused first.
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
