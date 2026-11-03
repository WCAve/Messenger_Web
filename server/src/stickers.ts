/**
 * Sticker packs. signal-cli remembers the key of every pack it has seen (installed on your phone, or
 * used in a message you received) and the Signal API lists them with that key. With the key we
 * download the encrypted pack from Signal's CDN and decrypt it, exactly like Signal Desktop:
 *   keys       = HKDF-SHA256(packKey, salt = 32 zero bytes, info = "Sticker Pack") → 64 bytes
 *   file       = IV (16) | AES-256-CBC ciphertext | HMAC-SHA256(IV | ciphertext) (32)
 *   manifest   = protobuf StickerPack { title=1, author=2, cover=3, repeated stickers=4 { id=1, emoji=2 } }
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';
import { config } from './config.js';
import { SIGNAL_CA } from './signal-ca.js';
import { signalApi } from './signal-api.js';

const CDN = (process.env.SIGNAL_STICKER_CDN || 'https://cdn.signal.org').replace(/\/+$/, '');
const dir = path.join(config.dataDir, 'stickers');
fs.mkdirSync(dir, { recursive: true });

const PACK_ID = /^[0-9a-f]{32}$/;
const PACK_KEY = /^[0-9a-f]{64}$/;
export const isPackId = (s: string) => PACK_ID.test(s);

export interface StickerInfo {
  id: number;
  emoji: string | null;
}
export interface Manifest {
  title: string;
  author: string;
  cover: StickerInfo | null;
  stickers: StickerInfo[];
}
interface PackEntry {
  packId: string;
  packKey: string;
  title: string;
  author: string;
  installed: boolean;
}

// ---------- download + crypto ----------

const ca = [...tls.rootCertificates, SIGNAL_CA];

function download(url: string, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(u, { ca, timeout: 30_000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(Object.assign(new Error(`CDN answered ${res.statusCode} for ${u.pathname}`), { status: res.statusCode }));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          req.destroy(new Error('Sticker download too large'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Sticker download timed out')));
    req.on('error', reject);
  });
}

export function deriveKeys(packKeyHex: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(packKeyHex, 'hex'), Buffer.alloc(32), Buffer.from('Sticker Pack'), 64));
}

export function decrypt(data: Buffer, keys: Buffer): Buffer {
  if (data.length < 16 + 16 + 32) throw new Error('Encrypted sticker data too short');
  const aesKey = keys.subarray(0, 32);
  const macKey = keys.subarray(32, 64);
  const ivAndCt = data.subarray(0, data.length - 32);
  const mac = data.subarray(data.length - 32);
  const expected = crypto.createHmac('sha256', macKey).update(ivAndCt).digest();
  if (!crypto.timingSafeEqual(mac, expected)) throw new Error('Sticker data failed its integrity check (wrong pack key?)');
  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, ivAndCt.subarray(0, 16));
  return Buffer.concat([decipher.update(ivAndCt.subarray(16)), decipher.final()]);
}

// ---------- minimal protobuf reader ----------

function readVarint(buf: Buffer, pos: { i: number }): number {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (pos.i >= buf.length) throw new Error('Truncated manifest');
    const b = buf[pos.i++];
    result += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return result;
    shift += 7;
    if (shift > 49) throw new Error('Bad varint in manifest');
  }
}

/** Yields [fieldNumber, value] where value is a number (varint) or a Buffer (length-delimited). */
function* fields(buf: Buffer): Generator<[number, number | Buffer]> {
  const pos = { i: 0 };
  while (pos.i < buf.length) {
    const tag = readVarint(buf, pos);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 0) yield [field, readVarint(buf, pos)];
    else if (wire === 2) {
      const len = readVarint(buf, pos);
      const v = buf.subarray(pos.i, pos.i + len);
      pos.i += len;
      yield [field, v];
    } else if (wire === 5) pos.i += 4;
    else if (wire === 1) pos.i += 8;
    else throw new Error(`Unsupported wire type ${wire} in manifest`);
  }
}

function parseSticker(buf: Buffer): StickerInfo {
  const s: StickerInfo = { id: 0, emoji: null };
  for (const [f, v] of fields(buf)) {
    if (f === 1 && typeof v === 'number') s.id = v;
    if (f === 2 && Buffer.isBuffer(v)) s.emoji = v.toString('utf8') || null;
  }
  return s;
}

export function parseManifest(buf: Buffer): Manifest {
  const m: Manifest = { title: '', author: '', cover: null, stickers: [] };
  for (const [f, v] of fields(buf)) {
    if (!Buffer.isBuffer(v)) continue;
    if (f === 1) m.title = v.toString('utf8');
    if (f === 2) m.author = v.toString('utf8');
    if (f === 3) m.cover = parseSticker(v);
    if (f === 4) m.stickers.push(parseSticker(v));
  }
  return m;
}

// ---------- pack registry (keys come from the Signal API) ----------

const packs = new Map<string, PackEntry>();
let lastRefresh = 0;
let refreshing: Promise<void> | null = null;

export function refreshPacks(account: string, force = false): Promise<void> {
  if (!force && Date.now() - lastRefresh < 15_000) return refreshing ?? Promise.resolve();
  refreshing ??= (async () => {
    try {
      const list = await signalApi.stickerPacks(account);
      for (const p of list) {
        const key = /pack_key=([0-9a-f]{64})/i.exec(p.url ?? '')?.[1]?.toLowerCase();
        if (!key || !isPackId(p.pack_id)) continue;
        packs.set(p.pack_id, { packId: p.pack_id, packKey: key, title: p.title, author: p.author, installed: p.installed });
      }
      lastRefresh = Date.now();
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function entry(account: string, packId: string): Promise<PackEntry | undefined> {
  if (!packs.has(packId)) await refreshPacks(account).catch(() => {});
  return packs.get(packId);
}

// ---------- manifests and images, cached on disk ----------

const manifests = new Map<string, Manifest>();
const inflight = new Map<string, Promise<unknown>>();

function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
  let p = inflight.get(key) as Promise<T> | undefined;
  if (!p) {
    p = fn().finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

/** Cached manifest, without touching the network (for building message JSON). */
export function cachedManifest(packId: string): Manifest | null {
  if (!isPackId(packId)) return null;
  const hit = manifests.get(packId);
  if (hit) return hit;
  const file = path.join(dir, packId, 'manifest.json');
  if (!fs.existsSync(file)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
    manifests.set(packId, m);
    return m;
  } catch {
    return null;
  }
}

export function getManifest(account: string, packId: string): Promise<Manifest | null> {
  const cached = cachedManifest(packId);
  if (cached) return Promise.resolve(cached);
  return once(`m:${packId}`, async () => {
    const e = await entry(account, packId);
    if (!e) return null;
    const m = parseManifest(decrypt(await download(`${CDN}/stickers/${packId}/manifest.proto`, 1024 * 1024), deriveKeys(e.packKey)));
    fs.mkdirSync(path.join(dir, packId), { recursive: true });
    fs.writeFileSync(path.join(dir, packId, 'manifest.json'), JSON.stringify(m));
    manifests.set(packId, m);
    return m;
  });
}

function sniff(buf: Buffer): string {
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png'; // also APNG
  if (buf.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  return 'image/webp';
}

/** Path and type of a sticker image, downloading and decrypting it on first use. */
export function getStickerImage(account: string, packId: string, stickerId: number): Promise<{ file: string; type: string } | null> {
  if (!isPackId(packId) || !Number.isInteger(stickerId) || stickerId < 0 || stickerId > 10_000) return Promise.resolve(null);
  const file = path.join(dir, packId, String(stickerId));
  if (fs.existsSync(file)) return Promise.resolve({ file, type: sniff(fs.readFileSync(file).subarray(0, 16)) });
  return once(`s:${packId}:${stickerId}`, async () => {
    const e = await entry(account, packId);
    if (!e) return null;
    const img = decrypt(await download(`${CDN}/stickers/${packId}/full/${stickerId}`, 1024 * 1024), deriveKeys(e.packKey));
    fs.mkdirSync(path.join(dir, packId), { recursive: true });
    fs.writeFileSync(file + '.part', img);
    fs.renameSync(file + '.part', file);
    return { file, type: sniff(img) };
  });
}

export function stickerUrl(packId: string, stickerId: number) {
  return `/api/stickers/${packId}/${stickerId}`;
}

/** Every pack signal-cli knows, with its stickers. Installed packs first. */
export async function listPacks(account: string, log: (m: string) => void) {
  await refreshPacks(account, true).catch((e) => log(`sticker packs: ${(e as Error).message}`));
  const all = [...packs.values()].sort((a, b) => Number(b.installed) - Number(a.installed) || a.title.localeCompare(b.title));
  const out = await Promise.all(
    all.map(async (p) => {
      try {
        const m = await getManifest(account, p.packId);
        if (!m || !m.stickers.length) return null;
        const cover = m.cover ?? m.stickers[0];
        return {
          packId: p.packId,
          title: m.title || p.title || 'Sticker pack',
          author: m.author || p.author || '',
          installed: p.installed,
          cover: { id: cover.id, emoji: cover.emoji, url: stickerUrl(p.packId, cover.id) },
          stickers: m.stickers.map((s) => ({ id: s.id, emoji: s.emoji, url: stickerUrl(p.packId, s.id) })),
        };
      } catch (e) {
        log(`sticker pack ${p.packId}: ${(e as Error).message}`);
        return null;
      }
    }),
  );
  return out.filter((x): x is NonNullable<typeof x> => !!x);
}

/** Parse a signal.art/addstickers link (or a bare "pack_id pack_key" pair). */
export function parsePackLink(text: string): { packId: string; packKey: string } | null {
  const id = /pack_id=([0-9a-f]{32})/i.exec(text)?.[1];
  const key = /pack_key=([0-9a-f]{64})/i.exec(text)?.[1];
  if (id && key) return { packId: id.toLowerCase(), packKey: key.toLowerCase() };
  const parts = text.trim().split(/[\s,:]+/);
  if (parts.length === 2 && PACK_ID.test(parts[0]) && PACK_KEY.test(parts[1])) return { packId: parts[0], packKey: parts[1] };
  return null;
}
