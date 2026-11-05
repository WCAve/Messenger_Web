// Bundles the UI into web/dist with esbuild. `node build.mjs --watch` rebuilds on change.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import zlib from 'node:zlib';
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
  fs.cpSync(path.join(root, 'public'), dist, { recursive: true });
  compressFont();
}

// The emoji font is large: keep a brotli copy next to it, the server sends that when the browser accepts it.
let fontDone = false;
function compressFont() {
  const font = path.join(dist, 'emoji', 'noto', 'NotoColorEmoji.ttf');
  if (!fs.existsSync(font) || (watch && fontDone && fs.existsSync(font + '.br'))) return;
  const src = path.join(root, '.cache', 'NotoColorEmoji.ttf.br');
  const stat = fs.statSync(font);
  if (!fs.existsSync(src) || fs.statSync(src).mtimeMs < stat.mtimeMs) {
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, zlib.brotliCompressSync(fs.readFileSync(font), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: stat.size } }));
  }
  fs.copyFileSync(src, font + '.br');
  fontDone = true;
}

const options = {
  entryPoints: [path.join(root, 'src/main.tsx')],
  bundle: true,
  external: ['/emoji/*'], // served from public/, not bundled
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
