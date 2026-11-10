/**
 * Disappearing messages: when the timer runs out the message shows as "disappeared", and what it said is
 * kept, with its files, so it can still be looked at (deleted_messages, click the message).
 */
import { broadcast } from './events.js';
import {
  conversationDto,
  deleteMessageContent,
  expiredMessages,
  messageDto,
  getConversation,
  nextExpiry,
  storeHooks,
} from './store.js';

let timer: ReturnType<typeof setTimeout> | undefined;
let log: (msg: string) => void = () => {};

export function sweepExpired() {
  const now = Date.now();
  const rows = expiredMessages(now);
  const touched = new Set<number>();
  for (const m of rows) {
    const row = deleteMessageContent(m.id, 'expired');
    touched.add(m.conversation_id);
    if (row) broadcast({ type: 'message', message: messageDto(row) });
  }
  for (const id of touched) {
    const conv = getConversation(id);
    if (conv) broadcast({ type: 'conversation', conversation: conversationDto(conv) });
  }
  if (rows.length) log(`${rows.length} disappearing message${rows.length === 1 ? '' : 's'} disappeared (kept, click to see)`);
  schedule();
}

function schedule() {
  clearTimeout(timer);
  const next = nextExpiry();
  if (next === null) return;
  // Cap the wait so clock jumps (or a sleeping host) can't leave messages around for long.
  const wait = Math.min(Math.max(next - Date.now(), 0) + 50, 60_000);
  timer = setTimeout(sweepExpired, wait);
  timer.unref();
}

export function startExpiry(logger: (msg: string) => void) {
  log = logger;
  storeHooks.timersChanged = schedule;
  sweepExpired();
}

export function stopExpiry() {
  clearTimeout(timer);
}
