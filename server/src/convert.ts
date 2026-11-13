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
 *
 * Video is done by the computer's video chip when it can (Intel Quick Sync through VAAPI: the container
 * needs /dev/dri; HW_VIDEO=off turns it off), several times faster than by the processor. Each video
 * tries: all on the chip (only formats it reads, chipCanRead) → read by the processor, resized and
 * encoded on the chip → all by the processor (libx264). The start-up check (videoChip) runs both chip
 * ways on a small clip. Failures are logged with the video's format.
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
      else reject(new Error(`${cmd} failed (${code}): ${err.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

export async function canConvert() {
  ffmpeg ??= await exists('ffmpeg');
  heifDec ??= await exists('heif-dec', '--version');
  return ffmpeg;
}

// ---------- the video chip (Quick Sync / VAAPI) ----------

let chip: string | null | undefined; // the render device that works, null when there's none
let chipReads = false; // it also reads (decodes) and resizes video itself, not only encodes
let chipNote = '';

/** The video chip's device when it can encode H.264, checked once with a tiny test video. */
export async function videoChip(log?: (m: string) => void): Promise<string | null> {
  if (chip !== undefined) return chip;
  chip = null;
  if (/^(off|0|false|no)$/i.test(process.env.HW_VIDEO ?? '') || !(await canConvert())) return (chipNote = 'switched off'), null;
  const dir = '/dev/dri';
  const devices = process.env.HW_VIDEO_DEVICE ? [process.env.HW_VIDEO_DEVICE] : fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith('renderD')).map((f) => path.join(dir, f)) : [];
  if (!devices.length) return (chipNote = 'no /dev/dri in the container'), null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-chip-'));
  try {
    // A second of ordinary video with sound, put through both ways the chip is used (as encodeVideo does)
    const clip = path.join(tmp, 'clip.mp4');
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip], 60_000);
    for (const dev of devices) {
      const job = { input: clip, out: path.join(tmp, 'out.mp4'), size: ['if(gte(iw,ih),-2,240)', 'if(gte(iw,ih),240,-2)'] as [string, string], bitrate: 500_000, audio: ['-c:a', 'aac', '-b:a', '64000'] };
      try {
        await run('ffmpeg', chipArgs(job, dev, false), 60_000);
      } catch (e) {
        chipNote = `${dev}: ${(e as Error).message}`;
        continue;
      }
      chipReads = await run('ffmpeg', chipArgs(job, dev, true), 60_000).then(
        () => true,
        (e: Error) => (log?.(`video conversion: the video chip can't read video here (${e.message}); the processor reads, the chip does the rest`), false),
      );
      log?.(`video conversion: using the video chip (${dev})`);
      chip = dev;
      chipNote = dev;
      return chip;
    }
  } catch (e) {
    chipNote = (e as Error).message;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  log?.(`video conversion: the video chip can't be used (${chipNote}); using the processor`);
  return null;
}

/** For the settings page: what converts video. */
export async function videoConversion(): Promise<string> {
  if (!(await canConvert())) return 'Not available (no ffmpeg)';
  return (await videoChip()) ? `Video chip (Quick Sync / VAAPI, ${chip}${chipReads ? '' : '; the processor reads the video'})` : `Processor (${chipNote || 'no video chip'})`;
}

/**
 * Whether the chip can read this video itself. Intel's chips read ordinary 8-bit H.264 and 8/10-bit
 * HEVC and VP9; not 10-bit or 4:2:2 H.264 (some cameras). Turned videos (phones store "rotate 90"
 * instead of turning the picture) are turned by the processor, so those are read by the processor too.
 */
function chipCanRead(v: VideoInfo | undefined): boolean {
  if (!v) return false;
  const rotation = Number(v.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0);
  if (rotation % 360 !== 0) return false;
  const fmt = v.pix_fmt ?? '';
  if (v.codec_name === 'h264') return /^(yuv420p|yuvj420p|nv12)$/.test(fmt) && !/10|4:2:2|4:4:4/.test(v.profile ?? '');
  if (v.codec_name === 'hevc' || v.codec_name === 'vp9') return /^(yuv420p|yuvj420p|nv12|yuv420p10le|p010le)$/.test(fmt);
  return v.codec_name === 'mpeg2video';
}

interface VideoInfo {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  profile?: string;
  r_frame_rate?: string;
  side_data_list?: { rotation?: number }[];
  tags?: { rotate?: string };
}

/** ffmpeg arguments for a job on the chip: `reads` = the chip also reads and resizes, else the processor reads. */
function chipArgs(j: VideoJob, dev: string, reads: boolean): string[] {
  const [w, h] = j.size;
  const scale = `scale_vaapi=w='${w}':h='${h}':format=nv12`;
  const input = reads
    ? ['-hwaccel', 'vaapi', '-hwaccel_device', dev, '-hwaccel_output_format', 'vaapi', '-i', j.input, '-vf', scale]
    : ['-init_hw_device', `vaapi=chip:${dev}`, '-filter_hw_device', 'chip', '-i', j.input, '-vf', `format=nv12,hwupload,${scale}`]; // only reading on the processor; resizing on the chip
  return ['-v', 'warning', '-y', ...input, '-c:v', 'h264_vaapi', ...(j.bitrate ? rateArgs(j.bitrate) : ['-qp', '24']), ...(j.fps ? ['-r', String(j.fps)] : []), ...j.audio, '-movflags', '+faststart', j.out];
}

const rateArgs = (b: number) => ['-b:v', String(b), '-maxrate', String(Math.floor(b * 1.4)), '-bufsize', String(b * 2)];

interface VideoJob {
  input: string;
  out: string;
  /** Size of the result, as two ffmpeg expressions (width, height) */
  size: [string, string];
  /** A target bitrate (bits/s); without it, a fixed quality */
  bitrate?: number;
  /** Lower the frame rate to this (made-smaller videos: 60 → 30 fps leaves more for each picture) */
  fps?: number;
  audio: string[];
  /** The probed video stream, to decide whether the chip can read it */
  video?: VideoInfo;
}

/** Encode to MP4/H.264: on the chip when possible, else by the processor. Returns what did it. */
async function encodeVideo(j: VideoJob, log: (m: string) => void, timeoutMs: number): Promise<string> {
  const [w, h] = j.size;
  const dev = await videoChip(log);
  const attempts: [string, string[]][] = [];
  if (dev) {
    if (chipReads && chipCanRead(j.video)) attempts.push(['video chip', chipArgs(j, dev, true)]);
    attempts.push(['processor reads, video chip does the rest', chipArgs(j, dev, false)]);
  }
  attempts.push([
    'processor',
    ['-v', 'warning', '-y', '-i', j.input, '-c:v', 'libx264', '-preset', 'veryfast', ...(j.bitrate ? rateArgs(j.bitrate) : ['-crf', '23']), '-pix_fmt', 'yuv420p', '-vf', `scale='${w}':'${h}'`, ...(j.fps ? ['-r', String(j.fps)] : []), ...j.audio, '-movflags', '+faststart', j.out],
  ]);
  let last: Error | null = null;
  for (const [what, args] of attempts) {
    try {
      await run('ffmpeg', args, timeoutMs);
      return what;
    } catch (e) {
      last = e as Error;
      if (what !== 'processor') log(`video: "${what}" didn't work (${last.message}; video: ${describe(j.video)}); trying the next way`);
    }
  }
  throw last!;
}

const describe = (v?: VideoInfo) => (v ? `${v.codec_name} ${v.profile ?? ''} ${v.pix_fmt ?? ''} ${v.width}x${v.height} ${v.r_frame_rate ?? ''}`.replace(/\s+/g, ' ').trim() : 'unknown');

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
  streams?: VideoInfo[];
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
    const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=format_name,duration:stream=codec_type,codec_name,width,height,pix_fmt,profile,r_frame_rate:stream_side_data=rotation:stream_tags=rotate', '-of', 'json', input], 60_000).catch(() => '');
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
      let how = '';
      if (reencode) how = await encodeVideo({ input, out, size: ['min(1920,iw)', '-2'], audio: audioArgs, video }, log, 15 * 60_000);
      else await run('ffmpeg', ['-v', 'error', '-y', '-i', input, '-c:v', 'copy', ...audioArgs, '-movflags', '+faststart', out], 15 * 60_000);
      if (fs.statSync(out).size <= limit) return result(reencode ? `converted (${how})` : 'repacked');
      // came out too big: make it smaller below
    }
    // Too big for the network: a bitrate that fits its length, and a smaller picture when that's low
    const seconds = Number(info.format?.duration);
    if (!(seconds > 0)) throw new TooBig(`${f.name} is too big to send (${mb(f.size)}) and its length can't be read to make it smaller`);
    const short = Math.min(video?.width ?? 1080, video?.height ?? 1080);
    const [num, den] = (video?.r_frame_rate ?? '').split('/').map(Number);
    const fps = num && den ? num / den : 0;
    log(`making ${f.name} smaller (${mb(f.size)}, ${Math.round(seconds)} s; ${describe(video)}${chipCanRead(video) ? '' : ', the chip can\'t read this one'})`);
    for (const share of [0.9, 0.75, 0.6]) {
      const total = (limit * share * 8) / seconds; // bits per second for sound and picture together
      const audio = acodec ? Math.min(96_000, total * 0.15) : 0;
      const vbit = Math.floor(total - audio - 8_000); // a little room for the MP4 itself
      if (vbit < 120_000) throw new TooBig(`${f.name} is too long to make small enough to send (${Math.round(seconds / 60)} minutes; at most about ${Math.floor((limit * 8) / 250_000 / 60)} minutes fit)`);
      const side = Math.min(short, vbit >= 2_500_000 ? 1080 : vbit >= 1_000_000 ? 720 : vbit >= 500_000 ? 480 : 360);
      const started = Date.now();
      const how = await encodeVideo(
        {
          input,
          out,
          size: [`if(gte(iw,ih),-2,${side})`, `if(gte(iw,ih),${side},-2)`],
          bitrate: vbit,
          fps: fps > 31 ? 30 : undefined,
          video,
          audio: acodec ? ['-c:a', 'aac', '-b:a', String(Math.max(32_000, Math.floor(audio))), '-ac', '2'] : ['-an'],
        },
        log,
        3 * 3600_000,
      );
      if (fs.statSync(out).size <= limit) return result(`made smaller (${side}p, ${how}, ${Math.round((Date.now() - started) / 1000)} s)`);
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
