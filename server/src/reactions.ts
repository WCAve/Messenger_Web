/**
 * The row of quick reactions above a message: the usual seven, or (setting quickReactionsMostUsed) the
 * seven you react with most, counted from your own reactions on stored messages (also the ones you gave
 * on your phone), recent ones counting more (a reaction's weight halves every 60 days; the message's
 * time stands in for when you reacted). Too few of your own yet: filled up with the usual ones.
 */
import { db } from './db.js';
import { getSettings } from './settings.js';

export const USUAL_REACTIONS = ['❤️', '👍', '👎', '😂', '😮', '😢', '🙏'];
const HALF_LIFE_DAYS = 60;

let cache: { at: number; list: string[] } | null = null;

/** Your reactions by weight, most used first. */
export function reactionUsage(): { emoji: string; score: number }[] {
  const since = Date.now() - 2 * 365 * 86400_000; // older ones barely count anyway
  const rows = db.prepare<[number], { reactions: string; sent_ts: number }>(`SELECT reactions, sent_ts FROM messages WHERE sent_ts > ? AND reactions LIKE '%"self"%'`).all(since);
  const score = new Map<string, number>();
  const now = Date.now();
  for (const r of rows) {
    let list: { emoji?: string; author?: string }[];
    try {
      list = JSON.parse(r.reactions);
    } catch {
      continue;
    }
    const mine = list.find((x) => x.author === 'self')?.emoji;
    if (!mine) continue;
    const days = Math.max(0, (now - r.sent_ts) / 86400_000);
    score.set(mine, (score.get(mine) ?? 0) + Math.pow(0.5, days / HALF_LIFE_DAYS));
  }
  return [...score].map(([emoji, s]) => ({ emoji, score: s })).sort((a, b) => b.score - a.score);
}

/** The seven to show (kept for 5 minutes; forget() after you react here). */
export function quickReactions(): { mostUsed: boolean; list: string[] } {
  const mostUsed = getSettings().quickReactionsMostUsed;
  if (!mostUsed) return { mostUsed, list: USUAL_REACTIONS };
  if (!cache || Date.now() - cache.at > 5 * 60_000) {
    const top = reactionUsage()
      .map((u) => u.emoji)
      .slice(0, 7);
    cache = { at: Date.now(), list: [...top, ...USUAL_REACTIONS.filter((e) => !top.includes(e))].slice(0, 7) };
  }
  return { mostUsed, list: cache.list };
}

export function forgetQuickReactions() {
  cache = null;
}
