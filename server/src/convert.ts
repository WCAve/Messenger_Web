/**
 * Making files sendable, on the server, with ffmpeg (and heif-dec for iPhone photos when it's there; both
 * are in the Docker image). Runs just before a message with files is sent (routes.ts deliver), for what
 * the browser couldn't do itself (it shrinks ordinary large photos already, shrink.ts in the web app):
 *
 *   iPhone photos (HEIC/HEIF), TIFF       → JPEG
 *   very large photos that still got here → JPEG, at most 4096 px
 *   video that isn't MP4 with H.264       → MP4 with H.264 (iPhone HEVC, .mov, .mkv, .webm, .avi …);
 *                                           an H.264 .mov is only repacked, without re-encoding
 *
 * Without ffmpeg (running outside Docker) files are sent as they are, like before.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let ffmpeg: boolean | undefined;
let heifDec: boolean | undefined;

function exists(cmd: string, arg = '-version'): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(cmd, [arg], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0 || code === 1));
  });
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => (clearTimeout(t), reject(e)));
    p.on('exit', (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} failed (${code}): ${err.trim().split('\n').pop() ?? ''}`));
    });
  });
}

export async function canConvert() {
  ffmpeg ??= await exists('ffmpeg');
  heifDec ??= await exists('heif-dec', '--version');
  return ffmpeg;
}

const BIG_PHOTO = 16 * 1024 * 1024;
const isHeic = (type: string, name: string) => /^image\/hei[cf]/.test(type) || /\.hei[cf]$/i.test(name);
const swapExt = (name: string, ext: string) => (name.replace(/\.[^./]{1,8}$/, '') || 'file') + ext;

export interface Sendable {
  buf: Buffer;
  type: string;
  name: string;
}

/** What to do with this file, if anything (cheap: from its type, name and size; videos are probed later). */
export function needsConverting(type: string, name: string, size: number): boolean {
  if (isHeic(type, name) || type === 'image/tiff') return true;
  if (type.startsWith('image/') && !/gif|svg|webp/.test(type) && size > BIG_PHOTO) return true;
  return type.startsWith('video/');
}

/** A sendable version of the file, or null when it's fine as it is (or can't be converted). */
export async function convertForSending(f: Sendable, log: (m: string) => void): Promise<Sendable | null> {
  if (!needsConverting(f.type, f.name, f.buf.length) || !(await canConvert())) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-convert-'));
  const input = path.join(dir, 'in' + (path.extname(f.name).replace(/[^.\w]/g, '').slice(0, 8) || ''));
  fs.writeFileSync(input, f.buf);
  try {
    // Photos → JPEG, at most 4096 px on the longest side
    if (f.type.startsWith('image/') || isHeic(f.type, f.name)) {
      const out = path.join(dir, 'out.jpg');
      let source = input;
      if (isHeic(f.type, f.name) && heifDec) {
        source = path.join(dir, 'heif.png');
        await run('heif-dec', [input, source], 120_000);
      }
      await run('ffmpeg', ['-v', 'error', '-y', '-i', source, '-frames:v', '1', '-vf', "scale='min(4096,iw)':'min(4096,ih)':force_original_aspect_ratio=decrease", '-q:v', '3', out], 120_000);
      const buf = fs.readFileSync(out);
      log(`converted ${f.name} (${f.type}, ${mb(f.buf.length)}) to JPEG (${mb(buf.length)})`);
      return { buf, type: 'image/jpeg', name: swapExt(f.name, '.jpg') };
    }
    // Video: only when it isn't MP4/H.264 already
    const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=format_name:stream=codec_type,codec_name', '-of', 'json', input], 60_000).catch(() => '');
    const info = probe ? (JSON.parse(probe) as { format?: { format_name?: string }; streams?: { codec_type: string; codec_name: string }[] }) : {};
    const vcodec = info.streams?.find((s) => s.codec_type === 'video')?.codec_name;
    const acodec = info.streams?.find((s) => s.codec_type === 'audio')?.codec_name;
    const mp4ish = /mp4|mov/.test(info.format?.format_name ?? '');
    if (!vcodec) return null; // not something ffmpeg understands as video: send as is
    if (vcodec === 'h264' && mp4ish && f.type === 'video/mp4' && (!acodec || acodec === 'aac')) return null;
    const out = path.join(dir, 'out.mp4');
    const reencode = vcodec !== 'h264';
    const args = ['-v', 'error', '-y', '-i', input];
    if (reencode) args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-vf', "scale='min(1920,iw)':-2");
    else args.push('-c:v', 'copy');
    args.push(...(acodec ? (acodec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k']) : ['-an']), '-movflags', '+faststart', out);
    await run('ffmpeg', args, 15 * 60_000);
    const buf = fs.readFileSync(out);
    log(`${reencode ? 'converted' : 'repacked'} ${f.name} (${vcodec}, ${mb(f.buf.length)}) to MP4/H.264 (${mb(buf.length)})`);
    return { buf, type: 'video/mp4', name: swapExt(f.name, '.mp4') };
  } catch (e) {
    log(`couldn't convert ${f.name}: ${(e as Error).message}; sending it as it is`);
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
