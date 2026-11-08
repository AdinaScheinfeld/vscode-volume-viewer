// Large-volume mode: full-resolution orthogonal slices drawn straight from the raw voxel data.
// Used when a volume is too big for niivue (which needs a 4-byte-per-voxel GPU texture).
// Voxels are kept in 16M-element chunks (no single huge allocation). Files over ~1 GB
// uncompressed are decompressed as a stream; float / 32-bit data is then stored as 16-bit
// (exact range, 65536 levels). No 3D render.

import * as nifti from 'nifti-reader-js';
import { labelRGB } from './colors';

type TypedArray = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array;
type Ctor = { new (n: number): TypedArray; new (b: ArrayBuffer, o: number, n: number): TypedArray; BYTES_PER_ELEMENT: number };

const CTORS: Record<number, Ctor> = {
  2: Uint8Array, 4: Int16Array, 8: Int32Array, 16: Float32Array, 64: Float64Array,
  256: Int8Array, 512: Uint16Array, 768: Uint32Array,
} as any;
const TYPE_NAMES: Record<number, string> = {
  2: 'uint8', 4: 'int16', 8: 'int32', 16: 'float32', 64: 'float64', 256: 'int8', 512: 'uint16', 768: 'uint32',
};
const INT_TYPES = new Set([2, 4, 8, 256, 512, 768]);
// Types stored as-is; anything else is quantized to uint16 when streamed.
const NATIVE_TYPES = new Set([2, 4, 256, 512]);

// Thresholds for switching from niivue to this mode.
export const LARGE_VOXELS = 200e6;
export const MAX_TEXTURE_SIDE = 2048;
// Above this uncompressed size, never decompress into one buffer.
export const STREAM_BYTES = 1e9;

const SHIFT = 24;
const CHUNK = 1 << SHIFT;
const MASK = CHUNK - 1;

export function isGzip(buf: ArrayBuffer): boolean {
  const b = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  return b[0] === 0x1f && b[1] === 0x8b;
}

export interface NiftiPeek { dims: number[]; voxels: number; datatype: number; rawBytes: number }

function peekHeader(h: nifti.NIFTI1 | nifti.NIFTI2): NiftiPeek {
  const dims = h.dims.slice(1, 4).map((d) => Math.max(1, d));
  const voxels = dims[0] * dims[1] * dims[2];
  const bpe = CTORS[h.datatypeCode]?.BYTES_PER_ELEMENT ?? 4;
  const frames = Math.max(1, h.dims[0] >= 4 ? h.dims[4] : 1);
  return { dims, voxels, datatype: h.datatypeCode, rawBytes: voxels * bpe * frames };
}

// Header facts needed to decide which mode to use (null if not a readable NIfTI).
export function peekNifti(raw: ArrayBuffer): NiftiPeek | null {
  try {
    return nifti.isNIFTI(raw) ? peekHeader(nifti.readHeader(raw)) : null;
  } catch {
    return null;
  }
}

async function* gunzip(buf: ArrayBuffer): AsyncGenerator<Uint8Array> {
  const reader = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// Read just the header of a .nii.gz without decompressing the whole file.
async function gzHeaderBytes(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const out = new Uint8Array(1024);
  let n = 0;
  for await (const c of gunzip(buf)) {
    const take = Math.min(c.length, out.length - n);
    out.set(c.subarray(0, take), n);
    n += take;
    if (n >= out.length) break;
  }
  return out.buffer.slice(0, n);
}

export async function peekNiftiGz(buf: ArrayBuffer): Promise<NiftiPeek | null> {
  return peekNifti(await gzHeaderBytes(buf));
}

export function needsLargeMode(p: { dims: number[]; voxels: number }): boolean {
  return p.voxels > LARGE_VOXELS || Math.max(...p.dims) > MAX_TEXTURE_SIDE;
}

// Stream the first-frame voxels of a .nii.gz as typed blocks.
async function streamVoxels(
  buf: ArrayBuffer, voxOffset: number, C: Ctor, nvox: number,
  onBlock: (vals: TypedArray, start: number) => void, onProgress: (frac: number) => void,
) {
  const bpe = C.BYTES_PER_ELEMENT;
  let skip = voxOffset;
  let done = 0;
  const carry = new Uint8Array(8);
  let carryN = 0;
  let scratch = new ArrayBuffer(1 << 20);
  let lastReport = 0;
  for await (let c of gunzip(buf)) {
    if (skip > 0) {
      if (c.length <= skip) { skip -= c.length; continue; }
      c = c.subarray(skip);
      skip = 0;
    }
    const total = carryN + c.length;
    let count = Math.floor(total / bpe);
    if (done + count > nvox) count = nvox - done;
    if (count > 0) {
      const bytes = count * bpe;
      if (scratch.byteLength < bytes) scratch = new ArrayBuffer(bytes);
      const u8 = new Uint8Array(scratch, 0, bytes);
      u8.set(carry.subarray(0, carryN), 0);
      u8.set(c.subarray(0, bytes - carryN), carryN);
      onBlock(new C(scratch, 0, count), done);
      done += count;
      const rest = c.subarray(bytes - carryN);
      carryN = Math.min(rest.length, bpe);
      carry.set(rest.subarray(0, carryN), 0);
    } else {
      carry.set(c, carryN);
      carryN += c.length;
    }
    if (done >= nvox) break;
    if (done - lastReport > 20e6) { lastReport = done; onProgress(done / nvox); await new Promise((r) => setTimeout(r, 0)); }
  }
  if (done < nvox) throw new Error(`File ended early (${done} of ${nvox} voxels).`);
}

// A volume mapped onto RAS index space by axis permutation/flip (like niivue's reorientation, no resampling).
export class Vol {
  chunks: TypedArray[] = [];
  nvox = 0;
  datatype = 2;          // stored type
  origType = 2;          // type in the file
  quantized = false;     // float/32-bit data stored as 16-bit
  slope = 1;
  inter = 0;
  vdims: number[] = [1, 1, 1];
  D = [0, 0, 0];         // size along R, A, S
  step = [0, 0, 0];      // index step along R, A, S
  origin = 0;            // index of RAS (0,0,0)
  spacing = [1, 1, 1];   // mm along R, A, S
  axOf = [0, 1, 2];      // voxel axis feeding R, A, S
  flip = [false, false, false];
  frames = 1;
  gmin = 0;
  gmax = 0;

  private initGeometry(h: nifti.NIFTI1 | nifti.NIFTI2) {
    if (!CTORS[h.datatypeCode]) throw new Error(`NIfTI datatype ${h.datatypeCode} is not supported in large-volume mode.`);
    if (!h.littleEndian && CTORS[h.datatypeCode].BYTES_PER_ELEMENT > 1) throw new Error('Big-endian NIfTI is not supported in large-volume mode.');
    this.origType = this.datatype = h.datatypeCode;
    this.vdims = h.dims.slice(1, 4).map((d) => Math.max(1, d));
    this.frames = Math.max(1, h.dims[0] >= 4 ? h.dims[4] : 1);
    this.nvox = this.vdims[0] * this.vdims[1] * this.vdims[2];
    this.slope = h.scl_slope && isFinite(h.scl_slope) ? h.scl_slope : 1;
    this.inter = h.scl_slope && isFinite(h.scl_inter) ? h.scl_inter : 0;
    // Which voxel axis best matches each world axis, and its direction.
    const A = h.affine;
    const strides = [1, this.vdims[0], this.vdims[0] * this.vdims[1]];
    const used = new Set<number>();
    const pairs: { r: number; c: number; v: number }[] = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) pairs.push({ r, c, v: Math.abs(A[r][c]) });
    pairs.sort((a, b) => b.v - a.v);
    const assigned = [-1, -1, -1];
    for (const p of pairs) {
      if (assigned[p.r] >= 0 || used.has(p.c)) continue;
      assigned[p.r] = p.c;
      used.add(p.c);
    }
    for (let r = 0; r < 3; r++) {
      const c = assigned[r] >= 0 ? assigned[r] : r;
      const flip = A[r][c] < 0;
      this.axOf[r] = c;
      this.flip[r] = flip;
      this.D[r] = this.vdims[c];
      this.step[r] = flip ? -strides[c] : strides[c];
      if (flip) this.origin += (this.vdims[c] - 1) * strides[c];
      this.spacing[r] = Math.abs(h.pixDims[c + 1]) || 1;
    }
  }

  private scanRange() {
    let mn = Infinity, mx = -Infinity;
    for (const d of this.chunks) for (let i = 0; i < d.length; i++) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    this.gmin = mn * this.slope + this.inter;
    this.gmax = mx * this.slope + this.inter;
    if (this.slope < 0) [this.gmin, this.gmax] = [this.gmax, this.gmin];
  }

  // Whole file already in memory (uncompressed).
  static fromRaw(raw: ArrayBuffer): Vol {
    if (!nifti.isNIFTI(raw)) throw new Error('Not a NIfTI file.');
    const h = nifti.readHeader(raw);
    const v = new Vol();
    v.initGeometry(h);
    const C = CTORS[h.datatypeCode];
    const off = h.vox_offset;
    const data = off % C.BYTES_PER_ELEMENT === 0
      ? new C(raw, off, v.nvox)
      : new C(raw.slice(off, off + v.nvox * C.BYTES_PER_ELEMENT), 0, v.nvox);
    for (let s = 0; s < v.nvox; s += CHUNK) v.chunks.push(data.subarray(s, Math.min(v.nvox, s + CHUNK)));
    v.scanRange();
    return v;
  }

  // Large .nii.gz: stream-decompress into chunks; float / 32-bit data becomes 16-bit.
  static async fromGzipStream(buf: ArrayBuffer, onProgress: (msg: string) => void): Promise<Vol> {
    const h = nifti.readHeader(await gzHeaderBytes(buf));
    const v = new Vol();
    v.initGeometry(h);
    const C = CTORS[h.datatypeCode];
    const n = v.nvox;
    const alloc = (Store: Ctor) => {
      v.chunks = [];
      for (let s = 0; s < n; s += CHUNK) v.chunks.push(new Store(Math.min(CHUNK, n - s)));
    };
    if (NATIVE_TYPES.has(h.datatypeCode)) {
      alloc(C);
      await streamVoxels(buf, h.vox_offset, C, n, (vals, start) => {
        for (let k = 0; k < vals.length; ) {
          const i = start + k, ci = i >>> SHIFT, o = i & MASK;
          const take = Math.min(vals.length - k, CHUNK - o);
          (v.chunks[ci] as any).set(vals.subarray(k, k + take), o);
          k += take;
        }
      }, (f) => onProgress(`Decompressing… ${Math.round(f * 100)}%`));
      v.scanRange();
      return v;
    }
    // Pass 1: exact range.
    let mn = Infinity, mx = -Infinity;
    await streamVoxels(buf, h.vox_offset, C, n, (vals) => {
      for (let k = 0; k < vals.length; k++) { const x = vals[k]; if (x < mn) mn = x; if (x > mx) mx = x; }
    }, (f) => onProgress(`Reading value range (pass 1 of 2)… ${Math.round(f * 100)}%`));
    if (!isFinite(mn) || !isFinite(mx)) { mn = 0; mx = 1; }
    const range = mx > mn ? mx - mn : 1;
    // Pass 2: store as uint16 over [mn, mx].
    alloc(Uint16Array as any);
    const q = 65535 / range;
    await streamVoxels(buf, h.vox_offset, C, n, (vals, start) => {
      for (let k = 0; k < vals.length; k++) {
        const i = start + k;
        const x = vals[k];
        v.chunks[i >>> SHIFT][i & MASK] = x === x ? Math.round((x - mn) * q) : 0;
      }
    }, (f) => onProgress(`Decompressing (pass 2 of 2)… ${Math.round(f * 100)}%`));
    const s0 = v.slope, i0 = v.inter;
    v.datatype = 512;
    v.quantized = true;
    v.slope = (range / 65535) * s0;
    v.inter = mn * s0 + i0;
    v.gmin = mn * s0 + i0;
    v.gmax = mx * s0 + i0;
    if (s0 < 0) [v.gmin, v.gmax] = [v.gmax, v.gmin];
    return v;
  }

  get bytes() { return this.chunks.reduce((a, c) => a + c.byteLength, 0); }
  get isInt() { return INT_TYPES.has(this.datatype) && !this.quantized && this.slope === 1 && this.inter === 0; }
  get typeName() {
    const t = TYPE_NAMES[this.origType] ?? `type ${this.origType}`;
    return this.quantized ? `${t} (stored as 16-bit)` : t;
  }

  at(i: number) { return this.chunks[i >>> SHIFT][i & MASK]; }

  index(r: number, a: number, s: number) {
    return this.origin + r * this.step[0] + a * this.step[1] + s * this.step[2];
  }

  value(pos: number[]) {
    return this.at(this.index(pos[0], pos[1], pos[2])) * this.slope + this.inter;
  }

  voxelIndex(pos: number[]) {
    const v = [0, 0, 0];
    for (let r = 0; r < 3; r++) v[this.axOf[r]] = this.flip[r] ? this.D[r] - 1 - pos[r] : pos[r];
    return v;
  }

  // Robust range: 2nd-98th percentile of a strided sample.
  robust(): [number, number] {
    const stride = Math.max(1, Math.floor(this.nvox / 2e6));
    const s: number[] = [];
    for (let i = 0; i < this.nvox; i += stride) s.push(this.at(i) * this.slope + this.inter);
    s.sort((x, y) => x - y);
    const lo = s[Math.floor(s.length * 0.02)], hi = s[Math.floor(s.length * 0.98)];
    return hi > lo ? [lo, hi] : [this.gmin, this.gmax];
  }
}

// Load any NIfTI buffer (.nii or .nii.gz) for large-volume mode, streaming when it is big.
export async function loadVol(buf: ArrayBuffer, onProgress: (msg: string) => void): Promise<Vol> {
  if (!isGzip(buf)) return Vol.fromRaw(buf);
  const p = await peekNiftiGz(buf);
  if (p && p.rawBytes > STREAM_BYTES) return Vol.fromGzipStream(buf, onProgress);
  onProgress('Decompressing…');
  return Vol.fromRaw(nifti.decompress(buf) as ArrayBuffer);
}

// ---------- overlays ----------

export const LARGE_OVERLAY_CMAPS = ['red', 'green', 'blue', 'hot', 'gray'];

function rampColor(name: string, t: number): [number, number, number] {
  t = Math.min(1, Math.max(0, t));
  const c = Math.round(t * 255);
  switch (name) {
    case 'green': return [0, c, 0];
    case 'blue': return [0, 0, c];
    case 'gray': return [c, c, c];
    case 'hot': return [Math.min(255, c * 3), Math.min(255, Math.max(0, c * 3 - 255)), Math.max(0, c * 3 - 510)];
    default: return [c, 0, 0];
  }
}

class Overlay {
  visible = true;
  opacity = 0.5;
  cmap: string; // 'labels' or a ramp name
  lut: Uint8Array = new Uint8Array(0); // label colors (r,g,b per label)
  constructor(public vol: Vol, public name: string, public slot: number) {
    // Labels get a per-overlay color; continuous maps rotate through red, green, blue.
    this.cmap = vol.isInt && vol.gmax <= 65535 ? 'labels' : LARGE_OVERLAY_CMAPS[slot % 3];
    this.buildLut();
  }
  buildLut() {
    if (this.cmap !== 'labels') return;
    const max = Math.max(1, Math.round(this.vol.gmax));
    this.lut = new Uint8Array((max + 1) * 3);
    for (let i = 1; i <= max; i++) {
      const [r, g, b] = labelRGB(i, this.slot, max);
      this.lut[3 * i] = r; this.lut[3 * i + 1] = g; this.lut[3 * i + 2] = b;
    }
  }
}

export interface OverlayHandle {
  initialCmap: string;
  setVisible(on: boolean): void;
  setOpacity(op: number): void;
  setColormap(cm: string): void;
  remove(): void;
}

// ---------- viewer ----------

type PanelKind = 'coronal' | 'sagittal' | 'axial';
// u: screen x axis, v: screen y axis (drawn top = high index), f: fixed axis. 0=R, 1=A, 2=S.
const PANEL_AXES: Record<PanelKind, { u: number; v: number; f: number; left: string; top: string }> = {
  axial: { u: 0, v: 1, f: 2, left: 'L', top: 'A' },
  coronal: { u: 0, v: 2, f: 1, left: 'L', top: 'S' },
  sagittal: { u: 1, v: 2, f: 0, left: 'P', top: 'S' },
};

interface PanelState {
  kind: PanelKind;
  canvas: OffscreenCanvas | null;
  img: ImageData | null;
  dirty: boolean;
  zoom: number;
  panX: number;
  panY: number;
  rect: { x: number; y: number; w: number; h: number }; // panel cell on screen (device px)
  draw: { x: number; y: number; w: number; h: number }; // where the image is drawn
}

export class LargeVolumeViewer {
  private base!: Vol;
  private overlays: Overlay[] = [];
  private pos = [0, 0, 0];
  private lo = 0;
  private hi = 1;
  private view: 'multi' | PanelKind = 'multi';
  private panels: Record<PanelKind, PanelState>;
  private abort = new AbortController();
  private resizeObs: ResizeObserver;
  private raf = 0;

  constructor(private canvas: HTMLCanvasElement, private onLocation: (s: string) => void) {
    const mk = (kind: PanelKind): PanelState => ({
      kind, canvas: null, img: null, dirty: true, zoom: 1, panX: 0, panY: 0,
      rect: { x: 0, y: 0, w: 0, h: 0 }, draw: { x: 0, y: 0, w: 0, h: 0 },
    });
    this.panels = { coronal: mk('coronal'), sagittal: mk('sagittal'), axial: mk('axial') };
    this.resizeObs = new ResizeObserver(() => this.requestDraw());
    this.resizeObs.observe(canvas);
    this.bindEvents();
  }

  load(vol: Vol) {
    this.base = vol;
    this.pos = this.base.D.map((d) => Math.floor(d / 2));
    [this.lo, this.hi] = this.base.robust();
    this.markAll();
    this.emitLocation();
    const v = this.base;
    return {
      dims: v.vdims, frames: v.frames, typeName: v.typeName,
      mb: v.bytes / 1e6, isInt: v.isInt, gmin: v.gmin, gmax: v.gmax,
    };
  }

  // ---- contrast ----
  get range(): [number, number] { return [this.lo, this.hi]; }
  get fullRange(): [number, number] { return [this.base.gmin, this.base.gmax]; }
  get isInt() { return this.base.isInt; }
  robustRange(): [number, number] { return this.base.robust(); }
  setRange(lo: number, hi: number) {
    this.lo = lo; this.hi = hi > lo ? hi : lo + 1e-6;
    this.markAll();
  }

  setView(v: string) {
    this.view = v === 'axial' || v === 'coronal' || v === 'sagittal' ? v : 'multi';
    this.requestDraw();
  }

  // Radiological (default, like ITK-SNAP): patient right on screen left in axial and coronal views.
  private radiological = true;
  private isMirrored(axis: number) { return this.radiological && axis === 0; }
  setRadiological(on: boolean) {
    this.radiological = on;
    this.markAll();
  }

  // Slice API for the slider (axis 0 = sagittal/R, 1 = coronal/A, 2 = axial/S).
  sliceCount(axis: number) { return this.base ? this.base.D[axis] : 1; }
  getSlice(axis: number) { return this.pos[axis]; }
  setSlice(axis: number, k: number) { this.setPos(axis, k); }

  addOverlay(vol: Vol, name: string, slot: number): OverlayHandle {

    const b = this.base;
    if (vol.D.some((d, i) => d !== b.D[i])) {
      throw new Error(`In large-volume mode an overlay must have the same grid as the image (${b.vdims.join('×')}); ${name} is ${vol.vdims.join('×')}.`);
    }
    const ov = new Overlay(vol, name, slot);
    this.overlays.push(ov);
    this.markAll();
    this.emitLocation();
    return {
      initialCmap: ov.cmap,
      setVisible: (on) => { ov.visible = on; this.markAll(); },
      setOpacity: (op) => { ov.opacity = op; this.markAll(); },
      setColormap: (cm) => { ov.cmap = cm; ov.buildLut(); this.markAll(); },
      remove: () => { this.overlays = this.overlays.filter((o) => o !== ov); this.markAll(); this.emitLocation(); },
    };
  }

  destroy() {
    this.abort.abort();
    this.resizeObs.disconnect();
    cancelAnimationFrame(this.raf);
  }

  // ---- rendering ----

  private markAll() {
    for (const p of Object.values(this.panels)) p.dirty = true;
    this.requestDraw();
  }

  private requestDraw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  private renderSlice(p: PanelState) {
    const ax = PANEL_AXES[p.kind];
    const b = this.base;
    const Du = b.D[ax.u], Dv = b.D[ax.v];
    if (!p.canvas || p.canvas.width !== Du || p.canvas.height !== Dv) {
      p.canvas = new OffscreenCanvas(Du, Dv);
      p.img = new ImageData(Du, Dv);
    }
    const out = p.img!.data;
    const fixed = this.pos[ax.f];
    // Radiological convention: patient right on screen left, i.e. the R axis runs right-to-left.
    const mirror = this.isMirrored(ax.u);
    const su = mirror ? -b.step[ax.u] : b.step[ax.u], sv = b.step[ax.v];
    const uStart = mirror ? (Du - 1) * b.step[ax.u] : 0;
    const base0 = b.origin + fixed * b.step[ax.f];
    const ch = b.chunks;
    const d = ch[0];
    const scale = 255 / (this.hi - this.lo);
    const slope = b.slope, inter = b.inter, lo = this.lo;
    // Lookup table for 8/16-bit data.
    let lut: Uint8Array | null = null, lutOff = 0;
    if (d instanceof Uint8Array || d instanceof Int8Array || d instanceof Uint16Array || d instanceof Int16Array) {
      const signed = d instanceof Int8Array || d instanceof Int16Array;
      const bits = d.BYTES_PER_ELEMENT * 8;
      const n = 1 << bits;
      lutOff = signed ? n / 2 : 0;
      lut = new Uint8Array(n);
      for (let k = 0; k < n; k++) {
        const v = ((k - lutOff) * slope + inter - lo) * scale;
        lut[k] = v <= 0 ? 0 : v >= 255 ? 255 : v;
      }
    }
    for (let y = 0; y < Dv; y++) {
      let idx = base0 + uStart + (Dv - 1 - y) * sv;
      let o = y * Du * 4;
      for (let x = 0; x < Du; x++, idx += su, o += 4) {
        let g: number;
        if (lut) g = lut[ch[idx >>> 24][idx & 16777215] + lutOff];
        else { const v = (ch[idx >>> 24][idx & 16777215] * slope + inter - lo) * scale; g = v <= 0 ? 0 : v >= 255 ? 255 : v; }
        out[o] = out[o + 1] = out[o + 2] = g;
        out[o + 3] = 255;
      }
    }
    // Overlays (same grid as the base).
    for (const ov of this.overlays) {
      if (!ov.visible || ov.opacity <= 0) continue;
      const och = ov.vol.chunks, ob0 = ov.vol.origin + fixed * ov.vol.step[ax.f];
      const ou = mirror ? -ov.vol.step[ax.u] : ov.vol.step[ax.u], ovs = ov.vol.step[ax.v];
      const ouStart = mirror ? (Du - 1) * ov.vol.step[ax.u] : 0;
      const a = ov.opacity;
      const labels = ov.cmap === 'labels';
      const omin = ov.vol.gmin, orange = (ov.vol.gmax - ov.vol.gmin) || 1;
      for (let y = 0; y < Dv; y++) {
        let idx = ob0 + ouStart + (Dv - 1 - y) * ovs;
        let o = y * Du * 4;
        for (let x = 0; x < Du; x++, idx += ou, o += 4) {
          const raw = och[idx >>> 24][idx & 16777215];
          if (raw === 0) continue;
          let r: number, g: number, bb: number;
          if (labels) {
            const li = Math.round(raw) * 3;
            if (li < 0 || li >= ov.lut.length) continue;
            r = ov.lut[li]; g = ov.lut[li + 1]; bb = ov.lut[li + 2];
          } else {
            [r, g, bb] = rampColor(ov.cmap, ((raw * ov.vol.slope + ov.vol.inter) - omin) / orange);
          }
          out[o] = out[o] * (1 - a) + r * a;
          out[o + 1] = out[o + 1] * (1 - a) + g * a;
          out[o + 2] = out[o + 2] * (1 - a) + bb * a;
        }
      }
    }
    p.canvas.getContext('2d')!.putImageData(p.img!, 0, 0);
    p.dirty = false;
  }

  private layout(W: number, H: number) {
    const gap = 2;
    const visible: PanelKind[] = this.view === 'multi' ? ['coronal', 'sagittal', 'axial'] : [this.view];
    if (this.view === 'multi') {
      const w = (W - gap) / 2, h = (H - gap) / 2;
      this.panels.coronal.rect = { x: 0, y: 0, w, h };
      this.panels.sagittal.rect = { x: w + gap, y: 0, w, h };
      this.panels.axial.rect = { x: 0, y: h + gap, w, h };
    } else {
      this.panels[this.view].rect = { x: 0, y: 0, w: W, h: H };
    }
    const b = this.base;
    for (const k of visible) {
      const p = this.panels[k];
      const ax = PANEL_AXES[k];
      const mmW = b.D[ax.u] * b.spacing[ax.u], mmH = b.D[ax.v] * b.spacing[ax.v];
      const s = Math.min(p.rect.w / mmW, p.rect.h / mmH) * p.zoom;
      const w = mmW * s, h = mmH * s;
      p.draw = { x: p.rect.x + (p.rect.w - w) / 2 + p.panX, y: p.rect.y + (p.rect.h - h) / 2 + p.panY, w, h };
    }
    return visible;
  }

  private draw() {
    if (!this.base) return;
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(c.clientWidth * dpr)), H = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const visible = this.layout(W, H);
    const b = this.base;
    ctx.font = `${Math.round(13 * dpr)}px sans-serif`;
    for (const k of visible) {
      const p = this.panels[k];
      if (p.dirty || !p.canvas) this.renderSlice(p);
      const ax = PANEL_AXES[k];
      const { x, y, w, h } = p.draw;
      ctx.save();
      ctx.beginPath();
      ctx.rect(p.rect.x, p.rect.y, p.rect.w, p.rect.h);
      ctx.clip();
      // Smooth when shrinking, sharp voxels when magnified.
      ctx.imageSmoothingEnabled = w < b.D[ax.u];
      ctx.drawImage(p.canvas!, x, y, w, h);
      // Crosshair.
      const cu = this.isMirrored(ax.u) ? b.D[ax.u] - 1 - this.pos[ax.u] : this.pos[ax.u];
      const cx = x + ((cu + 0.5) / b.D[ax.u]) * w;
      const cy = y + ((b.D[ax.v] - 1 - this.pos[ax.v] + 0.5) / b.D[ax.v]) * h;
      ctx.strokeStyle = 'rgba(255,40,40,0.9)';
      ctx.lineWidth = Math.max(1, dpr);
      ctx.beginPath();
      ctx.moveTo(cx, p.rect.y); ctx.lineTo(cx, p.rect.y + p.rect.h);
      ctx.moveTo(p.rect.x, cy); ctx.lineTo(p.rect.x + p.rect.w, cy);
      ctx.stroke();
      // Orientation letters.
      ctx.fillStyle = 'rgba(200,200,200,0.8)';
      ctx.fillText(this.isMirrored(ax.u) ? 'R' : ax.left, p.rect.x + 4 * dpr, p.rect.y + p.rect.h / 2);
      ctx.fillText(ax.top, p.rect.x + p.rect.w / 2, p.rect.y + 16 * dpr);
      ctx.restore();
    }
    if (this.view === 'multi') {
      // Info panel where niivue would show the 3D render.
      const x0 = W / 2 + 12 * dpr, y0 = H / 2 + 24 * dpr, lh = 18 * dpr;
      ctx.fillStyle = 'rgba(220,220,220,0.85)';
      const lines = [
        'Large-volume mode (full resolution)',
        `${b.vdims.join(' × ')} · ${b.typeName} · ${(b.bytes / 1e6).toFixed(0)} MB`,
        'No 3D render at this size.',
        '',
        'click: move crosshair',
        'scroll: change slice (shift: ×10)',
        '⌘/ctrl + scroll or pinch: zoom',
        'drag: pan · double-click: reset view',
      ];
      lines.forEach((t, i) => ctx.fillText(t, x0, y0 + i * lh));
    }
  }

  // ---- interaction ----

  private panelAt(px: number, py: number): PanelState | null {
    const visible: PanelKind[] = this.view === 'multi' ? ['coronal', 'sagittal', 'axial'] : [this.view];
    for (const k of visible) {
      const r = this.panels[k].rect;
      if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h) return this.panels[k];
    }
    return null;
  }

  private emitLocation() {
    if (!this.base) return;
    const v = this.base.voxelIndex(this.pos);
    const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toPrecision(5));
    let s = `voxel ${v.join(',')} = ${fmt(this.base.value(this.pos))}`;
    for (const ov of this.overlays) s += ` · ${ov.name}: ${fmt(ov.vol.value(this.pos))}`;
    this.onLocation(s);
  }

  private setPos(axis: number, value: number) {
    const v = Math.max(0, Math.min(this.base.D[axis] - 1, Math.round(value)));
    if (v === this.pos[axis]) return;
    this.pos[axis] = v;
    for (const p of Object.values(this.panels)) if (PANEL_AXES[p.kind].f === axis) p.dirty = true;
    this.requestDraw();
    this.emitLocation();
  }

  private bindEvents() {
    const c = this.canvas;
    const signal = this.abort.signal;
    const dpr = () => window.devicePixelRatio || 1;
    const local = (e: MouseEvent) => {
      const r = c.getBoundingClientRect();
      return [(e.clientX - r.left) * dpr(), (e.clientY - r.top) * dpr()];
    };
    let down: { x: number; y: number; p: PanelState; moved: boolean } | null = null;
    let wheelAcc = 0;

    c.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !this.base) return;
      const [x, y] = local(e);
      const p = this.panelAt(x, y);
      if (p) down = { x: e.clientX, y: e.clientY, p, moved: false };
    }, { signal });
    window.addEventListener('mousemove', (e) => {
      if (!down) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (!down.moved && Math.hypot(dx, dy) < 4) return;
      down.moved = true;
      down.p.panX += dx * dpr(); down.p.panY += dy * dpr();
      down.x = e.clientX; down.y = e.clientY;
      this.requestDraw();
    }, { signal });
    window.addEventListener('mouseup', (e) => {
      if (!down) return;
      const d = down;
      down = null;
      if (d.moved) return;
      // Click: move the crosshair.
      const [x, y] = local(e);
      const ax = PANEL_AXES[d.p.kind];
      const b = this.base;
      const u = ((x - d.p.draw.x) / d.p.draw.w) * b.D[ax.u];
      const v = ((y - d.p.draw.y) / d.p.draw.h) * b.D[ax.v];
      if (u < 0 || v < 0 || u >= b.D[ax.u] || v >= b.D[ax.v]) return;
      this.setPos(ax.u, this.isMirrored(ax.u) ? b.D[ax.u] - 1 - Math.floor(u) : Math.floor(u));
      this.setPos(ax.v, b.D[ax.v] - 1 - Math.floor(v));
    }, { signal });
    c.addEventListener('dblclick', (e) => {
      const [x, y] = local(e);
      const p = this.panelAt(x, y);
      if (p) { p.zoom = 1; p.panX = 0; p.panY = 0; this.requestDraw(); }
    }, { signal });
    c.addEventListener('wheel', (e) => {
      if (!this.base) return;
      e.preventDefault();
      const [x, y] = local(e);
      const p = this.panelAt(x, y);
      if (!p) return;
      const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      if (e.ctrlKey || e.metaKey) {
        // Zoom about the cursor.
        const old = p.draw;
        const fu = (x - old.x) / old.w, fv = (y - old.y) / old.h;
        p.zoom = Math.min(64, Math.max(0.25, p.zoom * Math.exp(-delta * 0.002)));
        this.layout(this.canvas.width, this.canvas.height);
        p.panX += x - (p.draw.x + fu * p.draw.w);
        p.panY += y - (p.draw.y + fv * p.draw.h);
        this.requestDraw();
        return;
      }
      wheelAcc += delta;
      const steps = Math.trunc(wheelAcc / 50);
      if (!steps) return;
      wheelAcc -= steps * 50;
      const ax = PANEL_AXES[p.kind];
      this.setPos(ax.f, this.pos[ax.f] - steps * (e.shiftKey ? 10 : 1));
    }, { passive: false, signal });
  }
}

// Decompress a .nii.gz in one allocation (size known from the gzip trailer).
export function decompressNifti(buf: ArrayBuffer): ArrayBuffer {
  return nifti.decompress(buf) as ArrayBuffer;
}
