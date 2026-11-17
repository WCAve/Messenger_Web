/**
 * Pinned messages, like on the phones: a message pinned in a chat for 24 hours, 7 days or 30 days (or,
 * when it comes from elsewhere, for good). Pins made here go out through the networks (routes.ts:
 * Signal only in groups, its API can't pin in one-to-one chats; WhatsApp through WAHA); pins made by
 * others or on your phone come in (ingest.ts for Signal, whatsapp.ts for WhatsApp's "pinned a message"
 * notices). Each pin adds a line to the chat; open pages get the new list (event "pins").
 */
import { db } from './db.js';
import { broadcast } from './events.js';
import { emitMessage } from './whatsapp.js';
import { freeTimestamp, getMessage, insertMessage, messageDto, nameForKey, renderBody, type MessageRow } from './store.js';

export const PIN_DURATIONS = [86400, 7 * 86400, 30 * 86400]; // seconds, as the phones offer

export interface PinDto {
  messageId: number;
  sentAt: number;
  author: string;
  authorName: string;
  text: string; // what to show in the bar
  pinnedBy: string;
  pinnedAt: number;
  expiresAt: number | null;
}

function pinText(m: MessageRow): string {
  const dto = messageDto(m);
  if (dto.poll) return `📊 ${dto.poll.question}`;
  const body = renderBody(m.body, m.ranges)?.text;
  if (body) return body.replace(/\s+/g, ' ').slice(0, 200);
  const a = dto.attachments[0];
  if (a) return a.contentType.startsWith('image/') ? '📷 Photo' : a.contentType.startsWith('video/') ? '🎥 Video' : a.contentType.startsWith('audio/') ? '🎤 Voice message' : `📎 ${a.filename || 'File'}`;
  if (dto.sticker) return 'Sticker';
  return 'Message';
}

/** The chat's pins that haven't run out, newest first. */
export function listPins(conversationId: number): PinDto[] {
  const rows = db
    .prepare<[number, number], { message_id: number; pinned_by: string; pinned_at: number; expires_at: number | null }>(
      'SELECT message_id, pinned_by, pinned_at, expires_at FROM message_pins WHERE conversation_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY pinned_at DESC',
    )
    .all(conversationId, Date.now());
  const out: PinDto[] = [];
  for (const r of rows) {
    const m = getMessage(r.message_id);
    if (!m || m.deleted) continue;
    out.push({
      messageId: m.id,
      sentAt: m.sent_ts,
      author: m.author,
      authorName: m.outgoing ? 'You' : nameForKey(m.author),
      text: pinText(m),
      pinnedBy: r.pinned_by,
      pinnedAt: r.pinned_at,
      expiresAt: r.expires_at,
    });
  }
  return out;
}

export function isPinned(messageId: number): boolean {
  return !!db.prepare<[number, number], { x: number }>('SELECT 1 AS x FROM message_pins WHERE message_id = ? AND (expires_at IS NULL OR expires_at > ?)').get(messageId, Date.now());
}

function announce(conversationId: number) {
  broadcast({ type: 'pins', conversationId, pins: listPins(conversationId) });
}

/** "Jan pinned a message" in the chat. */
function line(m: MessageRow, by: string, pinned: boolean, at: number) {
  const who = by === 'self' ? 'You' : nameForKey(by);
  const row = insertMessage({
    conversationId: m.conversation_id,
    sentTs: freeTimestamp(m.conversation_id, at, by),
    author: by,
    outgoing: false, // a system line, even when you did it (no ticks)
    kind: 'system',
    body: `${who} ${pinned ? 'pinned' : 'unpinned'} a message: “${pinText(m).slice(0, 60)}”`,
    read: true,
  });
  if (row) emitMessage(row);
}

/**
 * A message got pinned (here, by someone else, or on your phone). `seconds` ≤ 0 or missing: no end.
 * Pinning what's pinned already only changes its end, without a second line.
 */
export function applyPin(m: MessageRow, by: string, seconds: number | null | undefined, at = Date.now()) {
  const had = isPinned(m.id);
  const expiresAt = seconds && seconds > 0 ? at + seconds * 1000 : null;
  db.prepare(
    `INSERT INTO message_pins (message_id, conversation_id, pinned_by, pinned_at, expires_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET pinned_by = excluded.pinned_by, pinned_at = excluded.pinned_at, expires_at = excluded.expires_at`,
  ).run(m.id, m.conversation_id, by, at, expiresAt);
  if (!had) line(m, by, true, at);
  announce(m.conversation_id);
}

export function applyUnpin(m: MessageRow, by: string, at = Date.now()) {
  const had = isPinned(m.id);
  db.prepare('DELETE FROM message_pins WHERE message_id = ?').run(m.id);
  if (had) line(m, by, false, at);
  announce(m.conversation_id);
}
