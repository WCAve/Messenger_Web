/**
 * Reading the text in stickers (OCR), for sticker search. PaddleOCR's PP-OCRv5 models (text detection +
 * the Latin-alphabet reader), run by the ONNX runtime inside the server; the models come with the Docker
 * image (OCR_MODELS_DIR, downloaded and checked when the image is built). Without them (running outside
 * Docker), there is no OCR: `ocrAvailable()` is false and sticker search uses only names and emoji.
 * Tests use STICKER_OCR=fake, which "reads" a marker in the file (see fakeRead).
 *
 * The steps, as PaddleOCR does them:
 *  1. ffmpeg turns the sticker into raw pixels, 736×736 (stickers are 512; bigger finds small text), with
 *     the transparent parts filled in: white first, black when that finds nothing (white text with a
 *     black outline disappears on white, the outline on black). Animated WebP (which this ffmpeg can't
 *     read) goes through webpmux for its first frame.
 *  2. Detection: a map of where text is; above 0.3 is text; each blob of text pixels becomes a box,
 *     grown a little ("unclip", as the model was trained for) and kept when the map is sure enough (0.5).
 *  3. Recognition: each box cut out, scaled to 48 px high, read; the model gives letter chances per
 *     column, which become text by the usual CTC rule (best letter per column, repeats and blanks out).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Ort = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const SIZE = 736; // a multiple of 32, as the detector needs
const DET_THRESH = 0.3;
const BOX_THRESH = 0.5;
const UNCLIP = 1.6;
const REC_H = 48;
const MIN_CONFIDENCE = 0.55;

const modelsDir = process.env.OCR_MODELS_DIR ?? '/app/models/ocr';
const fake = process.env.STICKER_OCR === 'fake';

export function onnxRuntime(): Promise<Ort | null> {
  ortP ??= import('onnxruntime-node' as string).catch(() => null);
  return ortP;
}
let ortP: Promise<Ort | null> | null = null;

let engine: Promise<{ ort: Ort; det: Ort; rec: Ort; chars: string[] } | null> | null = null;

function load() {
  engine ??= (async () => {
    const files = ['det.onnx', 'rec.onnx', 'dict.txt'].map((f) => path.join(modelsDir, f));
    if (!files.every((f) => fs.existsSync(f))) return null;
    try {
      const ort: Ort = await onnxRuntime();
      if (!ort) return null;
      // Two threads: reading stickers in the background shouldn't take the whole machine.
      const opts = { intraOpNumThreads: 2, interOpNumThreads: 1, graphOptimizationLevel: 'all' };
      const det = await ort.InferenceSession.create(files[0], opts);
      const rec = await ort.InferenceSession.create(files[1], opts);
      // The reader's letters: index 0 is "blank", then the dictionary, then a space at the end.
      const dict = fs.readFileSync(files[2], 'utf8').split(/\r?\n/);
      if (dict[dict.length - 1] === '') dict.pop();
      return { ort, det, rec, chars: ['', ...dict, ' '] };
    } catch (e) {
      console.warn(`ocr: can't start (${(e as Error).message})`);
      return null;
    }
  })();
  return engine;
}

export async function ocrAvailable(): Promise<boolean> {
  return fake || !!(await load());
}

// ---------- pixels

function run(cmd: string, args: string[], timeoutMs = 30_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err = (err + d).slice(-500)));
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => (clearTimeout(t), reject(e)));
    p.on('close', (code) => (clearTimeout(t), code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${cmd} failed: ${err.trim()}`))));
  });
}

/**
 * The first frame of an image as size×size RGBA pixels: `fit` fits it in (the rest transparent), `fill`
 * fills the square and cuts off the edges (as CLIP looks at pictures). Animated WebP, which this ffmpeg
 * can't read, goes through webpmux. Also used by clip.ts.
 */
export async function rgbaSquare(file: string, size: number, mode: 'fit' | 'fill' = 'fit'): Promise<Buffer> {
  const vf =
    mode === 'fit'
      ? `scale=${size}:${size}:force_original_aspect_ratio=decrease:flags=bicubic,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba`
      : `scale=${size}:${size}:force_original_aspect_ratio=increase:flags=bicubic,crop=${size}:${size},format=rgba`;
  const args = (input: string) => ['-v', 'error', '-i', input, '-frames:v', '1', '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'];
  try {
    const buf = await run('ffmpeg', args(file));
    if (buf.length === size * size * 4) return buf;
  } catch {
    /* animated WebP, probably: below */
  }
  const tmp = path.join(os.tmpdir(), `img-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.webp`);
  try {
    await run('webpmux', ['-get', 'frame', '1', file, '-o', tmp]);
    const buf = await run('ffmpeg', args(tmp));
    if (buf.length !== size * size * 4) throw new Error('unexpected image size');
    return buf;
  } finally {
    fs.rm(tmp, { force: true }, () => {});
  }
}
const rgba = (file: string) => rgbaSquare(file, SIZE);

/** Fill in transparency over a plain background; returns BGR bytes (what PaddleOCR's models expect). */
function flatten(px: Buffer, bg: number): Uint8Array {
  const out = new Uint8Array(SIZE * SIZE * 3);
  for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
    const a = px[i + 3] / 255;
    out[j] = Math.round(px[i + 2] * a + bg * (1 - a));
    out[j + 1] = Math.round(px[i + 1] * a + bg * (1 - a));
    out[j + 2] = Math.round(px[i] * a + bg * (1 - a));
  }
  return out;
}

// ---------- detection

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

async function detect(e: NonNullable<Awaited<ReturnType<typeof load>>>, bgr: Uint8Array): Promise<Box[]> {
  const n = SIZE * SIZE;
  const input = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) input[c * n + i] = (bgr[i * 3 + c] / 255 - 0.5) / 0.5;
  const res = await e.det.run({ [e.det.inputNames[0]]: new e.ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) });
  const prob = res[e.det.outputNames[0]].data as Float32Array;
  // Text pixels, grown by one (PaddleOCR's 2×2 dilation)
  const on = new Uint8Array(n);
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      if (prob[y * SIZE + x] <= DET_THRESH) continue;
      on[y * SIZE + x] = 1;
      if (x + 1 < SIZE) on[y * SIZE + x + 1] = 1;
      if (y + 1 < SIZE) on[(y + 1) * SIZE + x] = 1;
      if (x + 1 < SIZE && y + 1 < SIZE) on[(y + 1) * SIZE + x + 1] = 1;
    }
  // Blobs (8-connected), each a box
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const boxes: Box[] = [];
  for (let start = 0; start < n; start++) {
    if (!on[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let x0 = SIZE, y0 = SIZE, x1 = 0, y1 = 0, count = 0; // prettier-ignore
    while (sp) {
      const p = stack[--sp];
      const x = p % SIZE;
      const y = (p - x) / SIZE;
      count++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
          const q = ny * SIZE + nx;
          if (on[q] && !seen[q]) (seen[q] = 1), (stack[sp++] = q);
        }
    }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    if (count < 12 || Math.min(w, h) < 4) continue;
    // How sure the map is inside the box ("fast" score)
    let sum = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) sum += prob[y * SIZE + x];
    if (sum / (w * h) < BOX_THRESH) continue;
    // Grow the box: the model marks the middle of the text, smaller than the letters
    const d = (w * h * UNCLIP) / (2 * (w + h));
    boxes.push({
      x0: Math.max(0, Math.floor(x0 - d)),
      y0: Math.max(0, Math.floor(y0 - d)),
      x1: Math.min(SIZE - 1, Math.ceil(x1 + d)),
      y1: Math.min(SIZE - 1, Math.ceil(y1 + d)),
    });
  }
  // Reading order: top to bottom (rows within half a line), then left to right
  boxes.sort((a, b) => (Math.abs(a.y0 - b.y0) < Math.min(a.y1 - a.y0, b.y1 - b.y0) / 2 ? a.x0 - b.x0 : a.y0 - b.y0));
  return boxes.slice(0, 30);
}

// ---------- recognition

async function recognize(e: NonNullable<Awaited<ReturnType<typeof load>>>, bgr: Uint8Array, b: Box): Promise<{ text: string; conf: number }> {
  const bw = b.x1 - b.x0 + 1;
  const bh = b.y1 - b.y0 + 1;
  // Upright text only: a box much taller than wide is read as is (rarely text in stickers)
  const w = Math.max(1, Math.min(REC_H * 40, Math.ceil((REC_H * bw) / bh)));
  const width = Math.max(320, w);
  const plane = REC_H * width;
  const input = new Float32Array(3 * plane); // zero = middle grey after normalising, as PaddleOCR pads
  for (let y = 0; y < REC_H; y++) {
    const sy = Math.min(bh - 1, Math.max(0, ((y + 0.5) * bh) / REC_H - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(bh - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(bw - 1, Math.max(0, ((x + 0.5) * bw) / w - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(bw - 1, x0 + 1);
      const fx = sx - x0;
      for (let c = 0; c < 3; c++) {
        const at = (yy: number, xx: number) => bgr[((b.y0 + yy) * SIZE + (b.x0 + xx)) * 3 + c];
        const v = at(y0, x0) * (1 - fx) * (1 - fy) + at(y0, x1) * fx * (1 - fy) + at(y1, x0) * (1 - fx) * fy + at(y1, x1) * fx * fy;
        input[c * plane + y * width + x] = (v / 255 - 0.5) / 0.5;
      }
    }
  }
  const res = await e.rec.run({ [e.rec.inputNames[0]]: new e.ort.Tensor('float32', input, [1, 3, REC_H, width]) });
  const out = res[e.rec.outputNames[0]];
  const [, steps, classes] = out.dims as number[];
  const data = out.data as Float32Array;
  let text = '';
  let confSum = 0;
  let kept = 0;
  let prev = -1;
  for (let t = 0; t < steps; t++) {
    let best = 0;
    let bestP = -1;
    for (let k = 0; k < classes; k++) {
      const p = data[t * classes + k];
      if (p > bestP) (bestP = p), (best = k);
    }
    if (best !== 0 && best !== prev && best < e.chars.length) {
      text += e.chars[best];
      confSum += bestP;
      kept++;
    }
    prev = best;
  }
  return { text: text.trim(), conf: kept ? confSum / kept : 0 };
}

// ---------- reading a sticker

/** Test stand-in: text after "OCRTEXT:" in the file (up to a 0 byte). */
function fakeRead(file: string): string[] {
  const s = fs.readFileSync(file).toString('latin1');
  const m = /OCRTEXT:([^\0]{1,200})\0/.exec(s);
  return m ? [Buffer.from(m[1], 'latin1').toString('utf8')] : [];
}

/**
 * The lines of text in a sticker (empty: none found). Throws only when the file can't be read at all.
 * `null` when there's no OCR here.
 */
export async function readSticker(file: string): Promise<string[] | null> {
  if (fake) return fakeRead(file);
  const e = await load();
  if (!e) return null;
  const px = await rgba(file);
  for (const bg of [255, 0]) {
    const bgr = flatten(px, bg);
    const lines: string[] = [];
    for (const b of await detect(e, bgr)) {
      const r = await recognize(e, bgr, b);
      // Something that reads like text: letters or digits, and the reader fairly sure
      if (r.conf >= MIN_CONFIDENCE && /[\p{L}\p{N}]{2,}/u.test(r.text)) lines.push(r.text);
    }
    if (lines.length) return lines;
  }
  return [];
}
