/**
 * Turns signal-cli receive envelopes into stored messages and live events.
 * Envelope schema: see the "receive.*" definitions in signal-cli-rest-api's swagger.json.
 */
import { fetchAttachment, isSilentVideo } from './attachments.js';
import { fillMessageSizes } from './mediasize.js';
import { getManifest, getStickerImage } from './stickers.js';
import { broadcast } from './events.js';
import {
  type Attachment,
  type ConversationRow,
  type Reaction,
  contactKey,
  findMessageAt,
  findQuotedElsewhere,
  contactByKeyOrId,
  freeTimestamp,
  conversationDto,
  findMessage,
  getMessage,
  getOrCreateDirect,
  getOrCreateGroup,
  insertMessage,
  markConversationRead,
  messageDto,
  nameForKey,
  recordReceipt,
  repairOwnTimestamp,
  self,
  updateMessage,
  deleteMessageContent,
  upsertContact,
} from './store.js';
import { db } from './db.js';
import type { LinkPreview, MessageRow, Poll } from './store.js';
import { setConversationTimer } from './store.js';
import { type Ranges, cleanRanges } from './richtext.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export const ingestHooks = {
  /** Called when a group changed (name, members) so the caller can refresh group info. */
  onGroupChanged: () => {},
  log: (_msg: string, _err?: unknown) => {},
  debug: (_msg: string) => {},
};

interface Address {
  uuid?: string | null;
  number?: string | null;
}

function emitMessage(m: MessageRow | undefined) {
  if (m) broadcast({ type: 'message', message: messageDto(m) });
}
function emitConversation(conv: ConversationRow) {
  broadcast({ type: 'conversation', conversation: conversationDto(conv) });
}

/**
 * Replace the U+FFFC placeholders Signal uses for @mentions with "@<uuid or number>". The name is
 * filled in when the message is shown (renderMentions), so it is right even for people whose name
 * we only learn later. (signal-cli's mention "name" field holds the phone number, not a name.)
 */
function resolveMentions(text: string | undefined | null, mentions: Json[] | undefined): string | null {
  if (!text) return text ?? null;
  if (!mentions?.length) return text;
  const sorted = [...mentions].sort((a, b) => (b.start ?? 0) - (a.start ?? 0));
  let out = text;
  for (const m of sorted) {
    const id = m.uuid || m.number || m.name || 'unknown';
    if (m.uuid || m.number) upsertContact({ uuid: m.uuid || null, number: m.number || null });
    out = out.slice(0, m.start) + '@' + id + out.slice(m.start + (m.length || 1));
  }
  return out;
}

/**
 * Signal's own format: the body keeps a U+FFFC where each mention goes, and mentions and styles are
 * ranges over it. Names are filled in when the message is shown.
 */
function richFromSignal(text: string | null | undefined, mentions: Json[] | undefined, textStyles: Json[] | undefined): { body: string | null; ranges: Ranges | null } {
  if (!text) return { body: text ?? null, ranges: null };
  const ms = (mentions ?? []).map((m) => {
    if (m.uuid || m.number) upsertContact({ uuid: m.uuid || null, number: m.number || null });
    return { start: m.start, length: m.length || 1, key: contactKey(m.uuid || null, m.number || null) };
  }).filter((m) => m.key !== 'unknown');
  const styles = (textStyles ?? []).map((t) => ({ start: t.start, length: t.length, style: t.style }));
  return { body: text, ranges: cleanRanges(text, { mentions: ms, styles }) };
}

function mapPreview(list: Json[] | undefined): LinkPreview | null {
  const p = list?.find((x) => typeof x?.url === 'string' && /^https?:\/\//i.test(x.url));
  if (!p) return null;
  const [image] = p.image ? mapAttachments([p.image]) : [];
  return { url: p.url, title: p.title || null, description: p.description || null, image: image ?? null };
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
  // A change's new name is left to the refresh that follows, which writes "… changed the group name".
  if (gid) return getOrCreateGroup(gid, dm.groupInfo.type === 'UPDATE' ? null : dm.groupInfo.groupName);
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

/** Someone voted (or changed their vote). Signal keeps the vote with the highest count per person. */
function applyPollVote(conv: ConversationRow, v: Json, voter: string) {
  const target = findMessage(conv.id, v.targetSentTimestamp);
  if (!target?.poll) return;
  const poll: Poll = JSON.parse(target.poll);
  const prev = poll.votes[voter];
  const count = Number(v.voteCount) || 0;
  if (prev && count && prev.count > count) return; // an older vote arriving late
  const options = (Array.isArray(v.optionIndexes) ? v.optionIndexes : []).map(Number).filter((i: number) => Number.isInteger(i) && i >= 0 && i < poll.options.length);
  poll.votes[voter] = { options: [...new Set<number>(options)], count };
  emitMessage(updateMessage(target.id, { poll: JSON.stringify(poll) }));
}

function applyPollClose(conv: ConversationRow, targetTs: number, closer: string) {
  const target = findMessage(conv.id, targetTs);
  if (!target?.poll || target.author !== closer) return;
  const poll: Poll = JSON.parse(target.poll);
  poll.closed = true;
  emitMessage(updateMessage(target.id, { poll: JSON.stringify(poll) }));
}

function applyDelete(conv: ConversationRow, targetTs: number, deleter: string) {
  const target = findMessage(conv.id, targetTs);
  if (!target || (target.author !== deleter && deleter !== 'admin')) return;
  // Someone else's deletion is kept (click it to see); when you delete your own (from your phone), it's gone.
  emitMessage(deleteMessageContent(target.id, target.outgoing ? false : 'deleted'));
  emitConversation(conv);
}

function applyEdit(conv: ConversationRow, edit: Json) {
  const target = findMessage(conv.id, edit.targetSentTimestamp);
  if (!target) return;
  const dm = edit.dataMessage ?? {};
  const rich = richFromSignal(dm.message, dm.mentions, dm.textStyles);
  const preview = mapPreview(dm.previews);
  emitMessage(
    updateMessage(target.id, {
      body: rich.body,
      ranges: rich.ranges ? JSON.stringify(rich.ranges) : null,
      preview: preview ? JSON.stringify(preview) : null,
      edited: 1,
    }),
  );
  if (preview?.image) fetchAttachment(preview.image.id).catch(() => {});
  emitConversation(conv);
}

// ---------- Signal group changes ----------
/*
 * Signal only says "this group changed" (an UPDATE message from whoever changed it), not what changed.
 * So who sent it is remembered here, the group is fetched again (signal.ts), and the lines ("Luke added
 * Jan", "Jan left", "Luke changed the group name to …") come from comparing before and after.
 */
const groupActors = new Map<string, { author: string; ts: number; at: number }>();

/** Changes made here (adding members, renaming …): "You …". */
export function noteOwnGroupChange(groupId: string) {
  groupActors.set(groupId, { author: 'self', ts: Date.now(), at: Date.now() });
}

export interface SignalGroupState {
  members: string[] | null;
  admins: string[] | null;
  name: string | null;
  description: string | null;
}

function nameList(names: string[]) {
  return names.length <= 1 ? names[0] ?? 'Someone' : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

export function noteSignalGroupChanges(conv: ConversationRow, before: SignalGroupState, after: SignalGroupState) {
  if (!before.members || !after.members) return; // first time we see this group: nothing to compare with
  const act = groupActors.get(conv.group_id ?? '');
  const actor = act && Date.now() - act.at < 10 * 60_000 ? act : undefined;
  if (act) groupActors.delete(conv.group_id ?? '');
  const keyOf = (id: string) => (self.is(id, id) ? 'self' : contactByKeyOrId(id)?.key ?? id);
  const nameOf = (id: string) => (self.is(id, id) ? 'You' : nameForKey(id));
  const actorKey = actor ? (actor.author === 'self' ? 'self' : contactByKeyOrId(actor.author)?.key ?? actor.author) : undefined;
  const isActor = (id: string) => !!actorKey && keyOf(id) === actorKey;
  const A = actorKey ? nameForKey(actorKey) : null;
  const quote = (s: string) => `“${s}”`;
  const had = new Set(before.members.map(keyOf));
  const has = new Set(after.members.map(keyOf));
  const added = after.members.filter((m) => !had.has(keyOf(m)));
  const removed = before.members.filter((m) => !has.has(keyOf(m)));
  const lines: string[] = [];
  const joinedSelf = added.filter(isActor);
  const addedByOther = added.filter((m) => !isActor(m));
  if (joinedSelf.length) lines.push(`${nameList(joinedSelf.map(nameOf))} joined using this group's invite link`);
  if (addedByOther.length) lines.push(A ? `${A} added ${nameList(addedByOther.map(nameOf))}` : `${nameList(addedByOther.map(nameOf))} joined`);
  const left = removed.filter(isActor);
  const removedByOther = removed.filter((m) => !isActor(m));
  if (left.length) lines.push(`${nameList(left.map(nameOf))} left`);
  if (removedByOther.length) lines.push(A ? `${A} removed ${nameList(removedByOther.map(nameOf))}` : `${nameList(removedByOther.map(nameOf))} left`);
  if (after.name && before.name && after.name !== before.name) lines.push(A ? `${A} changed the group name to ${quote(after.name)}` : `The group name was changed to ${quote(after.name)}`);
  if ((after.description ?? '') !== (before.description ?? '') && before.description !== null) lines.push(A ? `${A} changed the group description` : 'The group description was changed');
  if (before.admins && after.admins) {
    const wasAdmin = new Set(before.admins.map(keyOf));
    const isAdmin = new Set(after.admins.map(keyOf));
    const promoted = after.admins.filter((m) => !wasAdmin.has(keyOf(m)) && had.has(keyOf(m)));
    const demoted = before.admins.filter((m) => !isAdmin.has(keyOf(m)) && has.has(keyOf(m)));
    const adminLine = (ids: string[], now: boolean) => {
      if (ids.some((m) => self.is(m, m)) && ids.length === 1) return now ? "You're now an admin" : "You're no longer an admin";
      const many = ids.length > 1;
      return `${nameList(ids.map(nameOf))} ${now ? (many ? 'are now admins' : 'is now an admin') : many ? 'are no longer admins' : 'is no longer an admin'}`;
    };
    if (promoted.length) lines.push(adminLine(promoted, true));
    if (demoted.length) lines.push(adminLine(demoted, false));
  }
  const author = actorKey ?? 'unknown';
  for (const body of lines) {
    const row = insertMessage({
      conversationId: conv.id,
      sentTs: freeTimestamp(conv.id, actor?.ts ?? Date.now(), author),
      author,
      outgoing: false, // a system line, even when you did it (no ticks)
      kind: 'system',
      body,
      read: true,
    });
    emitMessage(row);
  }
  if (lines.length) emitConversation(conv);
}

/** A data message — either received (author = sender) or one we sent from another device (sync). */
function handleDataMessage(dm: Json, author: Address, peer: Address, outgoing: boolean) {
  const conv = conversationFor(dm, peer);
  const authorKey = outgoing ? 'self' : contactKey(author.uuid, author.number);

  if (dm.groupInfo?.type === 'UPDATE') {
    if (dm.groupInfo.groupId) groupActors.set(dm.groupInfo.groupId, { author: authorKey, ts: Number(dm.timestamp) || Date.now(), at: Date.now() });
    ingestHooks.onGroupChanged();
  }

  if (dm.reaction) return applyReaction(conv, dm.reaction, authorKey);
  if (dm.remoteDelete) return applyDelete(conv, dm.remoteDelete.targetTimestamp ?? dm.remoteDelete.timestamp, authorKey);
  if (dm.adminDelete) return applyDelete(conv, dm.adminDelete.targetSentTimestamp, 'admin');
  if (dm.editMessage) return applyEdit(conv, dm.editMessage);
  if (dm.pollVote) return applyPollVote(conv, dm.pollVote, authorKey);
  if (dm.pollTerminate) return applyPollClose(conv, dm.pollTerminate.targetSentTimestamp, authorKey);

  const attachments = mapAttachments(dm.attachments);
  const rich = richFromSignal(dm.message, dm.mentions, dm.textStyles);
  let body = rich.body;
  let ranges = rich.ranges;
  const preview = mapPreview(dm.previews);
  let kind = 'message';

  // Disappearing messages: every message carries the chat's current timer.
  const expiresIn = Math.max(0, Number(dm.expiresInSeconds) || 0);
  const timerChanged = expiresIn !== (conv.expire_timer || 0);
  const who = outgoing ? 'You' : nameForKey(authorKey);
  if (dm.isExpirationUpdate || (dm.groupInfo?.type === 'UPDATE' && timerChanged)) {
    setConversationTimer(conv.id, expiresIn);
    if (!body && !attachments.length && !dm.sticker) {
      body = expiresIn ? `${who} set disappearing messages to ${humanDuration(expiresIn)}` : `${who} turned off disappearing messages`;
      ranges = null;
      kind = 'system';
    }
  } else if (timerChanged && (body || attachments.length || dm.sticker)) {
    setConversationTimer(conv.id, expiresIn);
  }
  let sticker: { packId: string; stickerId: number } | null = null;
  if (dm.sticker?.packId && Number.isInteger(dm.sticker.stickerId)) {
    kind = 'sticker';
    sticker = { packId: String(dm.sticker.packId).toLowerCase(), stickerId: dm.sticker.stickerId };
    attachments.length = 0; // signal-cli may also list the sticker image as an attachment
  } else if (dm.sticker) kind = 'sticker';
  if (dm.viewOnce) {
    body = 'View-once media — open it on your phone';
    attachments.length = 0;
    kind = 'system';
  }
  let poll: Poll | null = null;
  if (dm.pollCreate?.question && Array.isArray(dm.pollCreate.options)) {
    kind = 'poll';
    body = String(dm.pollCreate.question);
    ranges = null;
    poll = { question: body, options: dm.pollCreate.options.map(String), multiple: !!dm.pollCreate.allowMultiple, votes: {} };
  }
  if (!body && !attachments.length && kind === 'message') return; // profile key updates, group updates, typing-only payloads, etc.

  let quote: { sentTs: number; author: string; text: string; chat?: number } | null = dm.quote
    ? {
        sentTs: dm.quote.id,
        author: contactKey(dm.quote.authorUuid, dm.quote.authorNumber ?? dm.quote.author),
        text: resolveMentions(dm.quote.text, dm.quote.mentions) ?? (dm.quote.attachments?.length ? 'Attachment' : ''),
      }
    : null;
  // A reply in a one-to-one chat quoting a message that's not in it: a private reply to a group message.
  if (quote && conv.kind !== 'group' && !findMessageAt(conv.id, quote.sentTs)) {
    const elsewhere = findQuotedElsewhere(conv.id, quote.sentTs, quote.author);
    if (elsewhere) quote = { ...quote, chat: elsewhere.conversation_id };
  }

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
    sticker,
    ranges: kind === 'system' ? null : ranges,
    poll,
    preview,
    expiresIn: kind === 'system' ? 0 : expiresIn,
    // Your own messages start counting down when sent; received ones once you've read them.
    expiresAt: kind !== 'system' && expiresIn && outgoing ? dm.timestamp + expiresIn * 1000 : null,
  });
  if (!row) return; // duplicate delivery
  if (preview?.image) fetchAttachment(preview.image.id).then((ok) => ok && emitMessage(getMessage(row.id)));
  if (sticker && self.number) {
    // Fetch the pack now so the sticker (and its emoji) is ready when someone opens the chat.
    const s = sticker;
    const account = self.number;
    getManifest(account, s.packId)
      .then(() => getStickerImage(account, s.packId, s.stickerId))
      .then(() => {
        emitMessage(getMessage(row.id));
        emitConversation(conv);
      })
      .catch((e) => ingestHooks.log(`sticker ${s.packId}/${s.stickerId}`, e));
  }
  emitMessage(row);
  emitConversation(conv);

  for (const a of attachments) {
    fetchAttachment(a.id).then((ok) => {
      if (!ok) return ingestHooks.log(`could not fetch attachment ${a.id}`);
      if (a.contentType.startsWith('video/')) markGifVideos(row.id);
      void fillMessageSizes(row.id); // when Signal didn't say how big a photo or video is
    });
  }
}

/**
 * signal-cli doesn't pass on Signal's "this is a GIF" flag. GIFs arrive as short MP4s without a
 * sound track, while recorded videos always have one, so that's what we check.
 */
/** Once at startup: flag GIF videos that arrived before this check existed. */
export function backfillGifFlags() {
  const rows = db
    .prepare<[], { id: number }>(`SELECT id FROM messages WHERE attachments LIKE '%"video/%' AND attachments NOT LIKE '%"gif":%'`)
    .all();
  for (const r of rows) markGifVideos(r.id);
}

export function markGifVideos(messageId: number) {
  const m = getMessage(messageId);
  if (!m?.attachments) return;
  const atts: Attachment[] = JSON.parse(m.attachments);
  let changed = false;
  for (const a of atts) {
    if (a.contentType.startsWith('video/') && a.gif === undefined) {
      const gif = isSilentVideo(a.id);
      if (gif === null) continue; // not downloaded yet
      a.gif = gif;
      changed = true;
    }
  }
  if (changed) emitMessage(updateMessage(m.id, { attachments: JSON.stringify(atts) }));
}

export function humanDuration(s: number) {
  if (s % 604800 === 0) return `${s / 604800} week${s === 604800 ? '' : 's'}`;
  if (s % 86400 === 0) return `${s / 86400} day${s === 86400 ? '' : 's'}`;
  if (s % 3600 === 0) return `${s / 3600} hour${s === 3600 ? '' : 's'}`;
  if (s % 60 === 0) return `${s / 60} minute${s === 60 ? '' : 's'}`;
  return `${s} seconds`;
}

interface PendingReceipt {
  recipient: string;
  kind: 'delivered' | 'read';
  when: number;
  expires: number;
}

/**
 * Receipts for messages we can't match yet. When we send, the message is stored with a provisional
 * timestamp and only gets its real Signal timestamp once signal-cli's send call returns. For a big
 * group that call takes seconds, and the first recipients' delivery receipts arrive before it ends.
 * Those are parked here and applied by applyPendingReceipts() once the real timestamp is known.
 */
const pendingReceipts = new Map<number, PendingReceipt[]>();

function applyReceipt(m: MessageRow, recipient: string, kind: 'delivered' | 'read', when: number) {
  const status = recordReceipt(m, recipient, kind, when);
  if (status !== m.status) emitMessage(updateMessage(m.id, { status }));
  else broadcast({ type: 'receipt', messageId: m.id });
}

function handleReceipt(rm: Json, src: Address) {
  const kind = rm.isRead || rm.isViewed ? 'read' : rm.isDelivery ? 'delivered' : null;
  if (!kind) return;
  const recipient = contactKey(src.uuid, src.number);
  if (recipient === 'self') return;
  const when = Number(rm.when) || Date.now();
  for (const ts of rm.timestamps ?? []) {
    let rows = db.prepare<[number], MessageRow>('SELECT * FROM messages WHERE outgoing = 1 AND sent_ts = ?').all(ts);
    if (!rows.length) {
      const repaired = repairOwnTimestamp(ts);
      if (repaired) {
        ingestHooks.debug(`receipt for ${ts}: matched message ${repaired.id} by closeness and fixed its timestamp`);
        emitMessage(repaired);
        rows = [repaired];
      }
    }
    if (!rows.length) {
      ingestHooks.debug(`receipt ${kind} from ${recipient} for unknown timestamp ${ts} (kept for 10 min)`);
      const list = pendingReceipts.get(ts) ?? [];
      list.push({ recipient, kind, when, expires: Date.now() + 10 * 60_000 });
      pendingReceipts.set(ts, list);
      continue;
    }
    for (const m of rows) applyReceipt(m, recipient, kind, when);
  }
  ingestHooks.debug(`receipt ${kind} from ${recipient} for ${(rm.timestamps ?? []).join(',')}`);
}

/** Call after an outgoing message got its final Signal timestamp. */
export function applyPendingReceipts(messageId: number) {
  const m = getMessage(messageId);
  if (!m) return;
  const list = pendingReceipts.get(m.sent_ts);
  if (!list) return;
  pendingReceipts.delete(m.sent_ts);
  for (const r of list) {
    const current = getMessage(messageId)!;
    applyReceipt(current, r.recipient, r.kind, r.when);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [ts, list] of pendingReceipts) {
    const kept = list.filter((r) => r.expires > now);
    if (kept.length) pendingReceipts.set(ts, kept);
    else pendingReceipts.delete(ts);
  }
}, 60_000).unref();

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

// ---------- calls ----------
// A linked device sees the caller's offer, and a hangup saying how it ended ("ACCEPTED" when you
// picked up on another device). Signal never says "missed": no answer within a minute counts as one.

const calls = new Map<string, { messageId: number; video: boolean; answered: boolean; timer: ReturnType<typeof setTimeout> }>();

function callLine(video: boolean, outcome: 'incoming' | 'missed' | 'answered' | 'declined') {
  const what = video ? 'video call' : 'voice call';
  const label = { incoming: `Incoming ${what}`, missed: `Missed ${what}`, answered: what[0].toUpperCase() + what.slice(1), declined: `Declined ${what}` }[outcome];
  return `${video ? '🎥' : '📞'} ${label}`;
}

function finishCall(id: string, outcome: 'missed' | 'answered' | 'declined') {
  const c = calls.get(id);
  if (!c) return;
  clearTimeout(c.timer);
  calls.delete(id);
  const m = getMessage(c.messageId);
  if (!m) return;
  emitMessage(updateMessage(m.id, { body: callLine(c.video, outcome), ...(outcome === 'answered' ? { read: 1 } : {}) }));
  const conv = db.prepare<[number], ConversationRow>('SELECT * FROM conversations WHERE id = ?').get(m.conversation_id);
  if (conv) emitConversation(conv);
}

function handleCall(cm: Json, src: Address, ts: number) {
  if (cm.offerMessage?.id !== undefined) {
    const id = String(cm.offerMessage.id);
    if (calls.has(id)) return;
    const conv = getOrCreateDirect(src.uuid, src.number);
    const video = /VIDEO/i.test(String(cm.offerMessage.type ?? ''));
    const row = insertMessage({
      conversationId: conv.id,
      sentTs: ts,
      author: contactKey(src.uuid, src.number),
      authorNumber: src.number,
      outgoing: false,
      kind: 'system',
      body: callLine(video, Date.now() - ts > 90_000 ? 'missed' : 'incoming'),
      read: false,
    });
    if (!row) return;
    emitMessage(row);
    emitConversation(conv);
    if (Date.now() - ts > 90_000) return; // an old offer, delivered late: it's over
    calls.set(id, { messageId: row.id, video, answered: false, timer: setTimeout(() => finishCall(id, 'missed'), 60_000) });
    return;
  }
  const hangup = cm.hangupMessage;
  if (hangup?.id !== undefined) {
    const id = String(hangup.id);
    const c = calls.get(id);
    if (!c) return;
    const type = String(hangup.type ?? '');
    if (type === 'ACCEPTED') {
      c.answered = true;
      clearTimeout(c.timer);
      c.timer = setTimeout(() => finishCall(id, 'answered'), 4 * 3600_000); // tidy up if the end never arrives
      const m = getMessage(c.messageId);
      if (m) emitMessage(updateMessage(m.id, { body: callLine(c.video, 'answered'), read: 1 }));
    } else if (type === 'DECLINED') finishCall(id, c.answered ? 'answered' : 'declined');
    else finishCall(id, c.answered ? 'answered' : 'missed');
    return;
  }
  if (cm.busyMessage?.id !== undefined) finishCall(String(cm.busyMessage.id), 'missed');
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
    if (e.receiptMessage) handleReceipt(e.receiptMessage, src);
    if (e.typingMessage && !fromSelf) handleTyping(e.typingMessage, src);
    if (e.callMessage && !fromSelf) handleCall(e.callMessage, src, Number(e.timestamp) || Date.now());
  } catch (err) {
    ingestHooks.log('failed to process envelope', err);
  }
}
