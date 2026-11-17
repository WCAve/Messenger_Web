/**
 * The seven quick reactions above a message (server/src/reactions.ts): the usual ones, or the ones you
 * use most (Settings → Chats). Asked once, again shortly after you react and when the setting changes.
 */
import { useSyncExternalStore } from 'react';
import { api } from './api';

export const USUAL_REACTIONS = ['❤️', '👍', '👎', '😂', '😮', '😢', '🙏'];

let list = USUAL_REACTIONS;
let asked = false;
const listeners = new Set<() => void>();

function load() {
  asked = true;
  api
    .quickReactions()
    .then((r) => {
      if (r.list?.length) list = r.list;
      for (const l of listeners) l();
    })
    .catch(() => (asked = false));
}

let soon: ReturnType<typeof setTimeout> | undefined;
/** After reacting, or after the setting changed: ask again in a moment. */
export function refreshQuickReactions(delay = 1500) {
  clearTimeout(soon);
  soon = setTimeout(load, delay);
}

export function useQuickReactions(): string[] {
  if (!asked) load();
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => list,
  );
}
