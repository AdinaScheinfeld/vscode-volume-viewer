import * as esbuild from 'esbuild';
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';

// Extension host bundle (Node, runs on the remote machine).
await esbuild.build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  outfile: 'dist/extension.js',
  sourcemap: false,
  logLevel: 'info',
});

// dcm2niix worker: bundle the package's worker with the WebAssembly embedded, so the
// webview can start it from a blob: URL.
const dcmDist = resolve('node_modules/@niivue/dcm2niix/dist');
const embedWasm = {
  name: 'dcm2niix-embed-wasm',
  setup(b) {
    b.onResolve({ filter: /^\.\/dcm2niix\.jpeg\.js$/ }, (args) =>
      args.importer.endsWith('worker.jpeg.js') ? { path: 'dcm2niix-embedded', namespace: 'dcmwrap' } : undefined);
    b.onLoad({ filter: /.*/, namespace: 'dcmwrap' }, () => ({
      contents: `
        import Orig from ${JSON.stringify(join(dcmDist, 'dcm2niix.jpeg.js'))};
        import wasm from ${JSON.stringify(join(dcmDist, 'dcm2niix.jpeg.wasm'))};
        export default (opts) => Orig(Object.assign({}, opts, { wasmBinary: wasm, locateFile: (p) => p }));
      `,
      resolveDir: dcmDist,
      loader: 'js',
    }));
  },
};
const worker = await esbuild.build({
  entryPoints: [join(dcmDist, 'worker.jpeg.js')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  minify: true,
  write: false,
  loader: { '.wasm': 'binary' },
  define: { 'import.meta.url': '"https://localhost/dcm2niix.jpeg.js"' },
  plugins: [embedWasm],
  logLevel: 'info',
});
// Kept out of the panel HTML: only sent to the tab when a 3D DICOM needs converting.
const workerSrc = worker.outputFiles[0].text;
mkdirSync('dist', { recursive: true });
writeFileSync('dist/dcm2niix-worker.js', workerSrc);
console.log(`dcm2niix worker: ${(workerSrc.length / 1e6).toFixed(2)} MB`);

// Webview bundle (browser, inlined into the panel HTML).
const web = await esbuild.build({
  entryPoints: ['src/webview.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  outfile: 'dist/webview.js',
  minify: true,
  sourcemap: false,
  logLevel: 'info',
  loader: { '.wasm': 'binary' },
  metafile: true,
});

// Third-party notices: every npm package that ended up in the webview bundle (+ the worker).
const pkgDirs = new Set([resolve('node_modules/@niivue/dcm2niix')]);
for (const input of Object.keys(web.metafile.inputs)) {
  const m = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
  if (m) pkgDirs.add(resolve(m[1]));
}
let notices = '# Third-party notices\n\nThis extension bundles the following open-source packages.\n';
const seen = new Set();
for (const dir of [...pkgDirs].sort()) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (seen.has(pkg.name)) continue;
  seen.add(pkg.name);
  const found = readdirSync(dir).find((f) => /^(licen[cs]e|copying)/i.test(f));
  // Fallback for packages that don't ship their license file (e.g. @niivue/niivue).
  const fallback = join('licenses', pkg.name.replace('/', '__') + '.txt');
  const licPath = found ? join(dir, found) : existsSync(fallback) ? fallback : undefined;
  notices += `\n## ${pkg.name} ${pkg.version} (${pkg.license ?? 'unknown license'})\n\n`;
  notices += licPath ? '```\n' + readFileSync(licPath, 'utf8').trim() + '\n```\n' : '_No license file found in the package._\n';
  if (!licPath) console.warn(`WARNING: no license text for ${pkg.name}`);
}
writeFileSync('THIRD_PARTY_NOTICES.md', notices);
console.log(`THIRD_PARTY_NOTICES.md: ${seen.size} packages`);
