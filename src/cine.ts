// 2D / cine DICOM player (ultrasound, X-ray, single images and clips).
// JPEG frames are decoded by the browser's native decoder (createImageBitmap);
// uncompressed frames are converted to RGBA directly.

import * as dicomParser from 'dicom-parser';

const JPEG_TS = new Set(['1.2.840.10008.1.2.4.50', '1.2.840.10008.1.2.4.51']);
const NATIVE_TS = new Set(['1.2.840.10008.1.2', '1.2.840.10008.1.2.1']);
const CACHE_BYTES = 768e6;

export function isDicom(name: string, buf: ArrayBuffer): boolean {
  if (/\.(dcm|dicom)$/i.test(name)) return true;
  if (buf.byteLength < 132) return false;
  const b = new Uint8Array(buf, 128, 4);
  return b[0] === 0x44 && b[1] === 0x49 && b[2] === 0x43 && b[3] === 0x4d; // "DICM"
}

export interface CineElements {
  canvas: HTMLCanvasElement;
  play: HTMLButtonElement;
  frame: HTMLInputElement;
  frameLbl: HTMLSpanElement;
  fps: HTMLInputElement;
  bri: HTMLInputElement;
  briLbl: HTMLSpanElement;
  con: HTMLInputElement;
  conLbl: HTMLSpanElement;
  auto: HTMLButtonElement;
  reset: HTMLButtonElement;
}

export interface CineInfo {
  cols: number;
  rows: number;
  nFrames: number;
  fps: number;
  codec: string;
  firstFrameMs: number;
}

type FrameDecoder = (i: number) => Promise<ImageBitmap>;

export class CinePlayer {
  private ds!: dicomParser.DataSet;
  private decode!: FrameDecoder;
  private cols = 0;
  private rows = 0;
  private nFrames = 1;
  private cache = new Map<number, ImageBitmap>();
  private pending = new Map<number, Promise<ImageBitmap>>();
  private maxCache = 64;
  private current = 0;
  private playing = false;
  private playStart = 0;
  private playStartFrame = 0;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private bright = 1;
  private contrast = 1;

  constructor(private readonly el: CineElements) {}

  async open(buf: ArrayBuffer): Promise<CineInfo> {
    const t0 = performance.now();
    const bytes = new Uint8Array(buf);
    this.ds = dicomParser.parseDicom(bytes);
    const ds = this.ds;
    const ts = (ds.string('x00020010') ?? '').trim().replace(/\0/g, '');
    this.rows = ds.uint16('x00280010') ?? 0;
    this.cols = ds.uint16('x00280011') ?? 0;
    this.nFrames = Math.max(1, parseInt(ds.string('x00280008') ?? '1', 10) || 1);
    const pixel = ds.elements['x7fe00010'];
    if (!pixel || !this.rows || !this.cols) throw new Error('No image data found in this DICOM file.');

    let codec: string;
    if (JPEG_TS.has(ts)) {
      codec = 'JPEG';
      this.decode = this.jpegDecoder(pixel);
    } else if (NATIVE_TS.has(ts) || ts === '') {
      codec = 'uncompressed';
      this.decode = this.nativeDecoder(pixel);
    } else {
      throw new Error(`This DICOM compression (transfer syntax ${ts}) isn't supported in the clip player yet.`);
    }

    this.maxCache = Math.max(8, Math.floor(CACHE_BYTES / (this.rows * this.cols * 4)));
    const fps = this.frameRate();
    this.el.fps.value = String(fps);
    this.el.frame.min = '0';
    this.el.frame.max = String(this.nFrames - 1);
    this.el.frame.value = '0';
    this.bindUi();

    await this.show(0);
    const firstFrameMs = Math.round(performance.now() - t0);
    this.prefetchAll();
    return { cols: this.cols, rows: this.rows, nFrames: this.nFrames, fps, codec, firstFrameMs };
  }

  // ---------- decoding ----------

  private frameRate(): number {
    const ds = this.ds;
    const cine = ds.intString('x00180040');
    const rec = ds.intString('x00082144');
    const ft = ds.floatString('x00181063');
    const fps = cine || rec || (ft ? 1000 / ft : 0) || 30;
    return Math.round(Math.min(Math.max(fps, 1), 120));
  }

  private jpegDecoder(pixel: dicomParser.Element): FrameDecoder {
    const ds = this.ds;
    const frags = pixel.fragments ?? [];
    let bot: number[] | undefined;
    const frameBytes = (i: number): Uint8Array => {
      if (this.nFrames === 1) return dicomParser.readEncapsulatedPixelDataFromFragments(ds, pixel, 0, frags.length);
      if (frags.length === this.nFrames) {
        const f = frags[i];
        return new Uint8Array(ds.byteArray.buffer, ds.byteArray.byteOffset + f.position, f.length);
      }
      if (!pixel.basicOffsetTable?.length && !bot) bot = dicomParser.createJPEGBasicOffsetTable(ds, pixel);
      return dicomParser.readEncapsulatedImageFrame(ds, pixel, i, bot);
    };
    return (i) => createImageBitmap(new Blob([frameBytes(i) as BlobPart], { type: 'image/jpeg' }));
  }

  private nativeDecoder(pixel: dicomParser.Element): FrameDecoder {
    const ds = this.ds;
    const samples = ds.uint16('x00280002') ?? 1;
    const bits = ds.uint16('x00280100') ?? 8;
    const signed = (ds.uint16('x00280103') ?? 0) === 1;
    const planar = ds.uint16('x00280006') ?? 0;
    const photometric = (ds.string('x00280004') ?? 'MONOCHROME2').trim();
    const n = this.rows * this.cols;
    const frameBytes = n * samples * (bits / 8);
    const buf = ds.byteArray.buffer as ArrayBuffer;
    const base = ds.byteArray.byteOffset + pixel.dataOffset;
    if (photometric === 'PALETTE COLOR') throw new Error('PALETTE COLOR DICOM is not supported yet.');
    if (bits !== 8 && bits !== 16) throw new Error(`${bits}-bit DICOM pixels are not supported yet.`);

    // Fixed grayscale window for 16-bit / signed data: from header or from the first frame.
    let lo = 0, hi = 255;
    if (samples === 1 && bits === 16) {
      const wc = ds.floatString('x00281050'), ww = ds.floatString('x00281051');
      const slope = ds.floatString('x00281053') ?? 1, icpt = ds.floatString('x00281052') ?? 0;
      if (wc !== undefined && ww) {
        lo = (wc - ww / 2 - icpt) / slope; hi = (wc + ww / 2 - icpt) / slope;
      } else {
        const a = this.rawFrame16(buf, base, 0, n, signed);
        const s = Array.from(a.filter((_, k) => k % 7 === 0)).sort((x, y) => x - y);
        lo = s[Math.floor(s.length * 0.01)]; hi = s[Math.floor(s.length * 0.99)];
      }
      if (hi <= lo) hi = lo + 1;
    }
    const invert = photometric === 'MONOCHROME1';

    return (i) => {
      const out = new ImageData(this.cols, this.rows);
      const d = out.data;
      const off = base + i * frameBytes;
      if (samples === 1) {
        const src = bits === 8 ? new Uint8Array(buf, off, n) : this.rawFrame16(buf, off, 0, n, signed);
        const scale = 255 / (hi - lo);
        for (let p = 0; p < n; p++) {
          let v = bits === 8 ? src[p] : Math.min(255, Math.max(0, (src[p] - lo) * scale));
          if (invert) v = 255 - v;
          d[4 * p] = d[4 * p + 1] = d[4 * p + 2] = v; d[4 * p + 3] = 255;
        }
      } else {
        const src = new Uint8Array(buf, off, n * 3);
        const ybr = photometric.startsWith('YBR');
        for (let p = 0; p < n; p++) {
          let r: number, g: number, b: number;
          if (planar === 0) { r = src[3 * p]; g = src[3 * p + 1]; b = src[3 * p + 2]; }
          else { r = src[p]; g = src[n + p]; b = src[2 * n + p]; }
          if (ybr) {
            const y = r, cb = g - 128, cr = b - 128;
            r = y + 1.402 * cr; g = y - 0.344136 * cb - 0.714136 * cr; b = y + 1.772 * cb;
          }
          d[4 * p] = r; d[4 * p + 1] = g; d[4 * p + 2] = b; d[4 * p + 3] = 255;
        }
      }
      return createImageBitmap(out);
    };
  }

  private rawFrame16(buf: ArrayBuffer, off: number, frame: number, n: number, signed: boolean) {
    const start = off + frame * n * 2;
    // Copy if unaligned (typed arrays need 2-byte alignment).
    const ab = start % 2 === 0 ? buf : buf.slice(start, start + n * 2);
    const o = start % 2 === 0 ? start : 0;
    return signed ? new Int16Array(ab, o, n) : new Uint16Array(ab, o, n);
  }

  private get(i: number): Promise<ImageBitmap> {
    const hit = this.cache.get(i);
    if (hit) {
      this.cache.delete(i); this.cache.set(i, hit); // refresh recency
      return Promise.resolve(hit);
    }
    if (!Number.isInteger(i) || i < 0 || i >= this.nFrames) {
      return Promise.reject(new Error(`frame ${i} out of range`));
    }
    let p = this.pending.get(i);
    if (!p) {
      // Wrap so a synchronous decode error becomes a rejected promise instead of a throw.
      p = Promise.resolve().then(() => this.decode(i)).then((bmp) => {
        this.pending.delete(i);
        this.cache.set(i, bmp);
        while (this.cache.size > this.maxCache) {
          const oldest = this.cache.keys().next().value as number;
          if (oldest === this.current) break;
          this.cache.get(oldest)?.close();
          this.cache.delete(oldest);
        }
        return bmp;
      }, (err) => {
        this.pending.delete(i);
        throw err;
      });
      this.pending.set(i, p);
    }
    return p;
  }

  private async prefetchAll() {
    const limit = Math.min(this.nFrames, this.maxCache);
    let next = 1;
    const worker = async () => {
      while (next < limit) {
        const i = next++;
        try { await this.get(i); } catch { /* shown when displayed */ }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }

  // ---------- display ----------

  private async show(i: number) {
    this.current = i;
    this.el.frame.value = String(i);
    this.el.frameLbl.textContent = `${i + 1} / ${this.nFrames}`;
    const bmp = await this.get(i);
    if (this.current === i) this.draw(bmp);
  }

  private redraw() {
    const bmp = this.cache.get(this.current);
    if (bmp) this.draw(bmp);
  }

  private draw(bmp: ImageBitmap) {
    const c = this.el.canvas;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(c.clientWidth * dpr));
    const H = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = 'none';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const s = Math.min(W / this.cols, H / this.rows) * this.zoom;
    const x = (W - this.cols * s) / 2 + this.panX;
    const y = (H - this.rows * s) / 2 + this.panY;
    ctx.imageSmoothingEnabled = this.zoom < 3;
    ctx.filter = `brightness(${this.bright}) contrast(${this.contrast})`;
    ctx.drawImage(bmp, x, y, this.cols * s, this.rows * s);
  }

  private setBC(b: number, c: number) {
    this.bright = b; this.contrast = c;
    this.el.bri.value = String(Math.round(b * 100));
    this.el.con.value = String(Math.round(c * 100));
    this.el.briLbl.textContent = `${Math.round(b * 100)}%`;
    this.el.conLbl.textContent = `${Math.round(c * 100)}%`;
    this.redraw();
  }

  // Stretch the 1st-99.5th luminance percentiles of the current frame to full range.
  autoContrast() {
    const bmp = this.cache.get(this.current);
    if (!bmp) return;
    const sc = Math.min(1, 256 / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * sc)), h = Math.max(1, Math.round(bmp.height * sc));
    const off = new OffscreenCanvas(w, h);
    const octx = off.getContext('2d')!;
    octx.drawImage(bmp, 0, 0, w, h);
    const d = octx.getImageData(0, 0, w, h).data;
    const hist = new Uint32Array(256);
    for (let p = 0; p < d.length; p += 4) hist[Math.round(0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2])]++;
    const total = w * h;
    const pct = (q: number) => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= q * total) return v; } return 255; };
    const lo = pct(0.01) / 255, hi = pct(0.995) / 255;
    if (hi - lo < 0.02) return;
    // brightness(b) then contrast(c): v -> (b*v - 0.5)*c + 0.5 ; want k*(v - lo), k = 1/(hi - lo)
    const k = 1 / (hi - lo);
    const c = 1 + 2 * k * lo;
    this.setBC(k / c, c);
  }

  private loopId = 0;

  private tick(id: number) {
    if (!this.playing || id !== this.loopId) return;
    // Schedule the next tick first so an error below can never stop playback.
    requestAnimationFrame(() => this.tick(id));
    const fps = Math.max(1, Number(this.el.fps.value) || 30);
    // performance.now() (not the rAF timestamp, which can be earlier than playStart).
    const elapsed = Math.max(0, performance.now() - this.playStart);
    const target = (this.playStartFrame + Math.floor((elapsed * fps) / 1000)) % this.nFrames;
    if (target === this.current) return;
    if (this.cache.has(target)) this.show(target).catch(() => {});
    else this.get(target).catch(() => {});
  }

  private setPlaying(on: boolean) {
    if (this.nFrames < 2) on = false;
    this.playing = on;
    this.el.play.textContent = on ? '⏸' : '▶';
    if (on) {
      this.playStart = performance.now();
      this.playStartFrame = this.current;
      const id = ++this.loopId; // only one playback loop at a time
      requestAnimationFrame(() => this.tick(id));
    }
  }

  private step(d: number) {
    this.setPlaying(false);
    this.show((this.current + d + this.nFrames) % this.nFrames);
  }

  private bindUi() {
    const el = this.el;
    el.play.disabled = this.nFrames < 2;
    el.frame.disabled = this.nFrames < 2;
    el.play.onclick = () => this.setPlaying(!this.playing);
    el.frame.oninput = () => { this.setPlaying(false); this.show(Number(el.frame.value)); };
    el.fps.onchange = () => { if (this.playing) this.setPlaying(true); };
    el.bri.oninput = () => this.setBC(Number(el.bri.value) / 100, this.contrast);
    el.con.oninput = () => this.setBC(this.bright, Number(el.con.value) / 100);
    el.auto.onclick = () => this.autoContrast();
    el.reset.onclick = () => this.setBC(1, 1);
    this.setBC(1, 1);

    const signal = this.abort.signal;
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' && (e.target as HTMLInputElement).type === 'number') return;
      if (e.key === ' ') { e.preventDefault(); this.setPlaying(!this.playing); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); this.step(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); this.step(-1); }
    }, { signal });

    const c = el.canvas;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const dpr = window.devicePixelRatio || 1;
      const rect = c.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * dpr, my = (e.clientY - rect.top) * dpr;
      const W = c.width, H = c.height;
      const s0 = Math.min(W / this.cols, H / this.rows);
      const s = s0 * this.zoom;
      const u = (mx - ((W - this.cols * s) / 2 + this.panX)) / s;
      const v = (my - ((H - this.rows * s) / 2 + this.panY)) / s;
      this.zoom = Math.min(40, Math.max(0.2, this.zoom * Math.exp(-e.deltaY * 0.0015)));
      const s2 = s0 * this.zoom;
      this.panX = mx - u * s2 - (W - this.cols * s2) / 2;
      this.panY = my - v * s2 - (H - this.rows * s2) / 2;
      this.redraw();
      this.onZoomChange();
    }, { passive: false, signal });
    let drag: { x: number; y: number } | null = null;
    c.addEventListener('mousedown', (e) => { if (e.button === 0) drag = { x: e.clientX, y: e.clientY }; }, { signal });
    window.addEventListener('mouseup', () => { drag = null; }, { signal });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const dpr = window.devicePixelRatio || 1;
      this.panX += (e.clientX - drag.x) * dpr; this.panY += (e.clientY - drag.y) * dpr;
      drag = { x: e.clientX, y: e.clientY };
      this.redraw();
    }, { signal });
    c.addEventListener('dblclick', () => { this.resetZoom(); this.onZoomChange(); }, { signal });
    this.resizeObs = new ResizeObserver(() => this.redraw());
    this.resizeObs.observe(c);
  }

  private abort = new AbortController();
  private resizeObs: ResizeObserver | null = null;

  onZoomChange: () => void = () => {};
  getZoom() { return this.zoom; }
  setZoom(z: number) {
    const zoom = Math.min(40, Math.max(0.2, z));
    const r = zoom / this.zoom;
    this.zoom = zoom; this.panX *= r; this.panY *= r;
    this.redraw();
  }
  resetZoom() { this.zoom = 1; this.panX = 0; this.panY = 0; this.redraw(); }

  // Stop playback, remove listeners and free decoded frames (used when switching series).
  destroy() {
    this.playing = false;
    this.loopId++;
    this.abort.abort();
    this.resizeObs?.disconnect();
    for (const bmp of this.cache.values()) bmp.close();
    this.cache.clear();
    this.pending.clear();
  }
}
