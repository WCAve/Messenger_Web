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

const inflight = new Map<string, Promise<boolean>>();

/** Copy an attachment from the Signal API into local storage. Resolves true when it's available locally. */
export function fetchAttachment(id: string): Promise<boolean> {
  if (!isSafeId(id)) return Promise.resolve(false);
  const file = localPath(id);
  if (fs.existsSync(file)) return Promise.resolve(true);
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
