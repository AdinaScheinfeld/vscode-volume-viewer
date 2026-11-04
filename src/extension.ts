// Extension host side. Runs on the remote machine (extensionKind: workspace).
// Reads the NIfTI file with the VS Code filesystem API and posts the raw bytes
// to the webview. The webview never fetches anything by URL, and the viewer
// script is inlined into the HTML, so no vscode-remote-resource request is made.

import * as vscode from 'vscode';
import * as path from 'path';

const VIEW_TYPE = 'volumeViewer.viewer';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new NiftiEditorProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
  );
}

export function deactivate() {}

class NiftiEditorProvider implements vscode.CustomReadonlyEditorProvider {
  private scriptCache: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    panel.webview.options = { enableScripts: true, localResourceRoots: [] };
    panel.webview.html = await this.getHtml();

    const sendFile = async () => {
      const t0 = Date.now();
      try {
        const bytes = await vscode.workspace.fs.readFile(document.uri);
        // Send a standalone ArrayBuffer (VS Code transfers these efficiently to the webview).
        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        panel.webview.postMessage({
          type: 'load',
          name: path.basename(document.uri.path),
          data: ab,
          readMs: Date.now() - t0,
        });
      } catch (err: any) {
        panel.webview.postMessage({ type: 'error', message: `Could not read file: ${err?.message ?? err}` });
      }
    };

    const pickOverlays = async () => {
      const picked = await vscode.window.showOpenDialog({
        defaultUri: vscode.Uri.joinPath(document.uri, '..'),
        canSelectMany: true,
        openLabel: 'Add overlay',
        filters: { NIfTI: ['nii', 'gz'] },
      });
      for (const uri of picked ?? []) {
        const t0 = Date.now();
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          panel.webview.postMessage({
            type: 'overlay',
            name: path.basename(uri.path),
            data: ab,
            readMs: Date.now() - t0,
          });
        } catch (err: any) {
          panel.webview.postMessage({ type: 'error', message: `Could not read overlay ${uri.path}: ${err?.message ?? err}` });
        }
      }
    };

    panel.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === 'ready') {
        sendFile();
      } else if (msg?.type === 'pickOverlay') {
        pickOverlays();
      } else if (msg?.type === 'log') {
        console.log(`[volume-viewer] ${msg.message}`);
      }
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
  #canvasWrap { flex: 1 1 auto; position: relative; }
  #gl { position: absolute; inset: 0; width: 100%; height: 100%; }
  #err { color: #f66; white-space: pre-wrap; padding: 12px; display: none; }
</style>
</head>
<body>
<div id="wrap">
  <div id="bar">
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
    <span id="status">Loading…</span>
  </div>
  <div id="overlays"></div>
  <div id="err"></div>
  <div id="canvasWrap"><canvas id="gl"></canvas></div>
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
