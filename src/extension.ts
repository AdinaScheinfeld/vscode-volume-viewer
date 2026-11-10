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
    // Start reading now, so the read overlaps the panel's startup instead of following it.
    const t0Read = Date.now();
    let preRead: Promise<Uint8Array> | undefined = isFolder ? undefined : Promise.resolve(vscode.workspace.fs.readFile(target));
    preRead?.catch(() => {}); // reported when the panel asks for the file
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
        const bytes = await (preRead ?? vscode.workspace.fs.readFile(target));
        preRead = undefined; // don't keep the file in memory on the login node
        post({ type: 'load', name: path.basename(target.path), data: toArrayBuffer(bytes), readMs: Date.now() - t0Read });
      } catch (err: any) {
        post({ type: 'error', message: `Could not read ${target.path}: ${err?.message ?? err}` });
      }
    };

    // The DICOM converter (1.3 MB) is only sent when a 3D DICOM needs it.
    const sendWorker = async () => {
      try {
        const uri = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'dcm2niix-worker.js');
        post({ type: 'workerSrc', src: Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8') });
      } catch (err: any) {
        post({ type: 'error', message: `Could not load the DICOM converter: ${err?.message ?? err}` });
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
      else if (msg?.type === 'getWorker') sendWorker();
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
  :root {
    --tb-bg: var(--vscode-editorWidget-background, #252526);
    --tb-fg: var(--vscode-foreground, #cccccc);
    --tb-muted: var(--vscode-descriptionForeground, #9d9d9d);
    --tb-border: var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
    --ctl-bg: var(--vscode-input-background, #3c3c3c);
    --ctl-fg: var(--vscode-input-foreground, #cccccc);
    --ctl-border: var(--vscode-input-border, rgba(128, 128, 128, 0.45));
    --accent: var(--vscode-focusBorder, #3794ff);
    --btn-bg: var(--vscode-button-background, #0e639c);
    --btn-fg: var(--vscode-button-foreground, #ffffff);
    --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
    --btn2-bg: var(--vscode-button-secondaryBackground, #3a3d41);
    --btn2-fg: var(--vscode-button-secondaryForeground, #ffffff);
    --btn2-hover: var(--vscode-button-secondaryHoverBackground, #45494e);
  }
  html, body { margin: 0; padding: 0; height: 100%; background: #000; color: var(--tb-fg); font-family: var(--vscode-font-family, sans-serif); overflow: hidden; }
  * { box-sizing: border-box; }
  #wrap { position: absolute; inset: 0; display: flex; flex-direction: column; }
  #toolbar { flex: 0 0 auto; background: var(--tb-bg); border-bottom: 1px solid var(--tb-border); font-size: 12px; }
  .tb-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 20px; padding: 6px 10px; }
  .tb-row + .tb-row { border-top: 1px solid var(--tb-border); }
  .grp { display: inline-flex; align-items: center; gap: 8px; }
  .cap { color: var(--tb-muted); font-weight: 600; white-space: nowrap; }
  .field { display: inline-flex; align-items: center; gap: 6px; color: var(--tb-muted); }
  .val { min-width: 52px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .spacer { flex: 1 1 auto; }
  select, input[type=number] { height: 24px; padding: 0 4px; font: inherit; color: var(--ctl-fg); background: var(--ctl-bg); border: 1px solid var(--ctl-border); border-radius: 3px; }
  input[type=number] { width: 72px; font-variant-numeric: tabular-nums; }
  input[type=range] { width: 140px; margin: 0; accent-color: var(--accent); }
  #slice, #frame { width: 200px; }
  button { height: 24px; padding: 0 10px; font: inherit; color: var(--btn2-fg); background: var(--btn2-bg); border: 1px solid transparent; border-radius: 3px; cursor: pointer; white-space: nowrap; }
  button:hover:not(:disabled) { background: var(--btn2-hover); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.primary { color: var(--btn-fg); background: var(--btn-bg); }
  button.primary:hover:not(:disabled) { background: var(--btn-hover); }
  select:focus-visible, input:focus-visible, button:focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; }
  .btnset { display: inline-flex; align-items: center; border: 1px solid var(--ctl-border); border-radius: 3px; overflow: hidden; }
  .btnset button { height: 22px; width: 26px; padding: 0; border: 0; border-radius: 0; font-size: 14px; }
  #zoomLbl { width: 48px; text-align: center; font-variant-numeric: tabular-nums; }
  .radio { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; white-space: nowrap; }
  .radio input { margin: 0; accent-color: var(--accent); }
  .help { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; padding: 0; background: transparent; border: 1px solid var(--ctl-border); border-radius: 50%; color: var(--tb-muted); cursor: help; font-size: 11px; }
  .help[aria-expanded=true] { color: var(--tb-fg); border-color: var(--accent); }
  #tip { position: fixed; z-index: 1000; max-width: 360px; padding: 6px 9px; font-size: 12px; line-height: 1.5; white-space: pre-line; overflow-wrap: anywhere; color: var(--vscode-editorHoverWidget-foreground, #cccccc); background: var(--vscode-editorHoverWidget-background, #252526); border: 1px solid var(--vscode-editorHoverWidget-border, #454545); border-radius: 3px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5); pointer-events: none; }
  #tip.pinned { pointer-events: auto; }
  #overlays { flex: 0 0 auto; background: var(--tb-bg); font-size: 12px; }
  #overlays:empty { display: none; }
  .ov { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; padding: 5px 10px; border-bottom: 1px solid var(--tb-border); }
  .ov .nm { min-width: 160px; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ov label { display: inline-flex; align-items: center; gap: 6px; color: var(--tb-muted); }
  .ov input[type=range] { width: 110px; }
  .ov input[type=checkbox] { margin: 0; accent-color: var(--accent); }
  .hidden { display: none !important; }
  #canvasWrap { flex: 1 1 auto; position: relative; min-height: 0; overflow: hidden; }
  #gl, #cine, #large { position: absolute; inset: 0; width: 100%; height: 100%; }
  #cine { cursor: grab; }
  #err { color: var(--vscode-errorForeground, #f48771); background: var(--tb-bg); white-space: pre-wrap; padding: 12px; display: none; font-size: 12px; }
  #statusBar { flex: 0 0 auto; height: 22px; display: flex; align-items: center; padding: 0 10px; background: var(--tb-bg); border-top: 1px solid var(--tb-border); color: var(--tb-muted); font-size: 11px; }
  #status { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<div id="tip" role="tooltip" class="hidden"></div>
<div id="wrap">
  <header id="toolbar">
    <div class="tb-row">
      <div id="seriesCtl" class="grp hidden">
        <span class="cap">Series</span>
        <select id="series"></select>
      </div>
      <div id="volCtl" class="grp">
        <span class="cap">View</span>
        <select id="view">
          <option value="multi" selected>Multiplanar</option>
          <option value="axial">Axial</option>
          <option value="coronal">Coronal</option>
          <option value="sagittal">Sagittal</option>
          <option value="render">3D</option>
        </select>
      </div>
      <div id="sliceRow" class="grp hidden">
        <span class="cap">Slice</span>
        <select id="sliceAxis" title="Direction the slider moves through">
          <option value="2" selected>Axial</option>
          <option value="1">Coronal</option>
          <option value="0">Sagittal</option>
        </select>
        <input type="range" id="slice" min="0" max="0" value="0">
        <span id="sliceLbl" class="val"></span>
        <span id="frameGrp" class="grp hidden">
          <span class="cap">Frame</span>
          <input type="range" id="frame4d" min="0" max="0" value="0">
          <span id="frame4dLbl" class="val"></span>
        </span>
      </div>
      <div id="cineCtl" class="grp hidden">
        <button id="play" title="Play / pause (space)">▶</button>
        <input type="range" id="frame" min="0" max="0" value="0">
        <span id="frameLbl" class="val"></span>
        <label class="field">FPS <input type="number" id="fps" min="1" max="120" value="30" style="width:52px"></label>
      </div>
      <div id="zoomCtl" class="grp hidden">
        <span class="cap">Zoom</span>
        <div class="btnset">
          <button id="zoomOut" title="Zoom out">−</button>
          <span id="zoomLbl">100%</span>
          <button id="zoomIn" title="Zoom in">+</button>
        </div>
        <button id="zoomFit" title="Reset zoom and position">Fit</button>
      </div>
      <div id="orientCtl" class="grp hidden" role="radiogroup" aria-label="Display convention">
        <span class="cap">Orientation</span>
        <label class="radio" title="Patient's right on the left of the screen, like ITK-SNAP"><input type="radio" name="convention" value="radio" checked>Radiological</label>
        <label class="radio" title="Patient's left on the left of the screen"><input type="radio" name="convention" value="neuro">Neurological</label>
      </div>
      <div class="spacer"></div>
      <button id="help" class="help" aria-label="Show controls" aria-expanded="false">?</button>
      <button id="addOverlay" class="primary" disabled>Add overlay</button>
    </div>
    <div id="contrast" class="tb-row hidden">
      <span class="cap">Contrast</span>
      <label class="field">Min <input type="range" id="cMin"><input type="number" id="cMinN"></label>
      <label class="field">Max <input type="range" id="cMax"><input type="number" id="cMaxN"></label>
      <div class="grp">
        <button id="cAuto" title="Fit to the image's robust intensity range">Auto</button>
        <button id="cFull" title="Use the image's full intensity range">Full range</button>
      </div>
    </div>
    <div id="cineAdj" class="tb-row hidden">
      <label class="field">Brightness <input type="range" id="bri" min="0" max="400" value="100"><span id="briLbl" class="val">100%</span></label>
      <label class="field">Contrast <input type="range" id="con" min="0" max="1000" value="100"><span id="conLbl" class="val">100%</span></label>
      <div class="grp">
        <button id="cineAuto">Auto</button>
        <button id="cineReset">Reset</button>
      </div>
    </div>
  </header>
  <div id="overlays"></div>
  <div id="err"></div>
  <div id="canvasWrap"><canvas id="gl"></canvas><canvas id="cine" class="hidden"></canvas><canvas id="large" class="hidden"></canvas></div>
  <footer id="statusBar"><span id="status">Loading…</span></footer>
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
