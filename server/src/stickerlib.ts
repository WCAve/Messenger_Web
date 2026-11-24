/**
 * The sticker library: every WhatsApp/own sticker file you can send again, and how you use stickers.
 *
 *   sticker_lib  one row per sticker file (attachment id) with a hash of its bytes: the same sticker
 *                received ten times is ten files but one sticker (shown once, the oldest file). Forgetting
 *                a sticker (sticker manager) forgets every copy, also ones that come in later.
 *   sticker_use  per sticker (Signal: "sig:<pack>:<id>", library: "loc:<hash>"): how often you sent it,
 *                when last, and whether it's a favourite. The picker's ⭐ tab shows favourites and most used.
 *
 * Until 24 Nov 2026 the library was a list in kv (wa_stickers) capped at 500: `migrateStickerLib` brings
 * back what fell off (backup stickers "stk-<hash>.webp" on disk, stickers in messages) and counts the
 * stickers you sent so "Most used" starts filled.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { isSafeId, localPath } from './attachments.js';
import { config } from './config.js';
import { db, kvGet, kvSet } from './db.js';
import { stickerUrl } from './stickers.js';

const url = (id: string) => `/api/attachments/${encodeURIComponent(id)}`;
const exists = (id: string) => isSafeId(id) && fs.existsSync(localPath(id));

function hashOf(id: string): string | null {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(localPath(id))).digest('hex').slice(0, 24);
  } catch {
    return null;
  }
}

const getRow = db.prepare<[string], { id: string; hash: string | null; forgotten: number }>('SELECT id, hash, forgotten FROM sticker_lib WHERE id = ?');
const insertRow = db.prepare<[string, string | null, number, number], never>(
  'INSERT INTO sticker_lib (id, hash, added_at, forgotten) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET added_at = max(added_at, excluded.added_at)',
);
const forgottenHash = db.prepare<[string], { x: number }>('SELECT 1 AS x FROM sticker_lib WHERE hash = ? AND forgotten = 1 LIMIT 1');

/** A sticker file joins the library (received, sent, imported). `at`: when (newest first in the picker). */
export function addToLibrary(id: string, at = Date.now()) {
  if (!exists(id)) return;
  const row = getRow.get(id);
  const hash = row?.hash ?? hashOf(id);
  const forgotten = row ? row.forgotten : hash && forgottenHash.get(hash) ? 1 : 0;
  insertRow.run(id, hash, at, forgotten);
}

/** Forget stickers (and every copy of them). */
export function forgetFromLibrary(ids: string[]) {
  for (const id of ids) {
    const h = getRow.get(id)?.hash ?? hashOf(id);
    if (h) db.prepare('UPDATE sticker_lib SET forgotten = 1 WHERE hash = ?').run(h);
    db.prepare('UPDATE sticker_lib SET forgotten = 1 WHERE id = ?').run(id);
  }
}

export interface LibSticker {
  id: string;
  url: string;
  key: string; // "loc:<hash>"
}

/** The library, each sticker once (its oldest file that's still there), newest first. */
export function listLibrary(): LibSticker[] {
  const rows = db
    .prepare<[], { id: string; hash: string | null; added_at: number }>('SELECT id, hash, added_at FROM sticker_lib WHERE forgotten = 0 ORDER BY added_at ASC')
    .all();
  const byHash = new Map<string, { id: string; at: number }>();
  for (const r of rows) {
    if (!exists(r.id)) continue;
    const h = r.hash ?? r.id;
    const seen = byHash.get(h);
    if (!seen) byHash.set(h, { id: r.id, at: r.added_at });
    else seen.at = Math.max(seen.at, r.added_at);
  }
  return [...byHash.entries()].sort((a, b) => b[1].at - a[1].at).map(([h, v]) => ({ id: v.id, url: url(v.id), key: `loc:${h}` }));
}

/** The library key of a sticker file ("loc:<hash>"). */
export function libKey(id: string): string | null {
  const h = getRow.get(id)?.hash ?? hashOf(id);
  return h ? `loc:${h}` : null;
}

// ---------- use and favourites

const useStmt = db.prepare<[string, number], never>(
  'INSERT INTO sticker_use (key, uses, last_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET uses = uses + 1, last_at = excluded.last_at',
);
export function recordStickerUse(key: string | null, at = Date.now()) {
  if (key) useStmt.run(key, at);
}
export const signalKey = (packId: string, stickerId: number) => `sig:${packId}:${stickerId}`;

export function setFavorite(key: string, on: boolean) {
  if (!/^(sig:[0-9a-f]{32}:\d+|loc:[0-9a-f]{6,64}|loc:[\w.-]+)$/i.test(key)) throw new Error('bad sticker key');
  db.prepare('INSERT INTO sticker_use (key, uses, favorite) VALUES (?, 0, ?) ON CONFLICT(key) DO UPDATE SET favorite = excluded.favorite').run(key, on ? 1 : 0);
}

export interface TopSticker {
  key: string;
  url: string;
  pick: { packId: string; stickerId: number } | { localId: string };
  uses: number;
  favorite: boolean;
}

/** Favourites, and the stickers you send most (recent use counts a bit more), for the ⭐ tab. */
export function topStickers(): { favorites: TopSticker[]; used: TopSticker[] } {
  const rows = db.prepare<[], { key: string; uses: number; last_at: number | null; favorite: number }>('SELECT key, uses, last_at, favorite FROM sticker_use').all();
  const lib = new Map(listLibrary().map((s) => [s.key, s]));
  const resolve = (key: string): Pick<TopSticker, 'url' | 'pick'> | null => {
    const sig = /^sig:([0-9a-f]{32}):(\d+)$/i.exec(key);
    if (sig) return { url: stickerUrl(sig[1], Number(sig[2])), pick: { packId: sig[1], stickerId: Number(sig[2]) } };
    const s = lib.get(key);
    return s ? { url: s.url, pick: { localId: s.id } } : null;
  };
  const out: (TopSticker & { score: number; favAt: number })[] = [];
  const now = Date.now();
  for (const r of rows) {
    const x = resolve(r.key);
    if (!x) continue;
    const ageDays = r.last_at ? (now - r.last_at) / 86400_000 : 365;
    out.push({ key: r.key, ...x, uses: r.uses, favorite: !!r.favorite, score: r.uses / (1 + ageDays / 30), favAt: r.last_at ?? 0 });
  }
  const clean = ({ score: _s, favAt: _f, ...t }: (typeof out)[number]) => t; // eslint-disable-line @typescript-eslint/no-unused-vars
  return {
    favorites: out.filter((t) => t.favorite).sort((a, b) => b.score - a.score).map(clean),
    used: out.filter((t) => t.uses > 0 && !t.favorite).sort((a, b) => b.score - a.score).slice(0, 24).map(clean),
  };
}

// ---------- once: from the old capped list

export function migrateStickerLib(log: (msg: string) => void) {
  if (kvGet('sticker_lib_v1')) return;
  const t0 = Date.now();
  let n = 0;
  db.transaction(() => {
    // 1. The old list (newest first, with when)
    let old: { id: string; at: number }[] = [];
    try {
      old = JSON.parse(kvGet('wa_stickers') ?? '[]');
    } catch {
      /* none */
    }
    for (const s of old) if (s?.id) (addToLibrary(s.id, s.at || 0), n++);
    // 2. Stickers in messages (received and sent), and the ones you sent count as uses
    const rows = db
      .prepare<[], { attachments: string; sent_ts: number; outgoing: number; sticker: string | null }>(
        `SELECT attachments, sent_ts, outgoing, sticker FROM messages
         WHERE deleted = 0 AND (sticker IS NOT NULL OR attachments LIKE '%"sticker":true%')`,
      )
      .all();
    for (const r of rows) {
      if (r.sticker) {
        const [packId, id] = r.sticker.split(':');
        if (r.outgoing && packId && id) recordStickerUse(signalKey(packId, Number(id)), r.sent_ts);
        continue;
      }
      let atts: { id: string; sticker?: boolean }[] = [];
      try {
        atts = JSON.parse(r.attachments);
      } catch {
        continue;
      }
      for (const a of atts) {
        if (!a?.sticker || !a.id) continue;
        if (!getRow.get(a.id)) (addToLibrary(a.id, r.sent_ts), n++);
        if (r.outgoing) recordStickerUse(libKey(a.id), r.sent_ts);
      }
    }
    // 3. Backup stickers that fell off the 500 list: "stk-<hash>.webp" files
    let files: string[] = [];
    try {
      files = fs.readdirSync(config.attachmentsDir).filter((f) => /^stk-[0-9a-f]{24}\.webp$/.test(f));
    } catch {
      /* no folder */
    }
    for (const f of files) {
      if (getRow.get(f)) continue;
      let at = 0;
      try {
        at = fs.statSync(localPath(f)).mtimeMs;
      } catch {
        continue;
      }
      addToLibrary(f, Math.min(at, old.length ? Math.min(...old.map((s) => s.at || Infinity)) - 1 : at)); // behind the ones that were still listed
      n++;
    }
  })();
  kvSet('sticker_lib_v1', '1');
  log(`stickers: library set up from ${n} files (${listLibrary().length} different stickers) in ${Date.now() - t0} ms`);
}
