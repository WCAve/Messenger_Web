/**
 * Sticker packs made in Messenger Web (the sticker manager), from WhatsApp stickers: received ones,
 * imported ones, or your own images. Signal's packs stay as they are; these sit next to them in the
 * picker. In WhatsApp chats they're sent as WhatsApp stickers, in Signal chats as a picture (Signal's
 * API can install packs but not upload new ones).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { isSafeId, localPath } from './attachments.js';
import { kvGet, kvSet } from './db.js';
import { HttpError } from './http.js';
import { addSticker, listStickersWa, removeStickerWa } from './whatsapp.js';

interface LocalPack {
  id: string;
  title: string;
  stickers: string[]; // attachment ids
  created: number;
}

function load(): LocalPack[] {
  try {
    return JSON.parse(kvGet('local_sticker_packs') ?? '[]');
  } catch {
    return [];
  }
}
function save(packs: LocalPack[]) {
  kvSet('local_sticker_packs', JSON.stringify(packs));
}
const url = (id: string) => `/api/attachments/${encodeURIComponent(id)}`;
const exists = (id: string) => isSafeId(id) && fs.existsSync(localPath(id));

/** Your packs, and the WhatsApp stickers that aren't in one yet. */
export function localStickers() {
  const packs = load();
  const inPacks = new Set(packs.flatMap((p) => p.stickers));
  return {
    packs: packs.map((p) => {
      const stickers = p.stickers.filter(exists).map((id) => ({ id, url: url(id) }));
      return { id: p.id, title: p.title, stickers, cover: stickers[0] ?? null };
    }),
    unsorted: listStickersWa().filter((s) => !inPacks.has(s.id)),
  };
}

function cleanTitle(t: unknown) {
  const s = String(t ?? '').trim().slice(0, 60);
  if (!s) throw new HttpError(400, 'Give the pack a name');
  return s;
}
function cleanIds(ids: unknown): string[] {
  return (Array.isArray(ids) ? ids : []).map(String).filter(exists);
}

export function createPack(title: unknown, ids: unknown) {
  const packs = load();
  const stickers = cleanIds(ids);
  // A sticker lives in one of your packs at a time.
  for (const p of packs) p.stickers = p.stickers.filter((s) => !stickers.includes(s));
  packs.push({ id: 'mw-' + crypto.randomBytes(6).toString('hex'), title: cleanTitle(title), stickers, created: Date.now() });
  save(packs);
  return localStickers();
}

export function updatePack(id: string, patch: { title?: unknown; add?: unknown; remove?: unknown; order?: unknown }) {
  const packs = load();
  const pack = packs.find((p) => p.id === id);
  if (!pack) throw new HttpError(404, 'Pack not found');
  if (patch.title !== undefined) pack.title = cleanTitle(patch.title);
  const add = cleanIds(patch.add);
  if (add.length) {
    for (const p of packs) p.stickers = p.stickers.filter((s) => !add.includes(s));
    pack.stickers.push(...add);
  }
  const remove = new Set((Array.isArray(patch.remove) ? patch.remove : []).map(String));
  if (remove.size) pack.stickers = pack.stickers.filter((s) => !remove.has(s));
  const order = cleanIds(patch.order);
  if (order.length && order.length === pack.stickers.length && order.every((s) => pack.stickers.includes(s))) pack.stickers = order;
  save(packs);
  return localStickers();
}

/** Delete a pack; its stickers go back to "not in a pack". */
export function deletePack(id: string) {
  save(load().filter((p) => p.id !== id));
  return localStickers();
}

/** Remove stickers from the manager altogether (messages that used them keep their copy). */
export function forgetStickers(ids: unknown) {
  const list = (Array.isArray(ids) ? ids : []).map(String);
  const packs = load();
  for (const p of packs) p.stickers = p.stickers.filter((s) => !list.includes(s));
  save(packs);
  for (const id of list) removeStickerWa(id);
  return localStickers();
}

const IMAGE_EXT: Record<string, string> = { 'image/webp': '.webp', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif' };

/** Your own images as stickers (added to "not in a pack", or straight into a pack). */
export function addImages(images: unknown, packId?: string) {
  const ids: string[] = [];
  for (const src of Array.isArray(images) ? images.slice(0, 50) : []) {
    const m = /^data:(image\/[a-z+]+);base64,([\s\S]+)$/.exec(String(src));
    if (!m || !IMAGE_EXT[m[1]]) continue;
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 2 * 1024 * 1024) continue;
    const id = 'stk-' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 24) + IMAGE_EXT[m[1]];
    if (!fs.existsSync(localPath(id))) fs.writeFileSync(localPath(id), buf);
    addSticker(id);
    ids.push(id);
  }
  if (!ids.length) throw new HttpError(400, 'Pick WebP, PNG, JPEG or GIF images (up to 2 MB each)');
  return packId ? updatePack(packId, { add: ids }) : localStickers();
}

export function stickerMime(id: string): string {
  const ext = id.slice(id.lastIndexOf('.')).toLowerCase();
  return Object.entries(IMAGE_EXT).find(([, e]) => e === ext)?.[0] ?? 'image/webp';
}
