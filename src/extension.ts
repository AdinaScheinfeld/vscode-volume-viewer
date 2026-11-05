// Extension host side. Runs on the remote machine (extensionKind: workspace).
// Reads files with the VS Code filesystem API and posts the raw bytes to the
// webview. The webview never fetches anything by URL, and the viewer script is
// inlined into the HTML, so no vscode-remote-resource request is made.
// No image processing happens here: it only lists and reads files.

import * as vscode from 'vscode';
import * as path from 'path';

const VIEW_TYPE = 'volumeViewer.viewer';
// Never read more than this from one folder (protects against huge folders).
const MAX_FOLDER_BYTES = 2e9;
const MAX_FOLDER_FILES = 20000;
// Batch size for posting file contents to the webview.
const BATCH_BYTES = 64e6;
// Files that are clearly not DICOM.
const NOT_DICOM = /\.(nii|gz|json|txt|csv|tsv|md|png|jpe?g|gif|bmp|tiff?|xml|html?|pdf|zip|py|sh|bval|bvec|mat|h5|npy|npz)$/i;

export function activate(context: vscode.ExtensionContext) {
  const provider = new ViewerProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand('volumeViewer.openDicomFolder', async (uri?: vscode.Uri) => {
      if (!uri) {
        const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Open DICOM folder' });
        uri = picked?.[0];
      }
      if (!uri) return;
      const panel = vscode.window.createWebviewPanel(VIEW_TYPE, path.basename(uri.path), vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      });
      await provider.setup(panel, uri, true);
    }),
  );
}

export function deactivate() {}

interface FileEntry { name: string; size: number }

// List files in a folder (recursively), skipping obvious non-DICOM files.
async function listFolder(dir: vscode.Uri): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  const walk = async (d: vscode.Uri, rel: string, depth: number) => {
    if (depth > 4 || out.length >= MAX_FOLDER_FILES) return;
    for (const [name, type] of await vscode.workspace.fs.readDirectory(d)) {
      const relName = rel ? `${rel}/${name}` : name;
      const child = vscode.Uri.joinPath(d, name);
      if (type & vscode.FileType.Directory) await walk(child, relName, depth + 1);
      else if (type & vscode.FileType.File && !NOT_DICOM.test(name) && !name.startsWith('.')) {
        const st = await vscode.workspace.fs.stat(child);
        out.push({ name: relName, size: st.size });
        if (out.length >= MAX_FOLDER_FILES) return;
      }
    }
  };
  await walk(dir, '', 0);
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

class ViewerProvider implements vscode.CustomReadonlyEditorProvider {
  private scriptCache: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    await this.setup(panel, document.uri, false);
  }

  // Shared by the custom editor (a file) and the "Open DICOM folder" command (a folder).
  async setup(panel: vscode.WebviewPanel, target: vscode.Uri, isFolder: boolean): Promise<void> {
    panel.webview.options = { enableScripts: true, localResourceRoots: [] };
    panel.webview.html = await this.getHtml();
    const post = (msg: unknown) => panel.webview.postMessage(msg);
    // Folder whose files the webview may ask for: the target folder, or the clicked file's folder.
    const baseDir = isFolder ? target : vscode.Uri.joinPath(target, '..');

    const sendTarget = async () => {
      const t0 = Date.now();
      try {
        if (isFolder) {
          const files = await listFolder(target);
          post({ type: 'folder', name: path.basename(target.path), files, listMs: Date.now() - t0 });
          return;
        }
        const bytes = await vscode.workspace.fs.readFile(target);
        post({ type: 'load', name: path.basename(target.path), data: toArrayBuffer(bytes), readMs: Date.now() - t0 });
      } catch (err: any) {
        post({ type: 'error', message: `Could not read ${target.path}: ${err?.message ?? err}` });
      }
    };

    const sendSiblings = async () => {
      try {
        const files = await listFolder(baseDir);
        post({ type: 'siblings', files });
      } catch (err: any) {
        post({ type: 'error', message: `Could not list ${baseDir.path}: ${err?.message ?? err}` });
      }
    };

    // Read the requested files (relative to baseDir) and post them in batches.
    const readFiles = async (names: string[], reqId: number) => {
      let total = 0;
      let batch: { name: string; data: ArrayBuffer }[] = [];
      let batchBytes = 0;
      let done = 0;
      const flush = (last: boolean) => {
        post({ type: 'files', reqId, items: batch, done, last });
        batch = [];
        batchBytes = 0;
      };
      try {
        // Read a few files at a time, in order.
        const CONCURRENCY = 32;
        for (let i = 0; i < names.length; i += CONCURRENCY) {
          const chunk = names.slice(i, i + CONCURRENCY);
          const datas = await Promise.all(chunk.map((n) => vscode.workspace.fs.readFile(vscode.Uri.joinPath(baseDir, ...n.split('/')))));
          for (let k = 0; k < chunk.length; k++) {
            total += datas[k].byteLength;
            if (total > MAX_FOLDER_BYTES) throw new Error(`more than ${MAX_FOLDER_BYTES / 1e9} GB requested from one folder`);
            batch.push({ name: chunk[k], data: toArrayBuffer(datas[k]) });
            batchBytes += datas[k].byteLength;
            done++;
          }
          if (batchBytes >= BATCH_BYTES) flush(false);
        }
        flush(true);
      } catch (err: any) {
        post({ type: 'error', message: `Could not read files from ${baseDir.path}: ${err?.message ?? err}` });
      }
    };

    const pickOverlays = async () => {
      const picked = await vscode.window.showOpenDialog({
        defaultUri: baseDir,
        canSelectMany: true,
        openLabel: 'Add overlay',
        filters: { NIfTI: ['nii', 'gz'] },
      });
      for (const uri of picked ?? []) {
        const t0 = Date.now();
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          post({ type: 'overlay', name: path.basename(uri.path), data: toArrayBuffer(bytes), readMs: Date.now() - t0 });
        } catch (err: any) {
          post({ type: 'error', message: `Could not read overlay ${uri.path}: ${err?.message ?? err}` });
        }
      }
    };

    panel.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === 'ready') sendTarget();
      else if (msg?.type === 'listSiblings') sendSiblings();
      else if (msg?.type === 'readFiles') readFiles(msg.names ?? [], msg.reqId);
      else if (msg?.type === 'pickOverlay') pickOverlays();
      else if (msg?.type === 'log') console.log(`[volume-viewer] ${msg.message}`);
    });
  }

  private async getHtml(): Promise<string> {
    if (!this.scriptCache) {
      const scriptUri = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js');
      const raw = await vscode.workspace.fs.readFile(scriptUri);
      // Prevent an accidental "</script>" inside the bundle from closing the tag.
      this.scriptCache = Buffer.from(raw).toString('utf8').replace(/<\/script/gi, '<\\/script');
    }
    const nonce = makeNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' 'wasm-unsafe-eval'; worker-src blob:; connect-src data: blob:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #000; color: #ddd; font-family: var(--vscode-font-family); overflow: hidden; }
  #wrap { position: absolute; inset: 0; display: flex; flex-direction: column; }
  #bar { flex: 0 0 auto; padding: 4px 8px; font-size: 12px; background: #1e1e1e; display: flex; gap: 12px; align-items: center; }
  #bar select, #bar button { background: #2d2d2d; color: #ddd; border: 1px solid #444; font: inherit; }
  #bar button { padding: 1px 8px; cursor: pointer; }
  #overlays { flex: 0 0 auto; background: #181818; font-size: 12px; }
  .ov { display: flex; gap: 10px; align-items: center; padding: 3px 8px; border-top: 1px solid #2a2a2a; flex-wrap: wrap; }
  .ov .nm { min-width: 160px; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ov select, .ov button { background: #2d2d2d; color: #ddd; border: 1px solid #444; font: inherit; }
  .ov input[type=range] { width: 110px; }
  #status { opacity: 0.8; }
  .row { flex: 0 0 auto; display: flex; gap: 10px; align-items: center; padding: 3px 8px; font-size: 12px; background: #181818; border-top: 1px solid #2a2a2a; flex-wrap: wrap; }
  .row button { background: #2d2d2d; color: #ddd; border: 1px solid #444; font: inherit; padding: 1px 8px; cursor: pointer; }
  .row input[type=number], #bar input[type=number] { width: 72px; background: #2d2d2d; color: #ddd; border: 1px solid #444; font: inherit; }
  .row input[type=range] { width: 140px; }
  .grp { display: inline-flex; gap: 10px; align-items: center; }
  .hint { opacity: 0.55; }
  .lbl { min-width: 38px; display: inline-block; }
  .hidden { display: none !important; }
  #frame { width: 260px; }
  #canvasWrap { flex: 1 1 auto; position: relative; min-height: 0; overflow: hidden; }
  #gl, #cine { position: absolute; inset: 0; width: 100%; height: 100%; }
  #cine { cursor: grab; }
  #err { color: #f66; white-space: pre-wrap; padding: 12px; display: none; }
</style>
</head>
<body>
<div id="wrap">
  <div id="bar">
    <span id="seriesCtl" class="grp hidden">
      <label>Series <select id="series"></select></label>
    </span>
    <span id="volCtl" class="grp">
      <label>View
        <select id="view">
          <option value="multi" selected>Multiplanar</option>
          <option value="axial">Axial</option>
          <option value="coronal">Coronal</option>
          <option value="sagittal">Sagittal</option>
          <option value="render">3D</option>
        </select>
      </label>
      <button id="addOverlay" disabled>Add overlay…</button>
    </span>
    <span id="cineCtl" class="grp hidden">
      <button id="play" title="Play / pause (space)">▶</button>
      <input type="range" id="frame" min="0" max="0" value="0">
      <span id="frameLbl"></span>
      <label>fps <input type="number" id="fps" min="1" max="120" value="30" style="width:48px"></label>
    </span>
    <span id="status">Loading…</span>
  </div>
  <div id="contrast" class="row hidden">
    <span>Contrast</span>
    <label>min <input type="range" id="cMin"> <input type="number" id="cMinN"></label>
    <label>max <input type="range" id="cMax"> <input type="number" id="cMaxN"></label>
    <button id="cAuto" title="Fit to the image's robust intensity range">Auto</button>
    <button id="cFull" title="Use the image's full intensity range">Full range</button>
    <span class="hint">right-drag on the image: fit contrast to a region</span>
  </div>
  <div id="cineAdj" class="row hidden">
    <label>brightness <input type="range" id="bri" min="0" max="400" value="100"></label><span id="briLbl" class="lbl">100%</span>
    <label>contrast <input type="range" id="con" min="0" max="1000" value="100"></label><span id="conLbl" class="lbl">100%</span>
    <button id="cineAuto">Auto</button>
    <button id="cineReset">Reset</button>
    <span class="hint">scroll: zoom · drag: pan · double-click: fit · space: play · ←/→: step</span>
  </div>
  <div id="overlays"></div>
  <div id="err"></div>
  <div id="canvasWrap"><canvas id="gl"></canvas><canvas id="cine" class="hidden"></canvas></div>
</div>
<script nonce="${nonce}">${this.scriptCache}</script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
