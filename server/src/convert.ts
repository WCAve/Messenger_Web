/**
 * Making files sendable, on the server, with ffmpeg (and heif-dec for iPhone photos when it's there; both
 * are in the Docker image). Runs just before a message with files is sent (routes.ts deliver), for what
 * the browser couldn't do itself (it shrinks ordinary large photos already, shrink.ts in the web app):
 *
 *   iPhone photos (HEIC/HEIF), TIFF       → JPEG
 *   very large photos that still got here → JPEG, at most 4096 px
 *   video that isn't MP4 with H.264       → MP4 with H.264 (iPhone HEVC, .mov, .mkv, .webm, .avi …);
 *                                           an H.264 .mov is only repacked, without re-encoding
 *   video bigger than the networks take   → made smaller to fit (SEND_LIMIT_MB): a lower bitrate worked
 *                                           out from its length, and a smaller picture for long ones;
 *                                           tried again lower if it still came out too big
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

export interface Source {
  file: string; // where it is on disk
  type: string;
  name: string;
  size: number;
}

export interface Sendable {
  buf: Buffer;
  type: string;
  name: string;
}

/** What to do with this file, if anything (cheap: from its type, name and size; videos are probed later). */
export function needsConverting(type: string, name: string, size: number, limit = Infinity): boolean {
  if (isHeic(type, name) || type === 'image/tiff') return true;
  if (type.startsWith('image/') && !/gif|svg|webp/.test(type) && size > BIG_PHOTO) return true;
  return type.startsWith('video/') || (size > limit && /\.(mp4|m4v|mov|mkv|webm|avi|wmv|mpe?g|3gp|ts|mts|flv)$/i.test(name));
}

interface Probe {
  format?: { format_name?: string; duration?: string };
  streams?: { codec_type: string; codec_name: string; width?: number; height?: number }[];
}

/**
 * A sendable version of the file, or null when it's fine as it is (or can't be converted). `limit` is the
 * most the network takes, in bytes: bigger videos are made smaller to fit, or this throws (too long to
 * fit at a watchable quality).
 */
export async function convertForSending(f: Source, log: (m: string) => void, limit = Infinity): Promise<Sendable | null> {
  if (!needsConverting(f.type, f.name, f.size, limit) || !(await canConvert())) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-convert-'));
  const input = f.file;
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
      log(`converted ${f.name} (${f.type}, ${mb(f.size)}) to JPEG (${mb(buf.length)})`);
      return { buf, type: 'image/jpeg', name: swapExt(f.name, '.jpg') };
    }
    const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=format_name,duration:stream=codec_type,codec_name,width,height', '-of', 'json', input], 60_000).catch(() => '');
    const info: Probe = probe ? JSON.parse(probe) : {};
    const video = info.streams?.find((s) => s.codec_type === 'video');
    const vcodec = video?.codec_name;
    const acodec = info.streams?.find((s) => s.codec_type === 'audio')?.codec_name;
    const mp4ish = /mp4|mov/.test(info.format?.format_name ?? '');
    if (!vcodec) return null; // not something ffmpeg understands as video: send as is
    const out = path.join(dir, 'out.mp4');
    const audioArgs = acodec ? (acodec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k']) : ['-an'];
    const result = (what: string) => {
      const buf = fs.readFileSync(out);
      log(`${what} ${f.name} (${vcodec}, ${mb(f.size)}) to MP4/H.264 (${mb(buf.length)})`);
      return { buf, type: 'video/mp4', name: swapExt(f.name, '.mp4') };
    };
    if (f.size <= limit) {
      // Video: only when it isn't MP4/H.264 already
      if (vcodec === 'h264' && mp4ish && f.type === 'video/mp4' && (!acodec || acodec === 'aac')) return null;
      const reencode = vcodec !== 'h264';
      const args = ['-v', 'error', '-y', '-i', input];
      if (reencode) args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-vf', "scale='min(1920,iw)':-2");
      else args.push('-c:v', 'copy');
      args.push(...audioArgs, '-movflags', '+faststart', out);
      await run('ffmpeg', args, 15 * 60_000);
      if (fs.statSync(out).size <= limit) return result(reencode ? 'converted' : 'repacked');
      // came out too big: make it smaller below
    }
    // Too big for the network: a bitrate that fits its length, and a smaller picture when that's low
    const seconds = Number(info.format?.duration);
    if (!(seconds > 0)) throw new TooBig(`${f.name} is too big to send (${mb(f.size)}) and its length can't be read to make it smaller`);
    const short = Math.min(video?.width ?? 1080, video?.height ?? 1080);
    for (const share of [0.9, 0.75, 0.6]) {
      const total = (limit * share * 8) / seconds; // bits per second for sound and picture together
      const audio = acodec ? Math.min(96_000, total * 0.15) : 0;
      const vbit = Math.floor(total - audio - 8_000); // a little room for the MP4 itself
      if (vbit < 120_000) throw new TooBig(`${f.name} is too long to make small enough to send (${Math.round(seconds / 60)} minutes; at most about ${Math.floor((limit * 8) / 250_000 / 60)} minutes fit)`);
      const side = Math.min(short, vbit >= 2_500_000 ? 1080 : vbit >= 1_000_000 ? 720 : vbit >= 500_000 ? 480 : 360);
      const scale = `scale='if(gte(iw,ih),-2,${side})':'if(gte(iw,ih),${side},-2)'`;
      const args = ['-v', 'error', '-y', '-i', input, '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', String(vbit), '-maxrate', String(Math.floor(vbit * 1.4)), '-bufsize', String(vbit * 2), '-pix_fmt', 'yuv420p', '-vf', scale];
      args.push(...(acodec ? ['-c:a', 'aac', '-b:a', String(Math.max(32_000, Math.floor(audio))), '-ac', '2'] : ['-an']), '-movflags', '+faststart', out);
      await run('ffmpeg', args, 3 * 3600_000);
      if (fs.statSync(out).size <= limit) return result(`made smaller (${side}p)`);
      log(`${f.name}: ${mb(fs.statSync(out).size)} is still too big, trying lower`);
    }
    throw new TooBig(`${f.name} couldn't be made small enough to send`);
  } catch (e) {
    if (e instanceof TooBig) throw e;
    log(`couldn't convert ${f.name}: ${(e as Error).message}; sending it as it is`);
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The file can't be sent: too big, and it can't be made smaller. The message says so. */
export class TooBig extends Error {}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
