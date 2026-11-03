/** Disappearing messages: delete each one (and its files) when its timer runs out. */
import fs from 'node:fs';
import { isSafeId, localPath } from './attachments.js';
import { broadcast } from './events.js';
import { signalApi } from './signal-api.js';
import {
  type Attachment,
  type LinkPreview,
  conversationDto,
  deleteMessageRow,
  expiredMessages,
  getConversation,
  nextExpiry,
  storeHooks,
} from './store.js';

let timer: ReturnType<typeof setTimeout> | undefined;
let log: (msg: string) => void = () => {};

function attachmentIds(m: { attachments: string | null; preview: string | null }): string[] {
  const ids = ((m.attachments ? JSON.parse(m.attachments) : []) as Attachment[]).map((a) => a.id);
  const preview: LinkPreview | null = m.preview ? JSON.parse(m.preview) : null;
  if (preview?.image?.id) ids.push(preview.image.id);
  return ids.filter(isSafeId);
}

export function sweepExpired() {
  const now = Date.now();
  const rows = expiredMessages(now);
  const touched = new Set<number>();
  for (const m of rows) {
    deleteMessageRow(m.id);
    touched.add(m.conversation_id);
    broadcast({ type: 'remove', conversationId: m.conversation_id, messageId: m.id });
    for (const id of attachmentIds(m)) {
      fs.rm(localPath(id), { force: true }, () => {});
      signalApi.deleteAttachment(id).catch(() => {}); // signal-cli keeps its own copy of received files
    }
  }
  for (const id of touched) {
    const conv = getConversation(id);
    if (conv) broadcast({ type: 'conversation', conversation: conversationDto(conv) });
  }
  if (rows.length) log(`removed ${rows.length} disappearing message${rows.length === 1 ? '' : 's'}`);
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
