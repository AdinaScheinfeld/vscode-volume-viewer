import * as esbuild from 'esbuild';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

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

// Third-party notices: every npm package that ended up in the webview bundle.
const pkgDirs = new Set();
for (const input of Object.keys(web.metafile.inputs)) {
  const m = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
  if (m) pkgDirs.add(m[1]);
}
let notices = '# Third-party notices\n\nThis extension bundles the following open-source packages.\n';
for (const dir of [...pkgDirs].sort()) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const found = readdirSync(dir).find((f) => /^(licen[cs]e|copying)/i.test(f));
  // Fallback for packages that don't ship their license file (e.g. @niivue/niivue).
  const fallback = join('licenses', pkg.name.replace('/', '__') + '.txt');
  const licPath = found ? join(dir, found) : existsSync(fallback) ? fallback : undefined;
  notices += `\n## ${pkg.name} ${pkg.version} (${pkg.license ?? 'unknown license'})\n\n`;
  notices += licPath ? '```\n' + readFileSync(licPath, 'utf8').trim() + '\n```\n' : '_No license file found in the package._\n';
  if (!licPath) console.warn(`WARNING: no license text for ${pkg.name}`);
}
writeFileSync('THIRD_PARTY_NOTICES.md', notices);
console.log(`THIRD_PARTY_NOTICES.md: ${pkgDirs.size} packages`);
