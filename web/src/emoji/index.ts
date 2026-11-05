import { CURATED } from './curated';
import { EXTRA } from './extra';
import { preferredAlias, usageScore } from './usage';

export interface EmojiEntry {
  e: string; // the emoji
  codes: string[]; // shortcodes without colons, first is the main one
  words: string[]; // extra search words
  category: string;
  curated: boolean;
}

function parse(src: string, curated: boolean, fallbackCategory: string): EmojiEntry[] {
  const out: EmojiEntry[] = [];
  let category = fallbackCategory;
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('# ')) {
      category = line.slice(2);
      continue;
    }
    const [head, kw = ''] = line.split(' | ');
    const sp = head.indexOf(' ');
    if (sp < 0) continue;
    const e = head.slice(0, sp);
    const codes = head.slice(sp + 1).split(',').map((c) => c.trim()).filter(Boolean);
    const words = kw.split(/\s+/).filter(Boolean);
    const flag = codes[0].startsWith('flag_');
    out.push({ e, codes, words, category: flag ? 'Flags' : category, curated });
  }
  return out;
}

export const EMOJI: EmojiEntry[] = [...parse(CURATED, true, 'Smileys'), ...parse(EXTRA, false, 'More')];

/** Picker categories in display order. */
export const CATEGORIES: { name: string; icon: string; items: EmojiEntry[] }[] = (() => {
  const order = ['Smileys', 'Hearts', 'Hands', 'People', 'Animals & nature', 'Food & drink', 'Activities', 'Travel & places', 'Objects', 'Symbols', 'More', 'Flags'];
  const icons: Record<string, string> = {
    Smileys: '😀',
    Hearts: '❤️',
    Hands: '👋',
    People: '🧑',
    'Animals & nature': '🐶',
    'Food & drink': '🍕',
    Activities: '⚽',
    'Travel & places': '✈️',
    Objects: '💡',
    Symbols: '✅',
    More: '🔣',
    Flags: '🏳️',
  };
  return order.map((name) => ({ name, icon: icons[name], items: EMOJI.filter((x) => x.category === name) })).filter((c) => c.items.length);
})();

/** The name to show for an emoji: the one you use most, else its main shortcode. */
export function displayCode(e: string): string | undefined {
  const entry = byEmoji.get(e);
  const mine = preferredAlias(e);
  return mine && (entry?.codes.includes(mine) || entry?.words.includes(mine)) ? mine : entry?.codes[0];
}

const byEmoji = new Map<string, EmojiEntry>();
for (const entry of EMOJI) if (!byEmoji.has(entry.e)) byEmoji.set(entry.e, entry);

const byWord = new Map<string, EmojiEntry[]>();
for (const entry of EMOJI) {
  for (const w of entry.words) {
    if (!/^[a-z0-9_+-]{2,40}$/.test(w)) continue;
    const list = byWord.get(w) ?? byWord.set(w, []).get(w)!;
    if (!list.includes(entry)) list.push(entry);
  }
}

const byCode = new Map<string, EmojiEntry>();
for (const entry of EMOJI) for (const c of entry.codes) if (!byCode.has(c)) byCode.set(c, entry);

/**
 * The emoji for a :name:. A real shortcode wins (":joy:" is always 😂). A name several emoji share
 * (":laugh:" fits 😆, 🤣 and 😂) gives the one you use most.
 */
export function emojiForCode(code: string): string | undefined {
  const c = code.toLowerCase();
  const exact = byCode.get(c);
  if (exact) return exact.e;
  let best: EmojiEntry | undefined;
  let bestScore = -1;
  for (const entry of byWord.get(c) ?? []) {
    const score = usageScore(entry.e) + (entry.curated ? 0.001 : 0);
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best?.e;
}

/** Replace complete :shortcodes: in text, Slack-style. Unknown codes are left alone. */
export function replaceShortcodes(text: string): string {
  return text.replace(/:([a-z0-9_+-]{1,60}):/gi, (m, code) => emojiForCode(code) ?? m);
}

// ---- recently used (per browser) ----
const RECENT_KEY = 'sw-recent-emoji';
export function recentEmoji(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
  } catch {
    return [];
  }
}
export function rememberEmoji(e: string) {
  try {
    const list = [e, ...recentEmoji().filter((x) => x !== e)].slice(0, 24);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
}

/**
 * Rank emoji for a search term. Order: exact shortcode, shortcode prefix, word-start inside a
 * shortcode (":lau" → rolling_on_the_floor_laughing), keyword prefix, then substring anywhere.
 * Hand-picked and recently used emoji win ties.
 */
export function searchEmoji(term: string, limit = 8): { entry: EmojiEntry; code: string }[] {
  const q = term.toLowerCase().replace(/^:|:$/g, '');
  if (!q) return [];
  const recent = recentEmoji();
  const rank = (c: string) => (c === q ? 0 : c.startsWith(q) ? 1 + c.length / 100 : c.includes('_' + q) ? 2 + c.length / 100 : c.includes(q) ? 4 + c.length / 100 : Infinity);
  const scored: { entry: EmojiEntry; code: string; score: number }[] = [];
  for (const entry of EMOJI) {
    let best = Infinity;
    let bestCode = entry.codes[0];
    for (const c of entry.codes) {
      let s = Infinity;
      if (c === q) s = 0;
      else if (c.startsWith(q)) s = 1 + c.length / 100;
      else if (c.includes('_' + q)) s = 2 + c.length / 100;
      else if (c.includes(q)) s = 4 + c.length / 100;
      if (s < best) {
        best = s;
        bestCode = c;
      }
    }
    if (best > 1.5) {
      // Matched by a keyword: offer it under that name, so ":laugh" shows 😂 as :laugh:.
      for (const w of entry.words) {
        const s = w === q ? 1.5 : w.startsWith(q) ? 2.2 + w.length / 100 : Infinity;
        if (s < best) {
          best = s;
          if (/^[a-z0-9_+-]{2,40}$/.test(w)) bestCode = w;
        }
      }
    }
    if (best === Infinity) continue;
    // The name you usually use for this emoji wins when it matches what you're typing about as well.
    const mine = preferredAlias(entry.e);
    if (mine && (entry.codes.includes(mine) || entry.words.includes(mine)) && rank(mine) <= Math.max(best, 1.99)) {
      bestCode = mine;
      best = Math.min(best, rank(mine));
    }
    if (!entry.curated) best += 0.5;
    // Emoji you use a lot come first (up to about one and a half rank steps); otherwise recent picks in this browser.
    const used = usageScore(entry.e);
    if (used > 0) best -= Math.min(1.6, Math.log2(1 + used) * 0.5);
    else {
      const r = recent.indexOf(entry.e);
      if (r >= 0) best -= 0.4 - r / 100;
    }
    scored.push({ entry, code: bestCode, score: best });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit);
}
