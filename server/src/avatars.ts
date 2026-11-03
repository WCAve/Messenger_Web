/**
 * Profile pictures and group avatars, fetched from the Signal API and cached on disk.
 * Misses are cached too, so chats without an avatar don't hit signal-cli on every page load.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { kvGet, kvSet } from './db.js';
import { signalApi } from './signal-api.js';

const dir = path.join(config.dataDir, 'avatars');
fs.mkdirSync(dir, { recursive: true });

const FRESH_MS = 12 * 3600_000; // re-check for a new picture twice a day
const MISS_MS = 6 * 3600_000;

function sniff(buf: Buffer): string | null {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.subarray(0, 3).toString() === 'GIF') return 'image/gif';
  return null;
}

const inflight = new Map<string, Promise<{ file: string; type: string } | null>>();

function cacheName(kind: 'profile' | 'group', id: string) {
  return crypto.createHash('sha256').update(`${kind}:${id}`).digest('hex').slice(0, 32);
}

/** Bumped whenever we change a picture, and part of its URL, so browsers drop their cached copy. */
export function avatarRev(kind: 'profile' | 'group', id: string): number {
  return Number(kvGet(`avatar_rev:${cacheName(kind, id)}`) ?? 0);
}

/** Forget the cached picture (after it was changed) so the next request fetches the new one. */
export function invalidateAvatar(kind: 'profile' | 'group', id: string) {
  const name = cacheName(kind, id);
  fs.rmSync(path.join(dir, name), { force: true });
  fs.rmSync(path.join(dir, name + '.none'), { force: true });
  kvSet(`avatar_rev:${name}`, String(avatarRev(kind, id) + 1));
}

/** The cached picture file, if any (for re-sending your current photo with a profile update). */
export async function readAvatar(account: string, kind: 'profile' | 'group', id: string): Promise<Buffer | null> {
  const found = await getAvatar(account, kind, id);
  return found ? fs.readFileSync(found.file) : null;
}

export function getAvatar(account: string, kind: 'profile' | 'group', id: string): Promise<{ file: string; type: string } | null> {
  const name = cacheName(kind, id);
  const file = path.join(dir, name);
  const miss = file + '.none';
  let p = inflight.get(name);
  if (p) return p;
  p = (async () => {
    const now = Date.now();
    const cached = fs.existsSync(file) ? fs.statSync(file) : null;
    if (cached && now - cached.mtimeMs < FRESH_MS) return serve(file);
    if (!cached && fs.existsSync(miss) && now - fs.statSync(miss).mtimeMs < MISS_MS) return null;
    try {
      const res = await signalApi.avatar(account, kind, id);
      if (!res) {
        fs.rmSync(file, { force: true });
        fs.writeFileSync(miss, '');
        return null;
      }
      const type = sniff(res.data);
      if (!type) return null; // never serve something we can't identify as an image
      fs.writeFileSync(file + '.part', res.data);
      fs.renameSync(file + '.part', file);
      fs.rmSync(miss, { force: true });
      return { file, type };
    } catch {
      return cached ? serve(file) : null; // Signal API unreachable: keep showing the old picture
    } finally {
      inflight.delete(name);
    }
  })();
  inflight.set(name, p);
  return p;
}

function serve(file: string) {
  const type = sniff(fs.readFileSync(file).subarray(0, 16));
  return type ? { file, type } : null;
}
