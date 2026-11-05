/** Your emoji usage from the server: drives "Frequently used" and the order of :shortcode: suggestions. */
import { api } from '../api';

export type Usage = Record<string, { score: number; alias?: string }>;
let usage: Usage = {};
let loaded: Promise<void> | null = null;

export function loadUsage(force = false): Promise<void> {
  if (!loaded || force) {
    loaded = api
      .emojiUsage()
      .then((r) => {
        usage = r.usage ?? {};
      })
      .catch(() => {
        loaded = null;
      });
  }
  return loaded;
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
/** After sending or reacting: fetch the new counts a moment later. */
export function refreshUsageSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void loadUsage(true), 1500);
}

export function usageScore(e: string): number {
  return usage[e]?.score ?? 0;
}

/** The name you use most for this emoji, if you've picked it by name before. */
export function preferredAlias(e: string): string | undefined {
  return usage[e]?.alias;
}

/** Most used first. */
export function frequentEmoji(limit = 32): string[] {
  return Object.entries(usage)
    .filter(([, u]) => u.score > 0)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit)
    .map(([e]) => e);
}

/** You picked an emoji through this :name: (suggestion list or a typed :code:). */
export function rememberAlias(emoji: string, code: string) {
  usage[emoji] = { score: usage[emoji]?.score ?? 0, alias: usage[emoji]?.alias ?? code };
  api.emojiAlias(emoji, code).then(refreshUsageSoon, () => {});
}
