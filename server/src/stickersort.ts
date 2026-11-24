/**
 * The sticker sorting game (web: StickerSorter.tsx). Two rounds:
 *
 *   keep or throw away  one library sticker at a time, newest first, ones you haven't decided on yet
 *                       (sticker_lib.kept_at null; stickers in your own packs count as kept). Throwing
 *                       away is the sticker manager's forget (also takes it out of packs); keeping sets
 *                       kept_at for every copy. Search words can be added on the way.
 *   look-alikes         groups from lookAlikeGroups() (stickerlib.ts): keep one (or some), the others are
 *                       thrown away and their search words, uses and favourite move to the one kept; "not
 *                       the same" keeps them all and the group isn't asked again (kv lookalike_ok).
 *
 * Every decision can be undone (the last one, from the web app).
 */
import fs from 'node:fs';
import { isSafeId, localPath } from './attachments.js';
import { db, kvGet, kvSet } from './db.js';
import { forgetStickers, packStickerIds } from './stickerpacks.js';
import { libKey, lookAlikeGroups, restoreToLibrary, setStickerTags, stickerTags } from './stickerlib.js';

const url = (id: string) => `/api/attachments/${encodeURIComponent(id)}`;
const exists = (id: string) => isSafeId(id) && fs.existsSync(localPath(id));

export interface SortCard {
  id: string;
  key: string;
  url: string;
  tags: string[];
  size: number;
  animated: boolean;
}

function card(id: string, key: string): SortCard {
  let size = 0;
  let animated = false;
  try {
    const buf = fs.readFileSync(localPath(id));
    size = buf.length;
    animated = buf.subarray(0, 64).includes('ANIM') || buf.includes('NETSCAPE2.0') || buf.subarray(0, 64).includes('acTL'); // WebP, GIF, APNG
  } catch {
    /* gone */
  }
  return { id, key, url: url(id), tags: stickerTags(key).map((t) => t.tag), size, animated };
}

/** Each undecided sticker once (its oldest file), newest first. */
function undecided(): { id: string; key: string }[] {
  const inPacks = packStickerIds();
  const packHashes = new Set([...inPacks].map((id) => libKey(id)));
  const rows = db
    .prepare<[], { id: string; hash: string | null; added_at: number; kept: number | null }>(
      'SELECT id, hash, added_at, max(kept_at) OVER (PARTITION BY coalesce(hash, id)) AS kept FROM sticker_lib WHERE forgotten = 0 ORDER BY added_at ASC',
    )
    .all();
  const byKey = new Map<string, { id: string; at: number; kept: boolean }>();
  for (const r of rows) {
    if (!exists(r.id)) continue;
    const key = `loc:${r.hash ?? r.id}`;
    const seen = byKey.get(key);
    if (!seen) byKey.set(key, { id: r.id, at: r.added_at, kept: !!r.kept || inPacks.has(r.id) });
    else (seen.at = Math.max(seen.at, r.added_at), (seen.kept ||= inPacks.has(r.id)));
  }
  return [...byKey.entries()]
    .filter(([key, v]) => !v.kept && !packHashes.has(key))
    .sort((a, b) => b[1].at - a[1].at)
    .map(([key, v]) => ({ id: v.id, key }));
}

/** The next stickers to decide on (not the ones in `exclude`: skipped for now), and how many are left. */
export function nextToSort(exclude: string[], n = 30): { cards: SortCard[]; left: number; total: number } {
  const all = undecided();
  const skip = new Set(exclude);
  const total = db.prepare<[], { n: number }>('SELECT count(DISTINCT coalesce(hash, id)) AS n FROM sticker_lib WHERE forgotten = 0').get()!.n;
  return { cards: all.filter((s) => !skip.has(s.id)).slice(0, n).map((s) => card(s.id, s.key)), left: all.length, total };
}

const keepStmt = db.prepare<[number, string, string], never>('UPDATE sticker_lib SET kept_at = ? WHERE id = ? OR hash = ?');
const hashOfRow = (id: string) => db.prepare<[string], { hash: string | null }>('SELECT hash FROM sticker_lib WHERE id = ?').get(id)?.hash ?? id;

/** Keep or throw away one sticker; `tags`: its search words afterwards (when given). */
export function decide(id: string, keep: boolean, tags?: string[]) {
  if (!exists(id)) throw new Error('Sticker not found');
  const key = libKey(id);
  if (key && tags) {
    const learned = new Set(stickerTags(key).filter((t) => t.learned).map((t) => t.tag));
    setStickerTags(key, tags.map((tag) => ({ tag, learned: learned.has(tag) })));
  }
  if (keep) keepStmt.run(Date.now(), id, hashOfRow(id));
  else forgetStickers([id]);
}

/** Undo a decision: undecided again (and back in the library). */
export function undecide(ids: string[]) {
  for (const id of ids.filter(isSafeId)) {
    restoreToLibrary([id]);
    keepStmt.run(null as unknown as number, id, hashOfRow(id));
  }
}

// ---------- look-alikes

const okSet = (): Set<string> => {
  try {
    return new Set(JSON.parse(kvGet('lookalike_ok') ?? '[]') as string[]);
  } catch {
    return new Set();
  }
};
const signature = (keys: string[]) => [...keys].sort().join('|');

/** Look-alike groups still to look at, each sticker with its size (to pick the best copy). */
export function lookAlikesToSort(): { groups: SortCard[][]; left: number } {
  const ok = okSet();
  const fileOf = db.prepare<[string, string], { id: string }>('SELECT id FROM sticker_lib WHERE (hash = ? OR id = ?) AND forgotten = 0 ORDER BY added_at ASC');
  const groups: SortCard[][] = [];
  for (const g of lookAlikeGroups()) {
    if (ok.has(signature(g))) continue;
    const cards = g
      .map((key) => {
        const h = key.slice(4);
        const f = fileOf.all(h, h).find((r) => exists(r.id));
        return f ? card(f.id, key) : null;
      })
      .filter((c): c is SortCard => !!c);
    if (cards.length > 1) groups.push(cards.sort((a, b) => Number(b.animated) - Number(a.animated) || b.size - a.size));
  }
  return { groups, left: groups.length };
}

/**
 * A look-alike group decided: `keep` the ids to keep. The others are thrown away, and their search words,
 * uses and favourite go to the first one kept. Keeping all = "not the same": not asked again.
 */
export function decideLookAlikes(ids: string[], keep: string[]): { thrown: string[] } {
  const all = ids.filter(exists);
  const kept = keep.filter((id) => all.includes(id));
  if (!kept.length) throw new Error('Keep at least one');
  const keys = all.map((id) => libKey(id)!).filter(Boolean);
  if (kept.length === all.length) {
    const ok = okSet();
    ok.add(signature(keys));
    kvSet('lookalike_ok', JSON.stringify([...ok]));
    return { thrown: [] };
  }
  const into = libKey(kept[0])!;
  const thrown = all.filter((id) => !kept.includes(id));
  db.transaction(() => {
    for (const id of thrown) {
      const from = libKey(id);
      if (!from || from === into) continue;
      db.prepare('INSERT OR IGNORE INTO sticker_tags (key, tag, learned, uses, added_at) SELECT ?, tag, learned, uses, added_at FROM sticker_tags WHERE key = ?').run(into, from);
      const use = db.prepare<[string], { uses: number; last_at: number | null; favorite: number }>('SELECT uses, last_at, favorite FROM sticker_use WHERE key = ?').get(from);
      if (use)
        db.prepare(
          'INSERT INTO sticker_use (key, uses, last_at, favorite) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET uses = uses + excluded.uses, last_at = max(coalesce(last_at, 0), coalesce(excluded.last_at, 0)), favorite = max(favorite, excluded.favorite)',
        ).run(into, use.uses, use.last_at, use.favorite);
    }
    for (const id of kept) keepStmt.run(Date.now(), id, hashOfRow(id));
  })();
  forgetStickers(thrown);
  return { thrown };
}

/** Undo "not the same": the group is asked again. */
export function undoLookAlikesOk(ids: string[]) {
  const ok = okSet();
  ok.delete(signature(ids.filter(exists).map((id) => libKey(id)!).filter(Boolean)));
  kvSet('lookalike_ok', JSON.stringify([...ok]));
}
