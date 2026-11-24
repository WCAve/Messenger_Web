/**
 * The sticker library: every WhatsApp/own sticker file you can send again, and how you use stickers.
 *
 *   sticker_lib  one row per sticker file (attachment id) with a hash of its bytes: the same sticker
 *                received ten times is ten files but one sticker (shown once, the oldest file). Forgetting
 *                a sticker (sticker manager) forgets every copy, also ones that come in later.
 *   sticker_use  per sticker (Signal: "sig:<pack>:<id>", library: "loc:<hash>"): how often you sent it,
 *                when last, and whether it's a favourite. The picker's ⭐ tab shows favourites and most used.
 *
 * Text in stickers (OCR, ocr.ts) is read in the background, newest first, once per sticker (copies share
 * it), into sticker_lib.ocr_text; the picker's search looks in it (`searchLibrary`).
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
import { clipModelId, embedImage, embedText, unloadClip } from './clip.js';
import { ocrAvailable, readSticker } from './ocr.js';
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
  if (!row) readSoon();
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

// ---------- reading the text in stickers

let reading = false;
let started = false;
let readTimer: ReturnType<typeof setTimeout> | null = null;
let ocrLog: (msg: string) => void = () => {};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Start reading (after start-up has settled), and keep reading new stickers as they come. */
export function startStickerOcr(log: (msg: string) => void, delayMs = Number(process.env.STICKER_OCR_DELAY_MS ?? 60_000)) {
  ocrLog = log;
  started = true;
  readTimer = setTimeout(() => void readAll(), delayMs);
  readTimer.unref?.();
}
function readSoon() {
  if (!started || reading || readTimer) return;
  readTimer = setTimeout(() => void readAll(), 5000);
  readTimer.unref?.();
}

const nextUnread = db.prepare<[], { id: string; hash: string | null }>(
  'SELECT id, hash FROM sticker_lib WHERE forgotten = 0 AND ocr_at IS NULL ORDER BY added_at DESC LIMIT 1',
);
const readBefore = db.prepare<[string], { ocr_text: string | null }>('SELECT ocr_text FROM sticker_lib WHERE hash = ? AND ocr_at IS NOT NULL LIMIT 1');
const saveText = db.prepare<[string, number, string, string], never>('UPDATE sticker_lib SET ocr_text = ?, ocr_at = ? WHERE id = ? OR hash = ?');

const nextUnseen = db.prepare<[string], { id: string; hash: string | null }>(
  'SELECT id, hash FROM sticker_lib WHERE forgotten = 0 AND (clip_model IS NULL OR clip_model != ?) ORDER BY added_at DESC LIMIT 1',
);
const seenBefore = db.prepare<[string, string], { clip: Uint8Array | null }>('SELECT clip FROM sticker_lib WHERE hash = ? AND clip_model = ? LIMIT 1');
const saveClip = db.prepare<[Uint8Array | null, string, string, string], never>('UPDATE sticker_lib SET clip = ?, clip_model = ? WHERE id = ? OR hash = ?');

/**
 * The background worker: reads the text in stickers (OCR) and, with a picture search model downloaded,
 * looks at them (CLIP), taking turns, newest stickers first, one at a time with a pause in between.
 */
async function readAll() {
  readTimer = null;
  if (reading) return;
  const ocrOn = await ocrAvailable();
  if (!ocrOn && !clipModelId()) return;
  reading = true;
  const t0 = Date.now();
  let n = 0;
  let found = 0;
  let looked = 0;
  const gap = Number(process.env.STICKER_OCR_PAUSE_MS ?? 50);
  const left = db.prepare<[], { n: number }>('SELECT count(DISTINCT coalesce(hash, id)) AS n FROM sticker_lib WHERE forgotten = 0 AND ocr_at IS NULL').get()!.n;
  if (ocrOn && left > 20) ocrLog(`stickers: reading the text in ${left} stickers, in the background`);
  try {
    for (;;) {
      let worked = false;
      // Text
      const row = ocrOn ? nextUnread.get() : undefined;
      if (row) {
        worked = true;
        let text: string;
        const known = row.hash ? readBefore.get(row.hash) : undefined;
        if (known) text = known.ocr_text ?? '';
        else {
          try {
            const lines = exists(row.id) ? await readSticker(localPath(row.id)) : [];
            text = (lines ?? []).join('\n');
          } catch (e) {
            text = ''; // a file it can't read: counts as read, without text
            if (n < 5) ocrLog(`stickers: couldn't read ${row.id}: ${(e as Error).message.slice(0, 200)}`);
          }
          n++;
          if (text) found++;
          if (n % 100 === 0) ocrLog(`stickers: read ${n} of ${left} so far (${found} with text, ${Math.round((Date.now() - t0) / n)} ms each)`);
          await pause(gap);
        }
        saveText.run(text, Date.now(), row.id, row.hash ?? row.id);
      }
      // Picture
      const model = clipModelId();
      const pic = model ? nextUnseen.get(model) : undefined;
      if (pic) {
        worked = true;
        const known = pic.hash ? seenBefore.get(pic.hash, model) : undefined;
        let vec: Uint8Array | null = known?.clip ?? null;
        if (!known) {
          try {
            const v = exists(pic.id) ? await embedImage(localPath(pic.id)) : null;
            vec = v ? new Uint8Array(v.buffer.slice(0)) : null;
          } catch (e) {
            if (looked < 5) ocrLog(`stickers: couldn't look at ${pic.id}: ${(e as Error).message.slice(0, 200)}`);
          }
          looked++;
          if (looked % 250 === 0) ocrLog(`stickers: looked at ${looked} for picture search`);
          await pause(gap);
        }
        if (clipModelId() === model) saveClip.run(vec, model, pic.id, pic.hash ?? pic.id);
      }
      if (!worked) break;
    }
    if (n) ocrLog(`stickers: read the text in ${n} sticker${n === 1 ? '' : 's'} (${found} with text)`);
    if (looked) ocrLog(`stickers: looked at ${looked} sticker${looked === 1 ? '' : 's'} for picture search`);
  } finally {
    reading = false;
  }
}

/** A picture search model was downloaded or removed: look at everything (again). */
export function pictureModelChanged() {
  unloadClip();
  if (!clipModelId()) db.prepare('UPDATE sticker_lib SET clip = NULL, clip_model = NULL').run();
  if (!started) return;
  if (readTimer) clearTimeout(readTimer);
  readTimer = null;
  readSoon();
}

/** How far the reading is: different stickers read, of all of them; and looked at for picture search. */
export async function readingProgress(): Promise<{ available: boolean; done: number; total: number; pictures: { model: string; done: number } | null }> {
  const model = clipModelId();
  const r = db
    .prepare<[string], { total: number; done: number; seen: number }>(
      `SELECT count(DISTINCT coalesce(hash, id)) AS total,
              count(DISTINCT CASE WHEN ocr_at IS NOT NULL THEN coalesce(hash, id) END) AS done,
              count(DISTINCT CASE WHEN clip_model = ? THEN coalesce(hash, id) END) AS seen
       FROM sticker_lib WHERE forgotten = 0`,
    )
    .get(model)!;
  return { available: await ocrAvailable(), done: r.done, total: r.total, pictures: model ? { model, done: r.seen } : null };
}

/** Stickers that look like the search words (picture search), best first; [] without a model. */
export async function searchPictures(query: string, limit = 60): Promise<(LibSticker & { score: number })[]> {
  const model = clipModelId();
  if (!model || !query.trim()) return [];
  const q = await embedText(query.trim());
  if (!q) return [];
  const rows = db
    .prepare<[string], { id: string; hash: string | null; clip: Uint8Array }>('SELECT id, hash, clip FROM sticker_lib WHERE forgotten = 0 AND clip_model = ? AND clip IS NOT NULL ORDER BY added_at ASC')
    .all(model);
  const byHash = new Map<string, { id: string; score: number }>();
  for (const r of rows) {
    const h = r.hash ?? r.id;
    if (byHash.has(h) || !exists(r.id)) continue;
    const v = new Float32Array(r.clip.buffer.slice(r.clip.byteOffset, r.clip.byteOffset + r.clip.byteLength));
    let s = 0;
    for (let i = 0; i < v.length && i < q.length; i++) s += v[i] * q[i];
    byHash.set(h, { id: r.id, score: s });
  }
  const sorted = [...byHash.entries()].sort((a, b) => b[1].score - a[1].score);
  if (!sorted.length) return [];
  // CLIP's scores are only meaningful compared with each other: the best, and whatever is nearly as good
  const best = sorted[0][1].score;
  const floor = Math.max(Number(process.env.CLIP_MIN_SCORE ?? 0.18), best - Number(process.env.CLIP_SPREAD ?? 0.06));
  return sorted
    .filter(([, v]) => v.score >= floor)
    .slice(0, limit)
    .map(([h, v]) => ({ id: v.id, url: url(v.id), key: `loc:${h}`, score: Math.round(v.score * 1000) / 1000 }));
}

// ---------- search

/** Lower case, accents off, only letters and digits: "Néé, JOH!" → "nee joh". */
export function normText(s: string) {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** At most one letter different (OCR mistakes), for longer words. */
function nearly(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return true;
  return a.slice(i + 1) === b.slice(i + 1) || a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i);
}

/** How well the words match a text (0: not): every word must be found; whole words count more. */
export function matchScore(queryWords: string[], text: string): number {
  if (!queryWords.length || !text) return 0;
  const words = text.split(' ');
  let score = 0;
  for (const q of queryWords) {
    let best = 0;
    for (const w of words) {
      if (w === q) best = Math.max(best, 3);
      else if (w.startsWith(q)) best = Math.max(best, 2);
      else if (q.length >= 4 && w.includes(q)) best = Math.max(best, 1.5);
      else if (q.length >= 5 && nearly(q, w)) best = Math.max(best, 1);
    }
    if (!best && q.length >= 4 && text.replace(/ /g, '').includes(q)) best = 1; // "neejoh" for "nee joh"
    if (!best) return 0;
    score += best;
  }
  return score;
}

/** Library stickers whose text matches, best first (then newest). */
export function searchLibrary(query: string, limit = 200): (LibSticker & { text: string })[] {
  const q = normText(query).split(' ').filter(Boolean);
  if (!q.length) return [];
  const rows = db
    .prepare<[], { id: string; hash: string | null; added_at: number; ocr_text: string }>(
      "SELECT id, hash, added_at, ocr_text FROM sticker_lib WHERE forgotten = 0 AND ocr_text IS NOT NULL AND ocr_text != '' ORDER BY added_at ASC",
    )
    .all();
  const byHash = new Map<string, { id: string; at: number; text: string; score: number }>();
  for (const r of rows) {
    const h = r.hash ?? r.id;
    const seen = byHash.get(h);
    if (seen) {
      seen.at = Math.max(seen.at, r.added_at);
      continue;
    }
    const score = matchScore(q, normText(r.ocr_text));
    if (score && exists(r.id)) byHash.set(h, { id: r.id, at: r.added_at, text: r.ocr_text, score });
  }
  return [...byHash.entries()]
    .sort((a, b) => b[1].score - a[1].score || b[1].at - a[1].at)
    .slice(0, limit)
    .map(([h, v]) => ({ id: v.id, url: url(v.id), key: `loc:${h}`, text: v.text }));
}
