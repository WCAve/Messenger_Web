import { CURATED } from './curated';
import { EXTRA } from './extra';

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

const byCode = new Map<string, EmojiEntry>();
for (const entry of EMOJI) for (const c of entry.codes) if (!byCode.has(c)) byCode.set(c, entry);

export function emojiForCode(code: string): string | undefined {
  return byCode.get(code.toLowerCase())?.e;
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
    if (best > 3) {
      for (const w of entry.words) {
        if (w === q) best = Math.min(best, 2.5);
        else if (w.startsWith(q)) best = Math.min(best, 3 + w.length / 100);
      }
    }
    if (best === Infinity) continue;
    if (!entry.curated) best += 0.5;
    const r = recent.indexOf(entry.e);
    if (r >= 0) best -= 0.4 - r / 100;
    scored.push({ entry, code: bestCode, score: best });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit);
}
