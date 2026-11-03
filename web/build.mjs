// Bundles the UI into web/dist with esbuild. `node build.mjs --watch` rebuilds on change.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

function writeIndex(metafile) {
  const outputs = Object.keys(metafile.outputs).map((p) => '/' + path.relative(dist, path.resolve(p)).split(path.sep).join('/'));
  const js = outputs.find((o) => o.endsWith('.js'));
  const css = outputs.find((o) => o.endsWith('.css'));
  const html = fs
    .readFileSync(path.join(root, 'index.html'), 'utf8')
    .replace('<!--CSS-->', css ? `<link rel="stylesheet" href="${css}">` : '')
    .replace('<!--JS-->', `<script type="module" src="${js}"></script>`);
  fs.writeFileSync(path.join(dist, 'index.html'), html);
  for (const f of fs.readdirSync(path.join(root, 'public'))) fs.copyFileSync(path.join(root, 'public', f), path.join(dist, f));
}

const options = {
  entryPoints: [path.join(root, 'src/main.tsx')],
  bundle: true,
  outdir: path.join(dist, 'assets'),
  entryNames: watch ? 'app' : 'app-[hash]',
  format: 'esm',
  target: ['es2022'],
  jsx: 'automatic',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  metafile: true,
  logLevel: 'info',
  nodePaths: process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : [],
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
  plugins: [{ name: 'index-html', setup: (b) => b.onEnd((r) => r.metafile && writeIndex(r.metafile)) }],
};

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
