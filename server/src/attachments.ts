/**
 * Attachments are copied out of the signal-cli container into our own data dir,
 * so Signal Web keeps them even if the Signal API container is recreated.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import { signalApi } from './signal-api.js';

const SAFE_ID = /^[A-Za-z0-9._-]{1,200}$/;

export function isSafeId(id: string) {
  return SAFE_ID.test(id) && !id.startsWith('.');
}

export function localPath(id: string) {
  if (!isSafeId(id)) throw new Error('invalid attachment id');
  return path.join(config.attachmentsDir, id);
}

/**
 * True when a downloaded MP4/MOV has a video track but no sound track (how Signal sends GIFs).
 * Null when the file isn't available locally. Only looks at files up to 25 MB.
 */
export function isSilentVideo(id: string): boolean | null {
  if (!isSafeId(id)) return null;
  const file = localPath(id);
  if (!fs.existsSync(file)) return null;
  const size = fs.statSync(file).size;
  if (size > 25 * 1024 * 1024) return false;
  const buf = fs.readFileSync(file);
  let video = false;
  let sound = false;
  // Each track's 'hdlr' box: type(4) version/flags(4) pre_defined(4) handler_type(4)
  for (let i = buf.indexOf('hdlr'); i >= 0 && i + 16 <= buf.length; i = buf.indexOf('hdlr', i + 4)) {
    const handler = buf.toString('latin1', i + 12, i + 16);
    if (handler === 'soun') sound = true;
    if (handler === 'vide') video = true;
  }
  return video && !sound;
}

const inflight = new Map<string, Promise<boolean>>();

/** Other sources of attachments (WhatsApp files fetched on first view), plugged in to avoid import cycles. */
export const attachmentHooks = {
  whatsapp: (_id: string): Promise<boolean> => Promise.resolve(false),
};

/** Copy an attachment from the Signal API into local storage. Resolves true when it's available locally. */
export function fetchAttachment(id: string): Promise<boolean> {
  if (!isSafeId(id)) return Promise.resolve(false);
  const file = localPath(id);
  if (fs.existsSync(file)) return Promise.resolve(true);
  if (id.startsWith('wa-')) return attachmentHooks.whatsapp(id);
  let p = inflight.get(id);
  if (!p) {
    p = (async () => {
      const tmp = file + '.part';
      try {
        const res = await signalApi.attachment(id);
        await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(tmp));
        fs.renameSync(tmp, file);
        return true;
      } catch {
        fs.rmSync(tmp, { force: true });
        return false;
      } finally {
        inflight.delete(id);
      }
    })();
    inflight.set(id, p);
  }
  return p;
}

const EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/aac': '.aac',
  'application/pdf': '.pdf',
};

/** Store an outgoing attachment; returns its local id. */
export function saveOutgoing(data: Buffer, contentType: string, filename?: string): string {
  const ext = path.extname(filename ?? '').replace(/[^A-Za-z0-9.]/g, '').slice(0, 10) || EXT[contentType] || '';
  const id = 'out-' + crypto.randomBytes(12).toString('hex') + ext;
  fs.writeFileSync(localPath(id), data);
  return id;
}
