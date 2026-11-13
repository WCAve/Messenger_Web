/**
 * Thumbnails: what the chat shows instead of the full file.
 *
 *   photo  a JPEG at most 720 px wide (sharp at the chat's 340 px on high-resolution screens), turned
 *          by its EXIF orientation; typically 30–80 KB instead of the original's MBs
 *   video  a still from half a second in, the cover until it's played
 *   tiny   a blurred 24 px version (~300 bytes) kept in the message itself, shown at once while the
 *          thumbnail loads
 *
 * Made with ffmpeg in one go per file, two at a time, and kept in DATA_DIR/thumbs (safe to delete:
 * they're made again when needed). The original stays what's opened, downloaded and forwarded.
 * Animated GIFs and stickers are shown as they are.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { localPath } from './attachments.js';
import { config } from './config.js';
import { jpegOrientation } from './mediasize.js';
import type { Attachment } from './store.js';

const WIDTH = 720;
const TURN: Record<number, string> = { 2: 'hflip', 3: 'hflip,vflip', 4: 'vflip', 5: 'transpose=0', 6: 'transpose=1', 7: 'transpose=3', 8: 'transpose=2' };

/** Photos and videos get a thumbnail; GIF images, stickers and everything else are shown as they are. */
export function thumbable(a: Pick<Attachment, 'contentType'> & Partial<Attachment>): boolean {
  if (a.missing || a.sticker) return false;
  if (a.contentType.startsWith('video/')) return true;
  return a.contentType.startsWith('image/') && !/gif|svg|webp/.test(a.contentType);
}

export const thumbPath = (id: string) => path.join(config.thumbsDir, `${id}.jpg`);

/** The thumbnail, when it has been made already. */
export function thumbIfReady(id: string): string | null {
  const f = thumbPath(id);
  return fs.existsSync(f) ? f : null;
}

let running = 0;
const queue: (() => void)[] = [];
const inflight = new Map<string, Promise<{ file: string | null; tiny: string | null }>>();

function ffmpeg(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', args, { stdio: 'ignore' });
    const t = setTimeout(() => p.kill('SIGKILL'), 60_000);
    p.on('error', () => (clearTimeout(t), resolve(false)));
    p.on('exit', (code) => (clearTimeout(t), resolve(code === 0)));
  });
}

/**
 * Make (or find) the thumbnail and the tiny blurred version of a stored photo or video. Null parts when
 * the file isn't here or ffmpeg can't read it.
 */
export function makeThumb(a: Pick<Attachment, 'id' | 'contentType'>): Promise<{ file: string | null; tiny: string | null }> {
  let p = inflight.get(a.id);
  if (p) return p;
  p = (async () => {
    let src: string;
    try {
      src = localPath(a.id);
    } catch {
      return { file: null, tiny: null };
    }
    if (!fs.existsSync(src)) return { file: null, tiny: null };
    if (running >= 2) await new Promise<void>((r) => queue.push(r));
    running++;
    try {
      fs.mkdirSync(config.thumbsDir, { recursive: true });
      const out = thumbPath(a.id);
      const tmp = `${out}.${process.pid}.part.jpg`;
      const tinyTmp = `${out}.${process.pid}.tiny.jpg`;
      const video = a.contentType.startsWith('video/');
      // Photos: our own turning (ffmpeg versions differ in whether they do it); videos: ffmpeg turns them
      const turn = video ? '' : (TURN[/jpe?g/.test(a.contentType) || /\.jpe?g$/i.test(a.id) ? jpegOrientation(src) : 1] ?? '');
      const graph = `[0:v]${turn ? turn + ',' : ''}split[a][b];[a]scale='min(${WIDTH},iw)':-2[t];[b]scale=24:-2,gblur=sigma=1.2[s]`;
      const outs = ['-filter_complex', graph, '-map', '[t]', '-frames:v', '1', '-q:v', '4', tmp, '-map', '[s]', '-frames:v', '1', '-q:v', '8', tinyTmp];
      let ok = video
        ? (await ffmpeg(['-v', 'error', '-y', '-ss', '0.5', '-i', src, ...outs])) && fs.existsSync(tmp) && fs.statSync(tmp).size > 0
        : await ffmpeg(['-v', 'error', '-y', '-noautorotate', '-i', src, ...outs]);
      if (video && !ok) ok = await ffmpeg(['-v', 'error', '-y', '-i', src, ...outs]); // shorter than half a second
      if (!ok || !fs.existsSync(tmp)) {
        fs.rmSync(tmp, { force: true });
        fs.rmSync(tinyTmp, { force: true });
        return { file: thumbIfReady(a.id), tiny: null };
      }
      fs.renameSync(tmp, out);
      let tiny: string | null = null;
      try {
        tiny = `data:image/jpeg;base64,${fs.readFileSync(tinyTmp).toString('base64')}`;
      } catch {
        /* the thumbnail is what matters */
      }
      fs.rmSync(tinyTmp, { force: true });
      return { file: out, tiny };
    } finally {
      running--;
      queue.shift()?.();
    }
  })().finally(() => inflight.delete(a.id));
  inflight.set(a.id, p);
  return p;
}

/** Forget a file's thumbnail (its message's files were deleted). */
export function removeThumb(id: string) {
  fs.rmSync(thumbPath(id), { force: true });
}
