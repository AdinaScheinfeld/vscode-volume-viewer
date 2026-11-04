// Webview side. Receives file bytes via postMessage and renders with niivue.
// No URL loading at all.

import { Niivue, NVImage } from '@niivue/niivue';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

const statusEl = document.getElementById('status') as HTMLSpanElement;
const errEl = document.getElementById('err') as HTMLDivElement;
const viewSel = document.getElementById('view') as HTMLSelectElement;
const addBtn = document.getElementById('addOverlay') as HTMLButtonElement;
const overlaysEl = document.getElementById('overlays') as HTMLDivElement;
const canvas = document.getElementById('gl') as HTMLCanvasElement;

const LABELS = '__labels__';
const OVERLAY_CMAPS = ['red', 'green', 'blue', 'warm', 'cool', 'hot', 'winter', 'plasma', 'viridis', 'gray'];
// Integer NIfTI datatypes: uint8, int16, int32, int8, uint16, uint32.
const INT_TYPES = new Set([2, 4, 8, 256, 512, 768]);

function showError(msg: string) {
  errEl.style.display = 'block';
  errEl.textContent = msg;
  statusEl.textContent = 'Error';
  vscode.postMessage({ type: 'log', message: msg });
}

const nv = new Niivue({
  backColor: [0, 0, 0, 1],
  show3Dcrosshair: true,
  isResizeCanvas: true,
});

let baseStatus = '';

function applyView(v: string) {
  switch (v) {
    case 'axial': nv.setSliceType(nv.sliceTypeAxial); break;
    case 'coronal': nv.setSliceType(nv.sliceTypeCoronal); break;
    case 'sagittal': nv.setSliceType(nv.sliceTypeSagittal); break;
    case 'render': nv.setSliceType(nv.sliceTypeRender); break;
    default: nv.setSliceType(nv.sliceTypeMultiplanar);
  }
}

viewSel.addEventListener('change', () => applyView(viewSel.value));
addBtn.addEventListener('click', () => vscode.postMessage({ type: 'pickOverlay' }));

// ---------- overlays ----------

// Distinct colours per integer label (golden-angle hue spacing), label 0 transparent.
function labelColormap(maxLabel: number) {
  const n = Math.max(1, Math.min(Math.round(maxLabel), 65535));
  const R: number[] = [], G: number[] = [], B: number[] = [], A: number[] = [], I: number[] = [];
  for (let i = 0; i <= n; i++) {
    if (i === 0) { R.push(0); G.push(0); B.push(0); A.push(0); I.push(0); continue; }
    const h = ((i * 137.508) % 360) / 60;
    const s = 0.85, v = 1.0;
    const c = v * s, x = c * (1 - Math.abs((h % 2) - 1)), m = v - c;
    const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
    R.push(Math.round((r + m) * 255)); G.push(Math.round((g + m) * 255)); B.push(Math.round((b + m) * 255));
    A.push(255); I.push(i);
  }
  return { R, G, B, A, I };
}

function volIndex(vol: NVImage) {
  return nv.volumes.indexOf(vol);
}

function setOverlayColormap(vol: NVImage, cm: string) {
  if (cm === LABELS) {
    const max = (vol as any).global_max ?? vol.cal_max ?? 1;
    vol.setColormapLabel(labelColormap(max));
  } else {
    (vol as any).colormapLabel = null;
    vol.colormap = cm;
  }
  nv.updateGLVolume();
}

function addOverlayRow(vol: NVImage, name: string, initialCmap: string, initialOpacity: number) {
  const row = document.createElement('div');
  row.className = 'ov';

  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.textContent = name;
  nm.title = name;

  const visLabel = document.createElement('label');
  const vis = document.createElement('input');
  vis.type = 'checkbox';
  vis.checked = true;
  visLabel.append(vis, ' show');

  const opLabel = document.createElement('label');
  const op = document.createElement('input');
  op.type = 'range'; op.min = '0'; op.max = '1'; op.step = '0.05';
  op.value = String(initialOpacity);
  opLabel.append('opacity ', op);

  const cmSel = document.createElement('select');
  const optLabels = document.createElement('option');
  optLabels.value = LABELS; optLabels.textContent = 'labels (distinct colours)';
  cmSel.append(optLabels);
  const available = new Set(nv.colormaps());
  for (const cm of OVERLAY_CMAPS) {
    if (!available.has(cm)) continue;
    const o = document.createElement('option');
    o.value = cm; o.textContent = cm;
    cmSel.append(o);
  }
  cmSel.value = initialCmap;

  const rm = document.createElement('button');
  rm.textContent = 'remove';

  const applyOpacity = () => {
    const i = volIndex(vol);
    if (i >= 0) nv.setOpacity(i, vis.checked ? parseFloat(op.value) : 0);
  };
  vis.addEventListener('change', applyOpacity);
  op.addEventListener('input', applyOpacity);
  cmSel.addEventListener('change', () => setOverlayColormap(vol, cmSel.value));
  rm.addEventListener('click', () => {
    nv.removeVolume(vol);
    row.remove();
  });

  row.append(nm, visLabel, opLabel, cmSel, rm);
  overlaysEl.append(row);
}

async function addOverlay(name: string, buf: ArrayBuffer) {
  const vol = await NVImage.loadFromUrl({ url: buf, name, colormap: 'red', opacity: 0.5 });
  const isInt = INT_TYPES.has(vol.hdr?.datatypeCode ?? -1);
  const max = (vol as any).global_max ?? vol.cal_max ?? 0;
  const cmap = isInt && max <= 65535 ? LABELS : 'red';
  nv.addVolume(vol);
  setOverlayColormap(vol, cmap);
  addOverlayRow(vol, name, cmap, 0.5);
}

// ---------- messages ----------

window.addEventListener('message', async (event) => {
  const msg = event.data;
  if (msg?.type === 'error') {
    showError(msg.message);
    return;
  }
  if (msg?.type === 'overlay') {
    try {
      const t0 = performance.now();
      await addOverlay(msg.name, toArrayBuffer(msg.data));
      vscode.postMessage({ type: 'log', message: `overlay ${msg.name}: read ${msg.readMs} ms, load ${Math.round(performance.now() - t0)} ms` });
    } catch (e: any) {
      showError(`Failed to load overlay ${msg.name}: ${e?.message ?? e}\n${e?.stack ?? ''}`);
    }
    return;
  }
  if (msg?.type !== 'load') return;
  try {
    const t0 = performance.now();
    vscode.postMessage({ type: 'log', message: `received data type: ${describe(msg.data)}` });
    const buf = toArrayBuffer(msg.data);
    const mb = (buf.byteLength / 1e6).toFixed(1);
    statusEl.textContent = `Decoding ${msg.name} (${mb} MB)…`;
    await nv.loadFromArrayBuffer(buf, msg.name);
    applyView(viewSel.value);
    const ms = Math.round(performance.now() - t0);
    const vol = nv.volumes[0];
    const dims = vol?.hdr?.dims ? vol.hdr.dims.slice(1, 1 + vol.hdr.dims[0]).join('×') : '?';
    baseStatus = `${msg.name} · ${dims} · ${mb} MB · read ${msg.readMs} ms, render ${ms} ms`;
    statusEl.textContent = baseStatus;
    addBtn.disabled = false;
  } catch (e: any) {
    showError(`Failed to load ${msg.name}: ${e?.message ?? e}\n${e?.stack ?? ''}`);
  }
});

nv.onLocationChange = (data: any) => {
  if (baseStatus && data?.string) statusEl.textContent = `${baseStatus} · ${data.string}`;
};

function describe(d: any): string {
  const tag = Object.prototype.toString.call(d);
  const len = d?.byteLength ?? d?.length ?? (d && typeof d === 'object' ? Object.keys(d).length : undefined);
  return `${tag} len=${len}`;
}

// Accept whatever shape the bytes arrive in.
function toArrayBuffer(d: any): ArrayBuffer {
  if (d instanceof ArrayBuffer) return d;
  if (ArrayBuffer.isView(d)) return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer;
  if (Array.isArray(d)) return new Uint8Array(d).buffer;
  if (d && d.type === 'Buffer' && Array.isArray(d.data)) return new Uint8Array(d.data).buffer;
  if (d && typeof d === 'object') {
    const n = Object.keys(d).length;
    const u = new Uint8Array(n);
    for (let i = 0; i < n; i++) u[i] = d[i];
    return u.buffer;
  }
  throw new Error(`unexpected data: ${describe(d)}`);
}

(async () => {
  try {
    await nv.attachToCanvas(canvas);
    vscode.postMessage({ type: 'ready' });
  } catch (e: any) {
    showError(`WebGL init failed: ${e?.message ?? e}`);
  }
})();
