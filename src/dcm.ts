// DICOM helpers: classify 2D vs 3D, group files into series, convert 3D series to NIfTI with dcm2niix.

import * as dicomParser from 'dicom-parser';
import { convert } from '@niivue/dcm2niix';

// Modalities that are 2D images or 2D+time clips rather than 3D volumes.
const MODALITIES_2D = new Set(['US', 'XA', 'RF', 'XC', 'ES', 'OP', 'CR', 'DX', 'MG', 'IO', 'PX', 'GM', 'SM', 'SC']);

export interface DicomHeader {
  name: string;
  seriesUid: string;
  seriesDesc: string;
  seriesNumber: number;
  modality: string;
  nFrames: number;
  is2D: boolean;
}

export function readHeader(name: string, buf: ArrayBuffer): DicomHeader | null {
  let ds: dicomParser.DataSet;
  try {
    ds = dicomParser.parseDicom(new Uint8Array(buf), { untilTag: 'x7fe00010' });
  } catch {
    return null;
  }
  const s = (tag: string) => (ds.string(tag) ?? '').trim().replace(/\0/g, '');
  const modality = s('x00080060').toUpperCase();
  const photometric = s('x00280004').toUpperCase();
  const nFrames = Math.max(1, parseInt(s('x00280008') || '1', 10) || 1);
  const hasPosition = !!ds.elements['x00200032'] || !!ds.elements['x52009230'] || !!ds.elements['x52009229'];
  const color = photometric.startsWith('RGB') || photometric.startsWith('YBR') || photometric === 'PALETTE COLOR';
  const is2D = MODALITIES_2D.has(modality) || color || !hasPosition;
  return {
    name,
    seriesUid: s('x0020000e') || `no-series-uid:${name}`,
    seriesDesc: s('x0008103e') || s('x00181030') || '(no description)',
    seriesNumber: parseInt(s('x00200011') || '0', 10) || 0,
    modality: modality || '?',
    nFrames,
    is2D,
  };
}

export interface Series {
  uid: string;
  desc: string;
  number: number;
  modality: string;
  is2D: boolean;
  files: { name: string; buf: ArrayBuffer }[];
}

export function groupSeries(files: { name: string; buf: ArrayBuffer }[]): Series[] {
  const map = new Map<string, Series>();
  for (const f of files) {
    const h = readHeader(f.name, f.buf);
    if (!h) continue;
    let s = map.get(h.seriesUid);
    if (!s) {
      s = { uid: h.seriesUid, desc: h.seriesDesc, number: h.seriesNumber, modality: h.modality, is2D: h.is2D, files: [] };
      map.set(h.seriesUid, s);
    }
    s.files.push(f);
  }
  return [...map.values()].sort((a, b) => a.number - b.number || a.desc.localeCompare(b.desc));
}

export function seriesLabel(s: Series): string {
  return `#${s.number} ${s.desc} · ${s.modality} · ${s.files.length} file${s.files.length > 1 ? 's' : ''}`;
}

function makeWorker(src: string): Worker {
  return new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
}

// Prefer dcm2niix's corrected outputs (equalized slice spacing, gantry-tilt corrected) when present.
function pickImage(names: string[]): number {
  const eq = names.findIndex((n) => /_Eq_/i.test(n));
  if (eq >= 0) return eq;
  const tilt = names.findIndex((n) => /_Tilt_/i.test(n));
  if (tilt >= 0) return tilt;
  return 0;
}

export async function dicomToNifti(
  files: { name: string; buf: ArrayBuffer }[],
  log: (s: string) => void,
  workerSrc: string,
): Promise<{ name: string; buf: ArrayBuffer; outputs: string[] }> {
  const input = files.map((f) => new File([f.buf], f.name));
  const res = await convert(input, { args: ['-z', 'n', '-b', 'n'], createWorker: () => makeWorker(workerSrc), timeoutMs: 300000 });
  const images = res.series.map((s) => s.image);
  const names = images.map((f) => f.name);
  log(`dcm2niix exit ${res.exitCode}, outputs: ${names.join(', ') || '(none)'}`);
  if (!images.length) {
    throw new Error(`dcm2niix could not convert this DICOM (exit code ${res.exitCode}).\n${res.log.slice(-8).join('\n')}`);
  }
  const img = images[pickImage(names)];
  return { name: img.name, buf: await img.arrayBuffer(), outputs: names };
}
