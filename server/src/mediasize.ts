/**
 * The width and height of photos and videos, so the web app can give each one its final space before it
 * has loaded (no jumping while a chat opens). Signal and WhatsApp usually say; where they don't (files
 * you send, some history, backups), it's read from the file:
 *
 *   photos  from the first bytes (JPEG, PNG, GIF, WebP, BMP), turned by the JPEG's EXIF orientation
 *   videos  ffprobe, turned by the rotation phones store
 *
 * fillMessageSizes() does one message (when it's stored and when its files arrive), and also has its
 * thumbnails and blurred previews made (thumbs.ts); backfillSizes() fills sizes in for everything stored,
 * newest first, a little at a time; backfillThumbs() makes thumbnails for the newest 2000.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { localPath } from './attachments.js';
import { db, kvGet, kvSet } from './db.js';
import { broadcast } from './events.js';
import { type Attachment, getMessage, messageDto, updateMessage } from './store.js';
import { makeThumb, thumbable } from './thumbs.js';

export interface Size {
  width: number;
  height: number;
}

const visual = (a: Attachment) => (a.contentType.startsWith('image/') || a.contentType.startsWith('video/')) && !a.missing;
const needsSize = (a: Attachment) => visual(a) && !(Number(a.width) > 0 && Number(a.height) > 0);

/** A photo's size from its first bytes, or null when it's not a format we know (or broken). */
export function imageSize(file: string): Size | null {
  let buf: Buffer;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      buf = Buffer.alloc(256 * 1024);
      buf = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  return parseImageSize(buf);
}

export function parseImageSize(b: Buffer): Size | null {
  const ok = (width: number, height: number) => (width > 0 && height > 0 && width < 100_000 && height < 100_000 ? { width, height } : null);
  // PNG
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('latin1', 12, 16) === 'IHDR') return ok(b.readUInt32BE(16), b.readUInt32BE(20));
  // GIF
  if (b.length >= 10 && b.toString('latin1', 0, 3) === 'GIF') return ok(b.readUInt16LE(6), b.readUInt16LE(8));
  // BMP (height can be negative: stored top-down)
  if (b.length >= 26 && b.toString('latin1', 0, 2) === 'BM') return ok(b.readInt32LE(18), Math.abs(b.readInt32LE(22)));
  // WebP
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16);
    if (kind === 'VP8X') return ok(1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3));
    if (kind === 'VP8 ') return ok(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
    if (kind === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return ok(1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff));
    }
    return null;
  }
  // JPEG: walk the markers to the frame header; note the EXIF orientation on the way
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    let turned = false;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      const len = b.readUInt16BE(i + 2);
      if (marker === 0xe1 && b.toString('latin1', i + 4, i + 10) === 'Exif\0\0') turned = exifOrientation(b.subarray(i + 10, i + 2 + len)) >= 5;
      // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const h = b.readUInt16BE(i + 5);
        const w = b.readUInt16BE(i + 7);
        return turned ? ok(h, w) : ok(w, h);
      }
      i += 2 + len;
    }
  }
  return null;
}

/** The EXIF orientation of a JPEG (1 = as stored; 5–8 turn it a quarter, so width and height swap). */
export function jpegOrientation(file: string): number {
  try {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(128 * 1024);
    const n = fs.readSync(fd, b, 0, b.length, 0);
    fs.closeSync(fd);
    if (b[0] !== 0xff || b[1] !== 0xd8) return 1;
    for (let i = 2; i + 10 < n && b[i] === 0xff; ) {
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (marker === 0xe1 && b.toString('latin1', i + 4, i + 10) === 'Exif\0\0') return exifOrientation(b.subarray(i + 10, Math.min(n, i + 2 + len)));
      if (marker === 0xda) break; // the picture itself: no EXIF after this
      i += 2 + len;
    }
  } catch {
    /* unreadable: as stored */
  }
  return 1;
}

function exifOrientation(t: Buffer): number {
  if (t.length < 8) return 1;
  const le = t.toString('latin1', 0, 2) === 'II';
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  try {
    const ifd = u32(4);
    const n = u16(ifd);
    for (let k = 0; k < n; k++) {
      const e = ifd + 2 + k * 12;
      if (u16(e) === 0x0112) {
        const o = u16(e + 8);
        return o >= 1 && o <= 8 ? o : 1;
      }
    }
  } catch {
    /* broken EXIF: as stored */
  }
  return 1;
}

/** A video's size as it's shown (phones store "turn 90°" instead of turning the picture). */
export function videoSize(file: string): Promise<Size | null> {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:stream_side_data=rotation:stream_tags=rotate', '-of', 'json', file], { stdio: ['ignore', 'pipe', 'ignore'] });
    const t = setTimeout(() => p.kill('SIGKILL'), 30_000);
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => (clearTimeout(t), resolve(null)));
    p.on('exit', () => {
      clearTimeout(t);
      try {
        const s = JSON.parse(out).streams?.[0];
        const rotation = Number(s?.side_data_list?.find((d: { rotation?: number }) => d.rotation !== undefined)?.rotation ?? s?.tags?.rotate ?? 0);
        const turned = Math.abs(rotation) % 180 === 90;
        resolve(s?.width > 0 && s?.height > 0 ? (turned ? { width: s.height, height: s.width } : { width: s.width, height: s.height }) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/** The size of a stored file, or null when it isn't here (yet) or can't be read. */
export async function sizeOf(a: Attachment): Promise<Size | null> {
  let file: string;
  try {
    file = localPath(a.id);
  } catch {
    return null;
  }
  if (!fs.existsSync(file)) return null;
  if (a.contentType.startsWith('image/')) return imageSize(file);
  return videoSize(file);
}

const needsTiny = (a: Attachment) => thumbable(a) && !a.tiny;

/** Size, thumbnail and blurred preview for one file, as far as they're missing. True when something was added. */
async function prepare(a: Attachment, thumbs: boolean): Promise<boolean> {
  let changed = false;
  if (needsSize(a)) {
    const s = await sizeOf(a);
    if (s) (a.width = s.width), (a.height = s.height), (changed = true);
  }
  if (thumbs && needsTiny(a)) {
    const t = await makeThumb(a);
    if (t.tiny) (a.tiny = t.tiny), (changed = true);
  }
  return changed;
}

/**
 * Fill in what one message's photos and videos are missing (size, thumbnail, blurred preview), and
 * tell the open pages. Called when a message is stored and when its files arrive.
 */
export async function fillMessageSizes(messageId: number) {
  const m = getMessage(messageId);
  if (!m?.attachments) return;
  const atts: Attachment[] = JSON.parse(m.attachments);
  if (!atts.some((a) => needsSize(a) || needsTiny(a))) return;
  let changed = false;
  for (const a of atts) if (await prepare(a, true)) changed = true;
  if (!changed) return;
  // The message may have changed meanwhile (a conversion replaced a file): only add to the same files
  const now = getMessage(messageId);
  if (!now?.attachments) return;
  const done = new Map(atts.map((a) => [a.id, a]));
  const next = (JSON.parse(now.attachments) as Attachment[]).map((a) => {
    const d = done.get(a.id);
    if (!d) return a;
    return { ...a, ...(needsSize(a) && d.width && d.height ? { width: d.width, height: d.height } : {}), ...(!a.tiny && d.tiny ? { tiny: d.tiny } : {}) };
  });
  const row = updateMessage(messageId, { attachments: JSON.stringify(next) });
  if (row) broadcast({ type: 'message', message: messageDto(row) });
}

/**
 * Once: thumbnails and blurred previews for the newest 2000 messages with photos or videos (older ones
 * get a thumbnail when they're first shown), one file at a time with breaks.
 */
export async function backfillThumbs(log: (m: string) => void) {
  if (kvGet('media_thumbs_v1')) return;
  const rows = db
    .prepare<[], { id: number; attachments: string }>(`SELECT id, attachments FROM messages WHERE attachments LIKE '%"image/%' OR attachments LIKE '%"video/%' ORDER BY id DESC LIMIT 2000`)
    .all();
  let made = 0;
  for (const r of rows) {
    let atts: Attachment[];
    try {
      atts = JSON.parse(r.attachments);
    } catch {
      continue;
    }
    if (!atts.some(needsTiny)) continue;
    let changed = false;
    for (const a of atts) if (needsTiny(a) && (await prepare(a, true))) changed = true;
    if (changed && getMessage(r.id)?.attachments === r.attachments) {
      updateMessage(r.id, { attachments: JSON.stringify(atts) });
      made++;
    }
    await new Promise((res) => setTimeout(res, 100));
  }
  kvSet('media_thumbs_v1', '1');
  if (made) log(`thumbnails made for ${made} message${made === 1 ? '' : 's'}`);
}

/**
 * At start: stored messages with a photo or video of unknown size, newest first, in small batches with
 * breaks (so the server stays quick meanwhile). The first time all of them, after that only the ones
 * stored since (media_sizes_upto). Not told to open pages: they get it on the next load.
 */
export async function backfillSizes(log: (m: string) => void) {
  const upto = Number(kvGet('media_sizes_upto') ?? 0);
  const top = db.prepare<[], { id: number | null }>('SELECT max(id) AS id FROM messages').get()?.id ?? 0;
  if (top <= upto) return;
  const page = db.prepare<[number, number], { id: number; attachments: string }>(
    `SELECT id, attachments FROM messages WHERE id < ? AND id > ? AND (attachments LIKE '%"image/%' OR attachments LIKE '%"video/%') ORDER BY id DESC LIMIT 200`,
  );
  let cursor = Number.MAX_SAFE_INTEGER;
  let filled = 0;
  for (;;) {
    const rows = page.all(cursor, upto);
    if (!rows.length) break;
    for (const r of rows) {
      cursor = r.id;
      let atts: Attachment[];
      try {
        atts = JSON.parse(r.attachments);
      } catch {
        continue;
      }
      if (!atts.some(needsSize)) continue;
      let changed = false;
      for (const a of atts) {
        if (!needsSize(a)) continue;
        const s = await sizeOf(a);
        if (s) (a.width = s.width), (a.height = s.height), (changed = true);
      }
      if (changed && getMessage(r.id)?.attachments === r.attachments) {
        // (unchanged meanwhile, e.g. by a file arriving)
        updateMessage(r.id, { attachments: JSON.stringify(atts) });
        filled++;
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  kvSet('media_sizes_upto', String(top));
  if (filled) log(`photo and video sizes filled in for ${filled} message${filled === 1 ? '' : 's'}`);
}
