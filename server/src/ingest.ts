/**
 * Turns signal-cli receive envelopes into stored messages and live events.
 * Envelope schema: see the "receive.*" definitions in signal-cli-rest-api's swagger.json.
 */
import { fetchAttachment } from './attachments.js';
import { broadcast } from './events.js';
import {
  type Attachment,
  type ConversationRow,
  type Reaction,
  contactKey,
  conversationDto,
  findMessage,
  getOrCreateDirect,
  getOrCreateGroup,
  insertMessage,
  markConversationRead,
  messageDto,
  nameForKey,
  self,
  updateMessage,
  upsertContact,
} from './store.js';
import { db } from './db.js';
import type { MessageRow } from './store.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export const ingestHooks = {
  /** Called when a group changed (name, members) so the caller can refresh group info. */
  onGroupChanged: () => {},
  log: (_msg: string, _err?: unknown) => {},
};

interface Address {
  uuid?: string | null;
  number?: string | null;
}

const STATUS_RANK: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3, viewed: 3 };

function emitMessage(m: MessageRow | undefined) {
  if (m) broadcast({ type: 'message', message: messageDto(m) });
}
function emitConversation(conv: ConversationRow) {
  broadcast({ type: 'conversation', conversation: conversationDto(conv) });
}

/** Replace the U+FFFC placeholders signal uses for @mentions with readable names. */
function resolveMentions(text: string | undefined | null, mentions: Json[] | undefined): string | null {
  if (!text) return text ?? null;
  if (!mentions?.length) return text;
  const sorted = [...mentions].sort((a, b) => (b.start ?? 0) - (a.start ?? 0));
  let out = text;
  for (const m of sorted) {
    const key = contactKey(m.uuid, m.number);
    const name = key === 'self' ? 'You' : m.name || nameForKey(key);
    out = out.slice(0, m.start) + '@' + name + out.slice(m.start + (m.length || 1));
  }
  return out;
}

function mapAttachments(list: Json[] | undefined): Attachment[] {
  return (list ?? [])
    .filter((a) => a?.id)
    .map((a) => ({
      id: String(a.id),
      contentType: a.contentType || 'application/octet-stream',
      filename: a.filename ?? null,
      size: a.size ?? null,
      width: a.width ?? null,
      height: a.height ?? null,
      voiceNote: !!a.isVoiceNote,
      caption: a.caption ?? null,
    }));
}

function conversationFor(dm: Json, peer: Address): ConversationRow {
  const gid: string | undefined = dm?.groupInfo?.groupId;
  if (gid) return getOrCreateGroup(gid, dm.groupInfo.groupName);
  return getOrCreateDirect(peer.uuid, peer.number);
}

function applyReaction(conv: ConversationRow, r: Json, reactor: string) {
  const target = findMessage(conv.id, r.targetSentTimestamp);
  if (!target) return;
  let reactions: Reaction[] = target.reactions ? JSON.parse(target.reactions) : [];
  reactions = reactions.filter((x) => x.author !== reactor);
  if (!r.isRemove) reactions.push({ emoji: r.emoji, author: reactor });
  emitMessage(updateMessage(target.id, { reactions: reactions.length ? JSON.stringify(reactions) : null }));
}

function applyDelete(conv: ConversationRow, targetTs: number, deleter: string) {
  const target = findMessage(conv.id, targetTs);
  if (!target || (target.author !== deleter && deleter !== 'admin')) return;
  emitMessage(updateMessage(target.id, { deleted: 1, body: null, attachments: null, reactions: null }));
  emitConversation(conv);
}

function applyEdit(conv: ConversationRow, edit: Json) {
  const target = findMessage(conv.id, edit.targetSentTimestamp);
  if (!target) return;
  const dm = edit.dataMessage ?? {};
  emitMessage(updateMessage(target.id, { body: resolveMentions(dm.message, dm.mentions), edited: 1 }));
  emitConversation(conv);
}

/** A data message — either received (author = sender) or one we sent from another device (sync). */
function handleDataMessage(dm: Json, author: Address, peer: Address, outgoing: boolean) {
  const conv = conversationFor(dm, peer);
  const authorKey = outgoing ? 'self' : contactKey(author.uuid, author.number);

  if (dm.groupInfo?.type === 'UPDATE') ingestHooks.onGroupChanged();

  if (dm.reaction) return applyReaction(conv, dm.reaction, authorKey);
  if (dm.remoteDelete) return applyDelete(conv, dm.remoteDelete.targetTimestamp ?? dm.remoteDelete.timestamp, authorKey);
  if (dm.adminDelete) return applyDelete(conv, dm.adminDelete.targetSentTimestamp, 'admin');
  if (dm.editMessage) return applyEdit(conv, dm.editMessage);

  const attachments = mapAttachments(dm.attachments);
  let body = resolveMentions(dm.message, dm.mentions);
  let kind = 'message';
  if (dm.sticker) kind = 'sticker';
  if (dm.viewOnce) {
    body = 'View-once media — open it on your phone';
    attachments.length = 0;
    kind = 'system';
  }
  if (!body && !attachments.length && kind === 'message') {
    if (dm.isExpirationUpdate) {
      const s = dm.expiresInSeconds ?? 0;
      body = s ? `Disappearing messages set to ${humanDuration(s)}` : 'Disappearing messages turned off';
      kind = 'system';
    } else if (dm.pollCreate) {
      body = `📊 Poll: ${dm.pollCreate.question}`;
    } else {
      return; // profile key updates, group updates, typing-only payloads, etc.
    }
  }

  const quote = dm.quote
    ? {
        sentTs: dm.quote.id,
        author: contactKey(dm.quote.authorUuid, dm.quote.authorNumber ?? dm.quote.author),
        text: resolveMentions(dm.quote.text, dm.quote.mentions) ?? (dm.quote.attachments?.length ? 'Attachment' : ''),
      }
    : null;

  const row = insertMessage({
    conversationId: conv.id,
    sentTs: dm.timestamp,
    author: authorKey,
    authorNumber: outgoing ? self.number : author.number,
    outgoing,
    kind,
    body,
    attachments,
    quote,
    status: outgoing ? 'sent' : null,
    read: outgoing,
  });
  if (!row) return; // duplicate delivery
  emitMessage(row);
  emitConversation(conv);

  for (const a of attachments) {
    fetchAttachment(a.id).then((ok) => {
      if (!ok) ingestHooks.log(`could not fetch attachment ${a.id}`);
    });
  }
}

function humanDuration(s: number) {
  if (s % 604800 === 0) return `${s / 604800} week${s === 604800 ? '' : 's'}`;
  if (s % 86400 === 0) return `${s / 86400} day${s === 86400 ? '' : 's'}`;
  if (s % 3600 === 0) return `${s / 3600} hour${s === 3600 ? '' : 's'}`;
  if (s % 60 === 0) return `${s / 60} minute${s === 60 ? '' : 's'}`;
  return `${s} seconds`;
}

function handleReceipt(rm: Json) {
  const status = rm.isRead ? 'read' : rm.isViewed ? 'viewed' : rm.isDelivery ? 'delivered' : null;
  if (!status) return;
  for (const ts of rm.timestamps ?? []) {
    const rows = db.prepare<[number], MessageRow>('SELECT * FROM messages WHERE outgoing = 1 AND sent_ts = ?').all(ts);
    for (const m of rows) {
      if ((STATUS_RANK[m.status ?? 'sent'] ?? 1) < STATUS_RANK[status]) {
        emitMessage(updateMessage(m.id, { status: status === 'viewed' ? 'read' : status }));
      }
    }
  }
}

/** You read messages on another device → mark them read here too. */
function handleReadSync(list: Json[]) {
  const touched = new Set<number>();
  for (const r of list) {
    const key = contactKey(r.senderUuid, r.senderNumber ?? r.sender);
    const m = db
      .prepare<[number, string], MessageRow>('SELECT * FROM messages WHERE sent_ts = ? AND author = ? LIMIT 1')
      .get(r.timestamp, key);
    if (m && markConversationRead(m.conversation_id, m.sent_ts) > 0) touched.add(m.conversation_id);
  }
  for (const id of touched) {
    const conv = db.prepare<[number], ConversationRow>('SELECT * FROM conversations WHERE id = ?').get(id);
    if (conv) emitConversation(conv);
  }
}

function handleTyping(tm: Json, src: Address) {
  const conv = tm.groupId ? getOrCreateGroup(tm.groupId) : getOrCreateDirect(src.uuid, src.number);
  const author = contactKey(src.uuid, src.number);
  broadcast({
    type: 'typing',
    conversationId: conv.id,
    author,
    authorName: nameForKey(author),
    started: tm.action === 'STARTED',
  });
}

export function handleEnvelope(payload: Json) {
  const e = payload?.envelope;
  if (!e) return;
  const src: Address = {
    uuid: e.sourceUuid ?? null,
    number: e.sourceNumber ?? (typeof e.source === 'string' && e.source.startsWith('+') ? e.source : null),
  };
  const fromSelf = self.is(src.uuid, src.number) || (!!e.syncMessage && src.number === self.number);
  if (fromSelf && src.uuid && !self.uuid) self.uuid = src.uuid;
  if (!fromSelf && (src.uuid || src.number)) {
    upsertContact({ uuid: src.uuid, number: src.number, envelope_name: e.sourceName || null });
  }

  try {
    if (e.dataMessage) handleDataMessage(e.dataMessage, src, src, fromSelf);
    if (e.editMessage) {
      const dm = e.editMessage.dataMessage ?? {};
      applyEdit(conversationFor(dm, src), e.editMessage);
    }
    if (e.syncMessage) {
      const sm = e.syncMessage;
      if (sm.sentMessage) {
        const sent = sm.sentMessage;
        const dest: Address = { uuid: sent.destinationUuid ?? null, number: sent.destinationNumber ?? sent.destination ?? null };
        if (!sent.groupInfo && !dest.uuid && !dest.number) {
          dest.uuid = self.uuid;
          dest.number = self.number; // note to self
        }
        if (sent.editMessage) applyEdit(conversationFor(sent.editMessage.dataMessage ?? sent, dest), sent.editMessage);
        else handleDataMessage(sent, src, dest, true);
      }
      if (sm.readMessages?.length) handleReadSync(sm.readMessages);
      if (sm.blockedNumbers || sm.blockedGroupIds || sm.type === 'CONTACTS_SYNC' || sm.type === 'GROUPS_SYNC') {
        ingestHooks.onGroupChanged();
      }
    }
    if (e.receiptMessage) handleReceipt(e.receiptMessage);
    if (e.typingMessage && !fromSelf) handleTyping(e.typingMessage, src);
  } catch (err) {
    ingestHooks.log('failed to process envelope', err);
  }
}
