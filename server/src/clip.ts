/**
 * Picture search for stickers ("cat", "duim omhoog"): multilingual CLIP. Pictures and search words both
 * become 512 numbers ("embeddings"); a sticker matches a search when its numbers point the same way.
 *
 *   pictures  OpenAI's CLIP ViT-B/32 image model (Xenova's ONNX copy): 224×224, colours normalised as
 *             CLIP was trained, out comes `image_embeds`.
 *   words     sentence-transformers' multilingual CLIP text model: multilingual DistilBERT (BERT
 *             WordPiece tokens, below), the average over the words, then one fixed matrix (2_Dense) to
 *             CLIP's 512 numbers. Trained to land where CLIP puts the picture.
 *
 * The models are downloaded from the app (models.ts); without them there's no picture search.
 * STICKER_CLIP=fake (tests): "embeddings" from words in the file ("CLIPTAGS:cat,dog") and the search.
 */
import fs from 'node:fs';
import { installedModel } from './models.js';
import { onnxRuntime, rgbaSquare } from './ocr.js';

type Ort = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export const DIM = 512;
const fake = process.env.STICKER_CLIP === 'fake';

interface Engine {
  id: string;
  ort: Ort;
  vision: Ort;
  text: Ort;
  dense: Float32Array; // 512×768, row by row
  vocab: Map<string, number>;
}
let engine: { id: string; p: Promise<Engine | null> } | null = null;

/** Which model the embeddings belong to ('' when none): stored with each sticker's embedding. */
export function clipModelId(): string {
  if (fake) return installedModel() ? 'fake' : '';
  return installedModel()?.choice.id ?? '';
}

function load(): Promise<Engine | null> {
  const m = installedModel();
  if (!m) return Promise.resolve(null);
  if (engine?.id === m.choice.id) return engine.p;
  const p = (async () => {
    const ort = await onnxRuntime();
    if (!ort) return null;
    const opts = { intraOpNumThreads: 2, interOpNumThreads: 1, graphOptimizationLevel: 'all' };
    const vision = await ort.InferenceSession.create(m.file('vision'), opts);
    const text = await ort.InferenceSession.create(m.file('text'), opts);
    const tok = JSON.parse(fs.readFileSync(m.file('tokenizer'), 'utf8'));
    return { id: m.choice.id, ort, vision, text, dense: readDense(m.file('dense')), vocab: new Map(Object.entries(tok.model.vocab as Record<string, number>)) };
  })().catch((e) => {
    console.warn(`clip: can't start (${(e as Error).message})`);
    engine = null;
    return null;
  });
  engine = { id: m.choice.id, p };
  return p;
}

/** Forget the loaded model (after removing or switching it). */
export function unloadClip() {
  engine = null;
}

/** The one tensor in a safetensors file, as float32. */
function readDense(file: string): Float32Array {
  const buf = fs.readFileSync(file);
  const n = Number(buf.readBigUInt64LE(0));
  const header = JSON.parse(buf.subarray(8, 8 + n).toString('utf8'));
  const key = Object.keys(header).find((k) => k !== '__metadata__')!;
  const t = header[key];
  if (t.dtype !== 'F32' || t.shape[0] !== DIM || t.shape[1] !== 768) throw new Error(`unexpected dense layer ${JSON.stringify(t)}`);
  const [a, b] = t.data_offsets;
  const bytes = buf.subarray(8 + n + a, 8 + n + b);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

// ---------- words → tokens (BERT WordPiece, as the multilingual model's tokenizer.json says: no lower
// casing, accents kept, Chinese characters apart, punctuation apart, "##" for word pieces)

const isPunct = (ch: string) => {
  const c = ch.codePointAt(0)!;
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126) || /\p{P}/u.test(ch);
};
const isCjk = (c: number) =>
  (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x20000 && c <= 0x2a6df) || (c >= 0x2a700 && c <= 0x2b81f) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x2f800 && c <= 0x2fa1f);

export function wordPiece(text: string, vocab: Map<string, number>, maxLen = 128): number[] {
  // clean_text: control characters out, whitespace as spaces; Chinese characters as words of their own
  let clean = '';
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c === 0 || c === 0xfffd || (/\p{C}/u.test(ch) && !/[\t\n\r]/.test(ch))) continue;
    clean += /\s/.test(ch) ? ' ' : isCjk(c) ? ` ${ch} ` : ch;
  }
  const words: string[] = [];
  for (const w of clean.split(' ').filter(Boolean)) {
    let cur = '';
    for (const ch of w) {
      if (isPunct(ch)) {
        if (cur) words.push(cur);
        words.push(ch);
        cur = '';
      } else cur += ch;
    }
    if (cur) words.push(cur);
  }
  const unk = vocab.get('[UNK]') ?? 100;
  const ids = [vocab.get('[CLS]') ?? 101];
  for (const w of words) {
    const chars = [...w];
    if (chars.length > 100) {
      ids.push(unk);
      continue;
    }
    const pieces: number[] = [];
    let start = 0;
    let bad = false;
    while (start < chars.length) {
      let end = chars.length;
      let found: number | undefined;
      while (start < end) {
        const sub = (start > 0 ? '##' : '') + chars.slice(start, end).join('');
        found = vocab.get(sub);
        if (found !== undefined) break;
        end--;
      }
      if (found === undefined) {
        bad = true;
        break;
      }
      pieces.push(found);
      start = end;
    }
    ids.push(...(bad ? [unk] : pieces));
  }
  return [...ids.slice(0, maxLen - 1), vocab.get('[SEP]') ?? 102];
}

// ---------- embeddings

/** A sticker's 512 numbers (unit length), or null when there's no model. */
export async function embedImage(file: string): Promise<Float32Array | null> {
  if (fake) return clipModelId() ? fakeEmbed(fakeTags(file)) : null;
  const e = await load();
  if (!e) return null;
  const S = 224;
  const px = await rgbaSquare(file, S, 'fill');
  const mean = [0.48145466, 0.4578275, 0.40821073];
  const std = [0.26862954, 0.26130258, 0.27577711];
  const plane = S * S;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    const a = px[i * 4 + 3] / 255; // transparent parts as white, like a sticker on a page
    for (let c = 0; c < 3; c++) input[c * plane + i] = ((px[i * 4 + c] * a + 255 * (1 - a)) / 255 - mean[c]) / std[c];
  }
  const res = await e.vision.run({ [e.vision.inputNames[0]]: new e.ort.Tensor('float32', input, [1, 3, S, S]) });
  const out = res.image_embeds ?? res[e.vision.outputNames.find((n: string) => res[n].dims.at(-1) === DIM) ?? e.vision.outputNames[0]];
  return normalize(Float32Array.from(out.data as Float32Array).slice(0, DIM));
}

/** The search words' 512 numbers (unit length), or null when there's no model. */
export async function embedText(text: string): Promise<Float32Array | null> {
  if (fake) return clipModelId() ? fakeEmbed(text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) : null;
  const e = await load();
  if (!e) return null;
  const ids = wordPiece(text, e.vocab);
  const n = ids.length;
  const big = (xs: number[]) => new e.ort.Tensor('int64', BigInt64Array.from(xs.map(BigInt)), [1, n]);
  const feeds: Record<string, unknown> = {};
  for (const name of e.text.inputNames as string[]) {
    if (/input_ids/.test(name)) feeds[name] = big(ids);
    else if (/attention_mask/.test(name)) feeds[name] = big(ids.map(() => 1));
    else if (/token_type_ids/.test(name)) feeds[name] = big(ids.map(() => 0));
  }
  const res = await e.text.run(feeds);
  const outName = (e.text.outputNames as string[]).find((k) => res[k].dims.length === 3) ?? e.text.outputNames[0];
  const hidden = res[outName].data as Float32Array; // [1, n, 768]
  // Average over the tokens, then the fixed matrix to CLIP's 512 numbers
  const H = 768;
  const avg = new Float32Array(H);
  for (let t = 0; t < n; t++) for (let k = 0; k < H; k++) avg[k] += hidden[t * H + k] / n;
  const v = new Float32Array(DIM);
  for (let r = 0; r < DIM; r++) {
    let s = 0;
    for (let k = 0; k < H; k++) s += e.dense[r * H + k] * avg[k];
    v[r] = s;
  }
  return normalize(v);
}

// ---------- test stand-in

function fakeTags(file: string): string[] {
  const m = /CLIPTAGS:([^\0]{1,200})\0/.exec(fs.readFileSync(file).toString('latin1'));
  return m ? m[1].toLowerCase().split(',') : ['nothing'];
}
function fakeEmbed(words: string[]): Float32Array {
  const v = new Float32Array(DIM);
  for (const w of words.filter(Boolean)) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % DIM] += 1;
  }
  v[DIM - 1] += 0.2; // every picture a little alike, as real ones are
  return normalize(v);
}
