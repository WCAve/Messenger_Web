/**
 * How often you use each emoji (and which :name: you call it by), for "frequently used" in the
 * picker and for ranking :shortcode: suggestions. Kept on the server so every browser shares it.
 */
import { kvGet, kvSet } from './db.js';

interface Use {
  n: number; // times used
  last: number; // ms
  alias?: Record<string, number>; // shortcode → times you picked it by that name
}

const KEY = 'emoji_usage';
let cache: Record<string, Use> | null = null;

function load(): Record<string, Use> {
  if (!cache) {
    try {
      cache = JSON.parse(kvGet(KEY) ?? '{}') ?? {};
    } catch {
      cache = {};
    }
  }
  return cache!;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => kvSet(KEY, JSON.stringify(load())), 1000);
}

// One emoji: keycaps, flags, ZWJ sequences, skin tones and tag sequences count as one.
const EMOJI_RE =
  /(?:\p{Regional_Indicator}\p{Regional_Indicator}|[#*0-9]️?⃣|(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}️)\p{Emoji_Modifier}?(?:‍(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}️?)\p{Emoji_Modifier}?)*(?:[\u{E0020}-\u{E007E}]+\u{E007F})?)/gu;

/** The emoji in a text, each counted once per message (and at most 5 different ones). */
export function emojiIn(text: string | null | undefined): string[] {
  if (!text) return [];
  return [...new Set(text.match(EMOJI_RE) ?? [])].slice(0, 5);
}

export function recordEmoji(list: string[]) {
  if (!list.length) return;
  const u = load();
  const now = Date.now();
  for (const e of list) {
    if (!e || e.length > 32) continue;
    const cur = u[e] ?? { n: 0, last: 0 };
    cur.n += 1;
    cur.last = now;
    u[e] = cur;
  }
  save();
}

export function recordAlias(emoji: string, code: string) {
  if (!emoji || emoji.length > 32 || !/^[a-z0-9_+-]{1,60}$/.test(code)) return;
  const u = load();
  const cur = u[emoji] ?? { n: 0, last: 0 };
  cur.alias = { ...(cur.alias ?? {}), [code]: (cur.alias?.[code] ?? 0) + 1 };
  u[emoji] = cur;
  save();
}

/**
 * Score per emoji: how often, with recent use counting more (it halves every 30 days), and the name
 * you use most for it.
 */
export function emojiUsage() {
  const now = Date.now();
  const out: Record<string, { score: number; alias?: string }> = {};
  for (const [e, u] of Object.entries(load())) {
    const days = Math.max(0, (now - u.last) / 86400_000);
    const score = u.n * Math.pow(0.5, days / 30) + (days < 1 ? 1 : 0);
    const alias = u.alias ? Object.entries(u.alias).sort((a, b) => b[1] - a[1])[0]?.[0] : undefined;
    out[e] = { score: Math.round(score * 100) / 100, ...(alias ? { alias } : {}) };
  }
  return out;
}
