/**
 * Optional AI models you download from the app (Settings → Stickers), instead of carrying them in the
 * Docker image: the picture search for stickers (clip.ts). Each choice is a fixed set of files from
 * Hugging Face with fixed checksums (SHA-256 for big files, Git's SHA-1 for small ones, as Hugging Face
 * lists them), saved in DATA_DIR/models/<id>/ so they survive updates. One download at a time; a file
 * that doesn't match is thrown away and the download fails.
 *
 * kv `clip_model`: the installed choice. Tests: MODELS_BASE_URL points the downloads at a local server,
 * and the "test" choice (MODELS_TEST=1) has tiny files.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { kvGet, kvSet } from './db.js';

export interface ModelFile {
  role: 'vision' | 'text' | 'dense' | 'tokenizer';
  repo: string;
  path: string;
  size: number;
  sha256?: string;
  gitSha1?: string; // small files: Hugging Face lists their Git object id
}
export interface ModelChoice {
  id: string;
  label: string;
  description: string;
  files: ModelFile[];
}

const XEN = 'Xenova/clip-vit-base-patch32';
const ST = 'sentence-transformers/clip-ViT-B-32-multilingual-v1';
const arm = process.arch === 'arm64';
const extras: ModelFile[] = [
  { role: 'dense', repo: ST, path: '2_Dense/model.safetensors', size: 1572984, sha256: 'd12568dc7300970a4d3dbb49068ad16cd89b99840b74b026f8e48071e9414f74' },
  { role: 'tokenizer', repo: ST, path: 'tokenizer.json', size: 1961847, gitSha1: 'f930bdc88c40a163884a6264ebd3bd10688ae1af' },
];

export const MODEL_CHOICES: ModelChoice[] = [
  {
    id: 'clip-multi-compact',
    label: 'Compact',
    description: 'Understands Dutch, English and 50 more languages. Compressed: a little less precise, a quarter of the size.',
    files: [
      { role: 'vision', repo: XEN, path: 'onnx/vision_model_quantized.onnx', size: 89117001, sha256: '583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299' },
      arm
        ? { role: 'text', repo: ST, path: 'onnx/model_qint8_arm64.onnx', size: 135336307, sha256: '3bed77e83926519660b5c0833cb3321cfde952331edec4f7d501c7d384b8a8a7' }
        : { role: 'text', repo: ST, path: 'onnx/model_quint8_avx2.onnx', size: 135377779, sha256: 'fbc8fbeaa5237d96bd1bf430057c70d34de8334a463e933a5faa305f6caeed9' },
      ...extras,
    ],
  },
  {
    id: 'clip-multi-full',
    label: 'Full quality',
    description: 'The same models uncompressed: slightly better matches, about four times the size and a bit slower.',
    files: [
      { role: 'vision', repo: XEN, path: 'onnx/vision_model.onnx', size: 351685709, sha256: 'fd6e1402a588279d1723c7534d4bcba5bc0b14b47dfab0e46f8c47b8270d7d40' },
      { role: 'text', repo: ST, path: 'onnx/model.onnx', size: 539049415, sha256: 'ca09969eb6e0f36fb1622654d1b47ac2025f576794f48b249a50b78d4b70373f' },
      ...extras,
    ],
  },
];

/** Tests: tiny files from a local server (tests/e2e), see clip.ts's stand-in engine. */
function testChoice(): ModelChoice | null {
  if (!process.env.MODELS_TEST) return null;
  try {
    return JSON.parse(process.env.MODELS_TEST) as ModelChoice;
  } catch {
    return null;
  }
}
export function modelChoices(): ModelChoice[] {
  const t = testChoice();
  return t ? [...MODEL_CHOICES, t] : MODEL_CHOICES;
}

const baseUrl = () => (process.env.MODELS_BASE_URL ?? 'https://huggingface.co').replace(/\/$/, '');
const dirOf = (id: string) => path.join(config.dataDir, 'models', id);
export const choiceSize = (c: ModelChoice) => c.files.reduce((n, f) => n + f.size, 0);

export function installedModel(): { choice: ModelChoice; dir: string; file: (role: ModelFile['role']) => string } | null {
  const id = kvGet('clip_model');
  const choice = modelChoices().find((c) => c.id === id);
  if (!choice) return null;
  const dir = dirOf(choice.id);
  const file = (role: ModelFile['role']) => path.join(dir, path.basename(choice.files.find((f) => f.role === role)!.path));
  if (!choice.files.every((f) => fs.existsSync(path.join(dir, path.basename(f.path))))) return null;
  return { choice, dir, file };
}

// ---------- downloading

export interface DownloadState {
  id: string;
  done: number;
  total: number;
  error?: string;
  finished?: boolean;
}
let download: (DownloadState & { abort: AbortController }) | null = null;
const installedListeners = new Set<() => void>();
/** Called when a model was installed or removed. */
export const onModelInstalled = (f: () => void) => installedListeners.add(f);
const changed = () => {}; // progress: the settings page asks for it
const installedChanged = () => installedListeners.forEach((f) => f());

export function downloadState(): DownloadState | null {
  if (!download) return null;
  const { abort: _a, ...rest } = download; // eslint-disable-line @typescript-eslint/no-unused-vars
  return rest;
}

/** Start downloading a choice (replacing the installed one once it's complete and checked). */
export function startDownload(id: string, log: (m: string) => void) {
  const choice = modelChoices().find((c) => c.id === id);
  if (!choice) throw new Error('Unknown model');
  if (download && !download.finished && !download.error) throw new Error('A download is already running');
  const abort = new AbortController();
  download = { id, done: 0, total: choiceSize(choice), abort };
  const state = download;
  void (async () => {
    const tmp = dirOf(choice.id) + '.part';
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });
      for (const f of choice.files) {
        await fetchFile(f, path.join(tmp, path.basename(f.path)), abort.signal, (n) => {
          state.done += n;
          changed();
        });
      }
      // Complete and checked: in place of the old one
      const prev = installedModel();
      fs.rmSync(dirOf(choice.id), { recursive: true, force: true });
      fs.renameSync(tmp, dirOf(choice.id));
      kvSet('clip_model', choice.id);
      if (prev && prev.choice.id !== choice.id) fs.rmSync(prev.dir, { recursive: true, force: true });
      state.finished = true;
      installedChanged();
      log(`models: ${choice.label} picture search model downloaded (${Math.round(state.total / 1e6)} MB)`);
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      state.error = abort.signal.aborted ? 'Cancelled' : (e as Error).message;
      log(`models: download of ${choice.id} failed: ${state.error}`);
    }
    changed();
  })();
}

export function cancelDownload() {
  download?.abort.abort();
}

/** Remove the installed model (picture search off). */
export function removeModel() {
  const m = installedModel();
  const id = kvGet('clip_model');
  if (id) fs.rmSync(dirOf(id), { recursive: true, force: true });
  if (m) fs.rmSync(m.dir, { recursive: true, force: true });
  kvSet('clip_model', '');
  download = null;
  installedChanged();
}

async function fetchFile(f: ModelFile, dest: string, signal: AbortSignal, progress: (n: number) => void) {
  const url = `${baseUrl()}/${f.repo}/resolve/main/${f.path}`;
  const res = await fetch(url, { signal, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${f.path}: ${res.status} ${res.statusText}`);
  const sha256 = crypto.createHash('sha256');
  const sha1 = crypto.createHash('sha1');
  sha1.update(`blob ${f.size}\0`); // how Git names a file's contents
  const out = fs.createWriteStream(dest);
  let got = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      got += chunk.length;
      if (got > f.size) throw new Error(`${f.path}: bigger than expected`);
      sha256.update(chunk);
      sha1.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      progress(chunk.length);
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  if (got !== f.size) throw new Error(`${f.path}: incomplete (${got} of ${f.size} bytes)`);
  if (f.sha256 && sha256.digest('hex') !== f.sha256) throw new Error(`${f.path}: checksum doesn't match`);
  if (f.gitSha1 && sha1.digest('hex') !== f.gitSha1) throw new Error(`${f.path}: checksum doesn't match`);
}
