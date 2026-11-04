import * as esbuild from 'esbuild';

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
await esbuild.build({
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
});
