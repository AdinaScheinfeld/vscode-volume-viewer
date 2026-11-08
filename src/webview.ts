// Webview side. Receives file bytes via postMessage (no URL loading at all) and shows them:
// - NIfTI volumes with niivue (views, overlays, contrast)
// - 2D / cine DICOM with the clip player in cine.ts

import { Niivue, NVImage, DRAG_MODE, MULTIPLANAR_TYPE } from '@niivue/niivue';
import { CinePlayer, isDicom } from './cine';
import { labelRGB, SlotPool } from './colors';
import { readHeader, groupSeries, seriesLabel, dicomToNifti } from './dcm';
import { LargeVolumeViewer, LARGE_OVERLAY_CMAPS, isGzip, peekNifti, peekNiftiGz, needsLargeMode, decompressNifti, loadVol, STREAM_BYTES } from './large';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $<HTMLSpanElement>('status');
const errEl = $<HTMLDivElement>('err');
const viewSel = $<HTMLSelectElement>('view');
const addBtn = $<HTMLButtonElement>('addOverlay');
const overlaysEl = $<HTMLDivElement>('overlays');
const canvas = $<HTMLCanvasElement>('gl');

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

const log = (message: string) => vscode.postMessage({ type: 'log', message });

const nv = new Niivue({
  backColor: [0, 0, 0, 1],
  show3Dcrosshair: true,
  isResizeCanvas: true,
  // Always a 2x2 grid (axial, coronal, sagittal, 3D), never a tall column.
  multiplanarLayout: MULTIPLANAR_TYPE.GRID,
  dragMode: DRAG_MODE.contrast,
  // Like ITK-SNAP: patient right on screen left in axial/coronal views.
  isRadiologicalConvention: true,
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

viewSel.addEventListener('change', () => {
  if (mode === 'large') large?.setView(viewSel.value);
  else applyView(viewSel.value);
  updateSliceUi();
});

// ---------- slice / frame slider and display convention ----------

const sliceRow = $<HTMLDivElement>('sliceRow');
const sliceAxisSel = $<HTMLSelectElement>('sliceAxis');
const sliceIn = $<HTMLInputElement>('slice');
const sliceLbl = $<HTMLSpanElement>('sliceLbl');
const frameGrp = $<HTMLSpanElement>('frameGrp');
const frameIn = $<HTMLInputElement>('frame4d');
const frameLbl = $<HTMLSpanElement>('frame4dLbl');
const conventionSel = $<HTMLSelectElement>('convention');
let radiological = true; // like ITK-SNAP: patient right on screen left

// Axis the slider moves along (0 = sagittal, 1 = coronal, 2 = axial). A single view fixes it.
function sliceAxis(): number {
  const v = viewSel.value;
  const fixed = v === 'axial' ? 2 : v === 'coronal' ? 1 : v === 'sagittal' ? 0 : -1;
  sliceAxisSel.classList.toggle('hidden', fixed >= 0);
  return fixed >= 0 ? fixed : Number(sliceAxisSel.value);
}

function nvDims(): number[] | null {
  const d = (baseVol as any)?.dimsRAS as number[] | undefined;
  return d ? [d[1], d[2], d[3]] : null;
}

function sliceCount(axis: number): number {
  if (mode === 'large' && large) return large.sliceCount(axis);
  return nvDims()?.[axis] ?? 1;
}

function getSlice(axis: number): number {
  if (mode === 'large' && large) return large.getSlice(axis);
  const d = nvDims();
  if (!d) return 0;
  return Math.min(d[axis] - 1, Math.max(0, Math.floor(nv.scene.crosshairPos[axis] * d[axis])));
}

function setSlice(axis: number, k: number) {
  if (mode === 'large' && large) return large.setSlice(axis, k);
  const d = nvDims();
  if (!d) return;
  nv.scene.crosshairPos[axis] = (k + 0.5) / d[axis];
  nv.drawScene();
  (nv as any).createOnLocationChange?.();
}

function updateSliceUi() {
  if (mode === 'cine' || (!baseVol && !large)) { sliceRow.classList.add('hidden'); return; }
  sliceRow.classList.remove('hidden');
  const ax = sliceAxis();
  const n = sliceCount(ax), k = getSlice(ax);
  sliceIn.max = String(Math.max(0, n - 1));
  sliceIn.value = String(k);
  sliceLbl.textContent = `${k + 1} / ${n}`;
  const nf: number = mode === 'volume' ? ((baseVol as any)?.nFrame4D ?? 1) : 1;
  frameGrp.classList.toggle('hidden', nf < 2);
  if (nf > 1) {
    const f: number = (baseVol as any)?.frame4D ?? 0;
    frameIn.max = String(nf - 1);
    frameIn.value = String(f);
    frameLbl.textContent = `${f + 1} / ${nf}`;
  }
}

sliceIn.addEventListener('input', () => { setSlice(sliceAxis(), Number(sliceIn.value)); updateSliceUi(); });
sliceAxisSel.addEventListener('change', updateSliceUi);
frameIn.addEventListener('input', () => {
  if (!baseVol) return;
  nv.setFrame4D(baseVol.id, Number(frameIn.value));
  updateSliceUi();
});
conventionSel.addEventListener('change', () => {
  radiological = conventionSel.value === 'radio';
  nv.setRadiologicalConvention(radiological);
  large?.setRadiological(radiological);
});
addBtn.addEventListener('click', () => vscode.postMessage({ type: 'pickOverlay' }));

// ---------- contrast (main image; niivue or large-volume mode) ----------

interface ContrastTarget {
  get(): [number, number];
  set(lo: number, hi: number): void;
  full(): [number, number];
  robust(): [number, number];
  isInt: boolean;
}

const cMin = $<HTMLInputElement>('cMin');
const cMax = $<HTMLInputElement>('cMax');
const cMinN = $<HTMLInputElement>('cMinN');
const cMaxN = $<HTMLInputElement>('cMaxN');
let baseVol: NVImage | null = null;
let contrastTarget: ContrastTarget | null = null;

function fmt(v: number) {
  return Math.abs(v) >= 1000 || Number.isInteger(v) ? String(Math.round(v)) : v.toPrecision(4);
}

function syncContrastUi() {
  if (!contrastTarget) return;
  const [lo, hi] = contrastTarget.get();
  cMin.value = cMinN.value = fmt(lo);
  cMax.value = cMaxN.value = fmt(hi);
}

function setContrast(lo: number, hi: number) {
  if (!contrastTarget) return;
  if (hi <= lo) hi = lo + Math.max(Number(cMin.step) || 1e-6, 1e-6);
  contrastTarget.set(lo, hi);
  syncContrastUi();
}

function setupContrast(t: ContrastTarget) {
  contrastTarget = t;
  const [gmin, gmax] = t.full();
  const step = t.isInt && gmax - gmin > 50 ? 1 : (gmax - gmin) / 1000 || 1e-6;
  for (const el of [cMin, cMax, cMinN, cMaxN]) { el.min = String(gmin); el.max = String(gmax); el.step = String(step); }
  syncContrastUi();
  $('contrast').classList.remove('hidden');
}

function niivueContrast(vol: NVImage): ContrastTarget {
  const v = vol as any;
  return {
    get: () => [vol.cal_min ?? 0, vol.cal_max ?? 1],
    set: (lo, hi) => { vol.cal_min = lo; vol.cal_max = hi; nv.updateGLVolume(); },
    full: () => [v.global_min ?? vol.cal_min, v.global_max ?? vol.cal_max],
    robust: () => [v.robust_min ?? v.global_min, v.robust_max ?? v.global_max],
    isInt: INT_TYPES.has(vol.hdr?.datatypeCode ?? -1),
  };
}

cMin.addEventListener('input', () => setContrast(Number(cMin.value), Math.max(Number(cMax.value), Number(cMin.value))));
cMax.addEventListener('input', () => setContrast(Math.min(Number(cMin.value), Number(cMax.value)), Number(cMax.value)));
cMinN.addEventListener('change', () => setContrast(Number(cMinN.value), Number(cMaxN.value)));
cMaxN.addEventListener('change', () => setContrast(Number(cMinN.value), Number(cMaxN.value)));
$('cAuto').addEventListener('click', () => { if (contrastTarget) setContrast(...contrastTarget.robust()); });
$('cFull').addEventListener('click', () => { if (contrastTarget) setContrast(...contrastTarget.full()); });
nv.onIntensityChange = (vol: NVImage) => { if (vol === baseVol) syncContrastUi(); };

// ---------- overlays ----------

// Each overlay gets its own color slot, so two segmentations never share a color.
const slots = new SlotPool();
const overlaySlot = new Map<NVImage, number>();

// Label colormap for one overlay, label 0 transparent.
function labelColormap(maxLabel: number, slot: number) {
  const n = Math.max(1, Math.min(Math.round(maxLabel), 65535));
  const R: number[] = [], G: number[] = [], B: number[] = [], A: number[] = [], I: number[] = [];
  for (let i = 0; i <= n; i++) {
    if (i === 0) { R.push(0); G.push(0); B.push(0); A.push(0); I.push(0); continue; }
    const [r, g, b] = labelRGB(i, slot, n);
    R.push(r); G.push(g); B.push(b); A.push(255); I.push(i);
  }
  return { R, G, B, A, I };
}

function setOverlayColormap(vol: NVImage, cm: string) {
  if (cm === LABELS) {
    const max = (vol as any).global_max ?? vol.cal_max ?? 1;
    vol.setColormapLabel(labelColormap(max, overlaySlot.get(vol) ?? 0));
  } else {
    (vol as any).colormapLabel = null;
    vol.colormap = cm;
  }
  nv.updateGLVolume();
}

interface OverlayControls {
  setShown(visible: boolean, opacity: number): void;
  setColormap(cm: string): void;
  remove(): void;
}

// One control row per overlay; works for both niivue and large-volume mode.
function addOverlayRow(name: string, cmaps: string[], initialCmap: string, initialOpacity: number, ctl: OverlayControls) {
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
  optLabels.value = LABELS; optLabels.textContent = 'labels (distinct colors)';
  cmSel.append(optLabels);
  for (const cm of cmaps) {
    const o = document.createElement('option');
    o.value = cm; o.textContent = cm;
    cmSel.append(o);
  }
  cmSel.value = initialCmap;

  const rm = document.createElement('button');
  rm.textContent = 'remove';

  const applyShown = () => ctl.setShown(vis.checked, parseFloat(op.value));
  vis.addEventListener('change', applyShown);
  op.addEventListener('input', applyShown);
  cmSel.addEventListener('change', () => ctl.setColormap(cmSel.value));
  rm.addEventListener('click', () => { ctl.remove(); row.remove(); });

  row.append(nm, visLabel, opLabel, cmSel, rm);
  overlaysEl.append(row);
}

async function addOverlay(name: string, buf: ArrayBuffer) {
  if (mode === 'large' && large) {
    const lv = large;
    const vol = await loadVol(buf, (m) => { statusEl.textContent = `${name}: ${m}`; });
    const slot = slots.take();
    let h;
    try { h = lv.addOverlay(vol, name, slot); } catch (e) { slots.release(slot); throw e; }
    statusEl.textContent = baseStatus;
    const init = h.initialCmap === 'labels' ? LABELS : h.initialCmap;
    addOverlayRow(name, LARGE_OVERLAY_CMAPS, init, 0.5, {
      setShown: (vis, op) => { h.setVisible(vis); h.setOpacity(op); },
      setColormap: (cm) => h.setColormap(cm === LABELS ? 'labels' : cm),
      remove: () => { h.remove(); slots.release(slot); },
    });
    return;
  }
  const vol = await NVImage.loadFromUrl({ url: buf, name, colormap: 'red', opacity: 0.5 });
  const slot = slots.take();
  overlaySlot.set(vol, slot);
  const available = new Set(nv.colormaps());
  const cmaps = OVERLAY_CMAPS.filter((c) => available.has(c));
  const isInt = INT_TYPES.has(vol.hdr?.datatypeCode ?? -1);
  const max = (vol as any).global_max ?? vol.cal_max ?? 0;
  // Labels get a per-overlay color; continuous maps rotate through red, green, blue, …
  const cmap = isInt && max <= 65535 ? LABELS : cmaps[slot % Math.min(3, cmaps.length)] ?? 'red';
  nv.addVolume(vol);
  setOverlayColormap(vol, cmap);
  addOverlayRow(name, cmaps, cmap, 0.5, {
    setShown: (vis, op) => { const i = nv.volumes.indexOf(vol); if (i >= 0) nv.setOpacity(i, vis ? op : 0); },
    setColormap: (cm) => setOverlayColormap(vol, cm),
    remove: () => { nv.removeVolume(vol); slots.release(slot); overlaySlot.delete(vol); },
  });
}

// ---------- loading ----------

type Mode = 'volume' | 'large' | 'cine';
let mode: Mode = 'volume';
let large: LargeVolumeViewer | null = null;
const renderOption = viewSel.querySelector('option[value="render"]') as HTMLOptionElement;

function setMode(m: Mode) {
  mode = m;
  const volLike = m !== 'cine';
  $('volCtl').classList.toggle('hidden', !volLike);
  canvas.classList.toggle('hidden', m !== 'volume');
  $('large').classList.toggle('hidden', m !== 'large');
  $('contrast').classList.toggle('hidden', !volLike || !contrastTarget);
  $('sliceRow').classList.toggle('hidden', !volLike || (!baseVol && !large));
  overlaysEl.classList.toggle('hidden', !volLike);
  $('cineCtl').classList.toggle('hidden', volLike);
  $('cineAdj').classList.toggle('hidden', volLike);
  $('cine').classList.toggle('hidden', volLike);
  // No 3D render in large-volume mode.
  renderOption.disabled = m === 'large';
  if (m === 'large' && viewSel.value === 'render') viewSel.value = 'multi';
}

function clearVolumes() {
  while (nv.volumes.length) nv.removeVolume(nv.volumes[0]);
  overlaysEl.innerHTML = '';
  slots.clear();
  overlaySlot.clear();
  baseVol = null;
  contrastTarget = null;
  large?.destroy();
  large = null;
}

const isAllocError = (e: any) => e instanceof RangeError || /allocation|out of memory/i.test(String(e?.message ?? e));

// `label` is what the status line shows; `fileName` must carry the right extension for niivue.
async function openVolume(label: string, fileName: string, buf: ArrayBuffer, readInfo: string) {
  setMode('volume');
  clearVolumes();
  const t0 = performance.now();
  let raw = buf, name = fileName;
  if (/\.nii(\.gz)?$/i.test(fileName)) {
    const gz = isGzip(buf);
    // Decide from the header alone, before decompressing anything big.
    const pk = gz ? await peekNiftiGz(buf) : peekNifti(buf);
    if (pk && (needsLargeMode(pk) || pk.rawBytes > STREAM_BYTES)) {
      const reason = `${Math.round(pk.voxels / 1e6)} M voxels, ${(pk.rawBytes / 1e9).toFixed(2)} GB uncompressed`;
      return openLarge(label, buf, readInfo, reason, t0);
    }
    if (gz) {
      statusEl.textContent = `Decompressing ${label}…`;
      raw = decompressNifti(buf);
      name = fileName.replace(/\.gz$/i, '');
    }
  }
  const mb = (raw.byteLength / 1e6).toFixed(1);
  statusEl.textContent = `Decoding ${label} (${mb} MB)…`;
  try {
    await nv.loadFromArrayBuffer(raw, name);
  } catch (e) {
    if (isAllocError(e) && /\.nii$/i.test(name)) {
      log(`niivue could not allocate memory for ${label}; switching to large-volume mode`);
      clearVolumes();
      return openLarge(label, raw, readInfo, 'too large for the 3D viewer', t0);
    }
    throw e;
  }
  applyView(viewSel.value);
  const ms = Math.round(performance.now() - t0);
  const vol = nv.volumes[0];
  const dims = vol?.hdr?.dims ? vol.hdr.dims.slice(1, 1 + vol.hdr.dims[0]).join('×') : '?';
  baseStatus = `${label} · ${dims} · ${readInfo}, render ${ms} ms`;
  statusEl.textContent = baseStatus;
  addBtn.disabled = false;
  if (vol) { baseVol = vol; setupContrast(niivueContrast(vol)); }
  updateSliceUi();
}

// `buf` may be .nii or .nii.gz; big compressed files are stream-decompressed.
async function openLarge(label: string, buf: ArrayBuffer, readInfo: string, reason: string, t0: number) {
  setMode('large');
  statusEl.textContent = `Opening ${label} in large-volume mode (${reason})…`;
  large = new LargeVolumeViewer($('large'), (loc) => { if (baseStatus) statusEl.textContent = `${baseStatus} · ${loc}`; updateSliceUi(); });
  large.setRadiological(radiological);
  const vol = await loadVol(buf, (m) => { statusEl.textContent = `${label}: ${m}`; });
  const info = large.load(vol);
  if (vol.quantized) log(`${label}: ${vol.typeName}, range ${vol.gmin}..${vol.gmax}`);
  large.setView(viewSel.value);
  const ms = Math.round(performance.now() - t0);
  const frames = info.frames > 1 ? ` (first of ${info.frames} frames)` : '';
  baseStatus = `${label} · ${info.dims.join('×')}${frames} · ${info.typeName} · large-volume mode, full resolution (${reason}) · ${readInfo}, load ${ms} ms`;
  statusEl.textContent = baseStatus;
  const lv = large;
  setupContrast({
    get: () => lv.range,
    set: (lo, hi) => lv.setRange(lo, hi),
    full: () => lv.fullRange,
    robust: () => lv.robustRange(),
    isInt: info.isInt,
  });
  addBtn.disabled = false;
  updateSliceUi();
}

let player: CinePlayer | null = null;

async function openCine(name: string, buf: ArrayBuffer, readInfo: string) {
  setMode('cine');
  large?.destroy();
  large = null;
  baseStatus = '';
  player?.destroy();
  const mb = (buf.byteLength / 1e6).toFixed(1);
  statusEl.textContent = `Decoding ${name} (${mb} MB)…`;
  player = new CinePlayer({
    canvas: $('cine'),
    play: $('play'), frame: $('frame'), frameLbl: $('frameLbl'), fps: $('fps'),
    bri: $('bri'), briLbl: $('briLbl'), con: $('con'), conLbl: $('conLbl'),
    auto: $('cineAuto'), reset: $('cineReset'),
  });
  const info = await player.open(buf);
  statusEl.textContent =
    `${name} · ${info.cols}×${info.rows} · ${info.nFrames} frame${info.nFrames > 1 ? 's' : ''} · ${info.codec} · ${mb} MB · ${readInfo}, first frame ${info.firstFrameMs} ms`;
  log(`cine ${name}: ${info.cols}x${info.rows}x${info.nFrames} ${info.codec} @${info.fps}fps, first frame ${info.firstFrameMs} ms`);
}

// ---------- DICOM 3D: conversion, sibling files, folders ----------

type DicomFile = { name: string; buf: ArrayBuffer };
interface FileEntry { name: string; size: number }

let siblingsWaiter: ((f: FileEntry[]) => void) | null = null;
const fileRequests = new Map<number, { items: DicomFile[]; resolve: (f: DicomFile[]) => void; reject: (e: Error) => void; total: number }>();
let nextReq = 1;

function listSiblings(): Promise<FileEntry[]> {
  return new Promise((resolve) => {
    siblingsWaiter = resolve;
    vscode.postMessage({ type: 'listSiblings' });
  });
}

function readFiles(names: string[]): Promise<DicomFile[]> {
  if (!names.length) return Promise.resolve([]);
  const reqId = nextReq++;
  return new Promise((resolve, reject) => {
    fileRequests.set(reqId, { items: [], resolve, reject, total: names.length });
    vscode.postMessage({ type: 'readFiles', names, reqId });
  });
}

const mbOf = (n: number) => (n / 1e6).toFixed(1);

async function open3D(label: string, files: DicomFile[], readMs: number) {
  setMode('volume');
  statusEl.textContent = `Converting ${files.length} DICOM file${files.length > 1 ? 's' : ''} to a 3D volume…`;
  const t0 = performance.now();
  const nii = await dicomToNifti(files, log);
  const convMs = Math.round(performance.now() - t0);
  const bytes = files.reduce((a, f) => a + f.buf.byteLength, 0);
  const extra = nii.outputs.length > 1 ? ` · showing ${nii.name} (of ${nii.outputs.length} outputs)` : '';
  await openVolume(`${label}${extra}`, nii.name, nii.buf,
    `${files.length} file${files.length > 1 ? 's' : ''} · ${mbOf(bytes)} MB · read ${readMs} ms, convert ${convMs} ms`);
}

// A single .dcm file was opened.
async function openDicomFile(name: string, buf: ArrayBuffer, readMs: number) {
  const h = readHeader(name, buf);
  if (!h || h.is2D) return openCine(name, buf, `read ${readMs} ms`);
  if (h.nFrames > 1) return open3D(`${name} · ${h.modality}`, [{ name, buf }], readMs);

  // One slice of a series: gather the other files in the same folder from the same series.
  const t0 = performance.now();
  statusEl.textContent = 'Listing the other files in this folder…';
  const siblings = (await listSiblings()).filter((f) => f.name !== name);
  const total = siblings.reduce((a, f) => a + f.size, 0);
  statusEl.textContent = `Reading ${siblings.length} files from this folder (${mbOf(total)} MB)…`;
  const others = await readFiles(siblings.map((f) => f.name));
  const series = groupSeries([{ name, buf }, ...others]).find((s) => s.uid === h.seriesUid);
  const files = series?.files ?? [{ name, buf }];
  await open3D(`${h.seriesDesc} · ${h.modality}`, files, readMs + Math.round(performance.now() - t0));
}

// A folder was opened: read it, group into series, let the user pick.
async function openDicomFolder(folderName: string, entries: FileEntry[], listMs: number) {
  if (!entries.length) throw new Error(`No files found in ${folderName}.`);
  const total = entries.reduce((a, f) => a + f.size, 0);
  if (total > 2e9) throw new Error(`${folderName} has ${mbOf(total)} MB of files; the limit is 2000 MB. Open a smaller folder or a single file.`);
  const t0 = performance.now();
  statusEl.textContent = `Reading ${entries.length} files from ${folderName} (${mbOf(total)} MB)…`;
  const files = await readFiles(entries.map((f) => f.name));
  const readMs = listMs + Math.round(performance.now() - t0);
  const series = groupSeries(files);
  if (!series.length) throw new Error(`No DICOM files found in ${folderName}.`);

  // 3D series are one choice each; 2D series list each file (e.g. each ultrasound clip).
  type Choice = { label: string; open: () => Promise<void> };
  const choices: Choice[] = [];
  for (const s of series) {
    if (s.is2D) {
      for (const f of s.files) {
        choices.push({ label: `${seriesLabel(s)} · ${f.name}`, open: () => openCine(f.name, f.buf, `read ${readMs} ms`) });
      }
    } else {
      choices.push({ label: seriesLabel(s), open: () => open3D(`${s.desc} · ${s.modality}`, s.files, readMs) });
    }
  }
  const sel = $<HTMLSelectElement>('series');
  sel.innerHTML = '';
  choices.forEach((c, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = c.label;
    sel.append(o);
  });
  $('seriesCtl').classList.toggle('hidden', choices.length < 2);
  sel.onchange = () => {
    errEl.style.display = 'none';
    choices[Number(sel.value)].open().catch((e) => showError(`Failed to open series: ${e?.message ?? e}`));
  };
  log(`folder ${folderName}: ${files.length} files, ${series.length} series, ${choices.length} choices`);
  await choices[0].open();
}

window.addEventListener('message', async (event) => {
  const msg = event.data;
  if (msg?.type === 'error') {
    for (const r of fileRequests.values()) r.reject(new Error(msg.message));
    fileRequests.clear();
    showError(msg.message);
    return;
  }
  if (msg?.type === 'siblings') {
    siblingsWaiter?.(msg.files ?? []);
    siblingsWaiter = null;
    return;
  }
  if (msg?.type === 'files') {
    const r = fileRequests.get(msg.reqId);
    if (!r) return;
    for (const it of msg.items ?? []) r.items.push({ name: it.name, buf: toArrayBuffer(it.data) });
    statusEl.textContent = `Reading files… ${r.items.length} / ${r.total}`;
    if (msg.last) {
      fileRequests.delete(msg.reqId);
      r.resolve(r.items);
    }
    return;
  }
  if (msg?.type === 'overlay') {
    try {
      const t0 = performance.now();
      await addOverlay(msg.name, toArrayBuffer(msg.data));
      log(`overlay ${msg.name}: read ${msg.readMs} ms, load ${Math.round(performance.now() - t0)} ms`);
    } catch (e: any) {
      showError(`Failed to load overlay ${msg.name}: ${e?.message ?? e}\n${e?.stack ?? ''}`);
    }
    return;
  }
  try {
    if (msg?.type === 'folder') {
      await openDicomFolder(msg.name, msg.files ?? [], msg.listMs ?? 0);
    } else if (msg?.type === 'load') {
      const buf = toArrayBuffer(msg.data);
      if (isDicom(msg.name, buf)) await openDicomFile(msg.name, buf, msg.readMs);
      else await openVolume(msg.name, msg.name, buf, `${mbOf(buf.byteLength)} MB · read ${msg.readMs} ms`);
    }
  } catch (e: any) {
    showError(`Failed to load ${msg.name}: ${e?.message ?? e}\n${e?.stack ?? ''}`);
  }
});

nv.onLocationChange = (data: any) => {
  if (baseStatus && data?.string) statusEl.textContent = `${baseStatus} · ${data.string}`;
  updateSliceUi();
};

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
  throw new Error(`unexpected data: ${Object.prototype.toString.call(d)}`);
}

(async () => {
  try {
    await nv.attachToCanvas(canvas);
    // niivue only listens for window resizes; also resize when the panel area changes
    // (e.g. the toolbar wraps onto more lines or the editor is split).
    let pending = false;
    new ResizeObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; nv.resizeListener(); });
    }).observe($("canvasWrap"));
    vscode.postMessage({ type: 'ready' });
  } catch (e: any) {
    showError(`WebGL init failed: ${e?.message ?? e}`);
  }
})();
