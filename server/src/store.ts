/** Data access + the JSON shapes sent to the browser. */
import { db, kvGet, kvSet } from './db.js';
import { groupRecipientId } from './signal-api.js';
import { cachedManifest, stickerUrl } from './stickers.js';

export interface StickerRef {
  packId: string;
  stickerId: number;
}

function stickerEmoji(s: StickerRef): string | null {
  return cachedManifest(s.packId)?.stickers.find((x) => x.id === s.stickerId)?.emoji ?? null;
}

// ---------- types ----------

export interface ContactRow {
  key: string;
  uuid: string | null;
  number: string | null;
  name: string | null;
  profile_name: string | null;
  envelope_name: string | null;
  username: string | null;
  blocked: number;
  updated_at: number | null;
  about: string | null;
  has_avatar: number;
}

export interface ConversationRow {
  id: number;
  kind: 'direct' | 'group';
  peer_uuid: string | null;
  peer_number: string | null;
  group_id: string | null;
  group_name: string | null;
  group_members: string | null;
  group_description: string | null;
  group_admins: string | null;
  last_message_at: number | null;
  archived: number;
  created_at: number;
}

export interface Attachment {
  id: string;
  contentType: string;
  filename?: string | null;
  size?: number | null;
  width?: number | null;
  height?: number | null;
  voiceNote?: boolean;
  caption?: string | null;
  gif?: boolean; // silent looping video (Signal's GIFs)
}

export interface Quote {
  sentTs: number;
  author: string;
  text?: string | null;
}

export interface Reaction {
  emoji: string;
  author: string;
}

export interface MessageRow {
  id: number;
  conversation_id: number;
  sent_ts: number;
  author: string;
  author_number: string | null;
  outgoing: number;
  kind: string;
  body: string | null;
  attachments: string | null;
  quote: string | null;
  reactions: string | null;
  status: string | null;
  error: string | null;
  read: number;
  edited: number;
  deleted: number;
  received_at: number;
  sticker: string | null;
  ts_confirmed: number;
}

// ---------- self ----------

export const self = {
  get number(): string | undefined {
    return kvGet('self_number');
  },
  set number(v: string | undefined) {
    if (v) kvSet('self_number', v);
  },
  get uuid(): string | undefined {
    return kvGet('self_uuid');
  },
  set uuid(v: string | undefined) {
    if (v) kvSet('self_uuid', v);
  },
  is(uuid?: string | null, number?: string | null): boolean {
    return (!!uuid && uuid === this.uuid) || (!!number && number === this.number);
  },
};

// ---------- contacts ----------

const contactByUuid = db.prepare<[string], ContactRow>('SELECT * FROM contacts WHERE uuid = ?');
const contactByNumber = db.prepare<[string], ContactRow>('SELECT * FROM contacts WHERE number = ?');
const contactByKey = db.prepare<[string], ContactRow>('SELECT * FROM contacts WHERE key = ?');

export function contactKey(uuid?: string | null, number?: string | null): string {
  if (self.is(uuid, number)) return 'self';
  return uuid || number || 'unknown';
}

export function findContact(uuid?: string | null, number?: string | null): ContactRow | undefined {
  return (uuid ? contactByUuid.get(uuid) : undefined) ?? (number ? contactByNumber.get(number) : undefined);
}

export function upsertContact(c: {
  uuid?: string | null;
  number?: string | null;
  name?: string | null;
  profile_name?: string | null;
  envelope_name?: string | null;
  username?: string | null;
  blocked?: boolean;
  about?: string | null;
  has_avatar?: boolean;
}) {
  if (!c.uuid && !c.number) return;
  if (self.is(c.uuid, c.number)) return;
  const tx = db.transaction(() => {
    const byUuid = c.uuid ? contactByUuid.get(c.uuid) : undefined;
    const byNumber = c.number ? contactByNumber.get(c.number) : undefined;
    let existing = byUuid ?? byNumber;
    // We first knew this person by number only; now we learned their uuid → re-key.
    if (byNumber && c.uuid && !byUuid && byNumber.key !== c.uuid) {
      db.prepare('UPDATE contacts SET key = ?, uuid = ? WHERE key = ?').run(c.uuid, c.uuid, byNumber.key);
      db.prepare('UPDATE messages SET author = ? WHERE author = ?').run(c.uuid, byNumber.key);
      existing = contactByKey.get(c.uuid);
    }
    const key = existing?.key ?? (c.uuid || c.number)!;
    const merged = {
      key,
      uuid: c.uuid ?? existing?.uuid ?? null,
      number: c.number ?? existing?.number ?? null,
      name: c.name !== undefined ? c.name || null : existing?.name ?? null,
      profile_name: c.profile_name !== undefined ? c.profile_name || null : existing?.profile_name ?? null,
      envelope_name: c.envelope_name || existing?.envelope_name || null,
      username: c.username !== undefined ? c.username || null : existing?.username ?? null,
      blocked: c.blocked !== undefined ? (c.blocked ? 1 : 0) : existing?.blocked ?? 0,
      about: c.about !== undefined ? c.about || null : existing?.about ?? null,
      has_avatar: c.has_avatar !== undefined ? (c.has_avatar ? 1 : 0) : existing?.has_avatar ?? 0,
      updated_at: Date.now(),
    };
    db.prepare(
      `INSERT INTO contacts (key, uuid, number, name, profile_name, envelope_name, username, blocked, about, has_avatar, updated_at)
       VALUES (@key, @uuid, @number, @name, @profile_name, @envelope_name, @username, @blocked, @about, @has_avatar, @updated_at)
       ON CONFLICT(key) DO UPDATE SET uuid=@uuid, number=@number, name=@name, profile_name=@profile_name,
         envelope_name=@envelope_name, username=@username, blocked=@blocked, about=@about, has_avatar=@has_avatar,
         updated_at=@updated_at`,
    ).run(merged);
  });
  tx();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Best display name. Never shows a raw Signal UUID: people we know nothing about are "Unknown". */
export function contactName(c: ContactRow | undefined, fallback?: string | null): string {
  const name = c && (c.name || c.profile_name || c.envelope_name || c.number || (c.username ? '@' + c.username : null));
  if (name) return name;
  if (fallback && !UUID_RE.test(fallback)) return fallback;
  return 'Unknown';
}

export function contactByKeyOrId(key: string): ContactRow | undefined {
  return contactByKey.get(key) ?? findContact(key, key);
}

export function avatarUrlForKey(key: string): string | null {
  const c = contactByKeyOrId(key);
  return c?.has_avatar && (c.uuid || c.number) ? `/api/avatars/contact/${encodeURIComponent(c.key)}` : null;
}

export function nameForKey(key: string): string {
  if (key === 'self') return 'You';
  const c = contactByKey.get(key) ?? findContact(key, key);
  return contactName(c, key);
}

export function numberForKey(key: string): string | undefined {
  if (key === 'self') return self.number;
  const c = contactByKey.get(key) ?? findContact(key, key);
  return c?.number ?? undefined;
}

/** The identifier to hand signal-cli when addressing this person (number preferred, uuid otherwise). */
export function addressForKey(key: string): string {
  if (key === 'self') return self.number!;
  const c = contactByKey.get(key);
  return c?.number || c?.uuid || key;
}

export function listContacts() {
  const rows = db.prepare<[], ContactRow>('SELECT * FROM contacts WHERE blocked = 0').all();
  return rows
    .map((c) => ({ key: c.key, uuid: c.uuid, number: c.number, name: contactName(c), username: c.username }))
    .filter((c) => c.name !== 'Unknown')
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- conversations ----------

const convById = db.prepare<[number], ConversationRow>('SELECT * FROM conversations WHERE id = ?');
const convByGroup = db.prepare<[string], ConversationRow>('SELECT * FROM conversations WHERE group_id = ?');

export function getConversation(id: number) {
  return convById.get(id);
}

export function getOrCreateDirect(uuid?: string | null, number?: string | null): ConversationRow {
  let conv =
    (uuid ? db.prepare<[string], ConversationRow>("SELECT * FROM conversations WHERE kind='direct' AND peer_uuid = ?").get(uuid) : undefined) ??
    (number ? db.prepare<[string], ConversationRow>("SELECT * FROM conversations WHERE kind='direct' AND peer_number = ?").get(number) : undefined);
  if (conv) {
    if ((uuid && !conv.peer_uuid) || (number && !conv.peer_number)) {
      db.prepare('UPDATE conversations SET peer_uuid = COALESCE(peer_uuid, ?), peer_number = COALESCE(peer_number, ?) WHERE id = ?').run(
        uuid ?? null,
        number ?? null,
        conv.id,
      );
      conv = convById.get(conv.id)!;
    }
    return conv;
  }
  const info = db
    .prepare("INSERT INTO conversations (kind, peer_uuid, peer_number, created_at) VALUES ('direct', ?, ?, ?)")
    .run(uuid ?? null, number ?? null, Date.now());
  return convById.get(Number(info.lastInsertRowid))!;
}

export function getOrCreateGroup(
  groupId: string,
  name?: string | null,
  members?: string[],
  details?: { description?: string | null; admins?: string[] },
): ConversationRow {
  const conv = convByGroup.get(groupId);
  if (conv) {
    if ((name && name !== conv.group_name) || members || details) {
      db.prepare(
        `UPDATE conversations SET group_name = COALESCE(?, group_name), group_members = COALESCE(?, group_members),
           group_description = CASE WHEN ? THEN ? ELSE group_description END, group_admins = COALESCE(?, group_admins)
         WHERE id = ?`,
      ).run(
        name || null,
        members ? JSON.stringify(members) : null,
        details && details.description !== undefined ? 1 : 0,
        details?.description || null,
        details?.admins ? JSON.stringify(details.admins) : null,
        conv.id,
      );
      return convById.get(conv.id)!;
    }
    return conv;
  }
  const info = db
    .prepare(
      "INSERT INTO conversations (kind, group_id, group_name, group_members, group_description, group_admins, created_at) VALUES ('group', ?, ?, ?, ?, ?, ?)",
    )
    .run(
      groupId,
      name || null,
      members ? JSON.stringify(members) : null,
      details?.description || null,
      details?.admins ? JSON.stringify(details.admins) : null,
      Date.now(),
    );
  return convById.get(Number(info.lastInsertRowid))!;
}

export function touchConversation(id: number, ts: number) {
  db.prepare('UPDATE conversations SET last_message_at = MAX(COALESCE(last_message_at, 0), ?), archived = 0 WHERE id = ?').run(ts, id);
}

export function recipientFor(conv: ConversationRow): string {
  if (conv.kind === 'group') return groupRecipientId(conv.group_id!);
  return conv.peer_number || conv.peer_uuid!;
}

export function conversationTitle(conv: ConversationRow): string {
  if (conv.kind === 'group') return conv.group_name || 'Unnamed group';
  if (self.is(conv.peer_uuid, conv.peer_number)) return 'Note to Self';
  return contactName(findContact(conv.peer_uuid, conv.peer_number), conv.peer_number || conv.peer_uuid);
}

const lastMessageStmt = db.prepare<[number], MessageRow>(
  'SELECT * FROM messages WHERE conversation_id = ? ORDER BY sent_ts DESC LIMIT 1',
);
const unreadStmt = db.prepare<[number], { n: number }>('SELECT count(*) AS n FROM messages WHERE conversation_id = ? AND read = 0');

const MENTION_RE = /@(\+[1-9]\d{6,14}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

/** Show "@Kevin Nijmeijer" for mentions stored as "@<uuid>" or "@<phone number>". */
export function renderMentions(text: string | null | undefined): string | null {
  if (!text) return text ?? null;
  return text.replace(MENTION_RE, (match, id: string) => {
    if (self.is(id, id)) return '@You';
    const c = findContact(id, id);
    const name = contactName(c, id.startsWith('+') ? id : null);
    return name === 'Unknown' ? match : '@' + name;
  });
}

export function previewText(m: MessageRow): string {
  if (m.deleted) return 'This message was deleted';
  if (m.kind === 'sticker') {
    const s: StickerRef | null = m.sticker ? JSON.parse(m.sticker) : null;
    return [s && stickerEmoji(s), 'Sticker'].filter(Boolean).join(' ');
  }
  if (m.body) return renderMentions(m.body)!;
  const atts: Attachment[] = m.attachments ? JSON.parse(m.attachments) : [];
  if (atts.length) {
    const a = atts[0];
    if (a.voiceNote) return '🎤 Voice message';
    if (a.gif || a.contentType === 'image/gif') return 'GIF';
    if (a.contentType.startsWith('image/')) return atts.length > 1 ? `📷 ${atts.length} photos` : '📷 Photo';
    if (a.contentType.startsWith('video/')) return '🎥 Video';
    if (a.contentType.startsWith('audio/')) return '🎵 Audio';
    return '📄 ' + (a.filename || 'File');
  }
  return '';
}

export function conversationDto(row: ConversationRow) {
  const conv = convById.get(row.id) ?? row; // always use the current row, callers may hold a stale one
  const last = lastMessageStmt.get(conv.id);
  const members = conv.kind === 'group' ? groupMembers(conv).map((m) => ({ key: m.key, name: m.name })) : undefined;
  const peer = conv.kind === 'direct' ? findContact(conv.peer_uuid, conv.peer_number) : undefined;
  return {
    id: conv.id,
    kind: conv.kind,
    title: conversationTitle(conv),
    number: conv.kind === 'direct' ? conv.peer_number : null,
    username: peer?.username ?? null,
    avatar: conversationAvatarUrl(conv, peer),
    members,
    lastMessageAt: conv.last_message_at,
    lastMessage: last
      ? {
          text: previewText(last),
          outgoing: !!last.outgoing,
          status: last.status,
          authorName: conv.kind === 'group' && !last.outgoing ? nameForKey(last.author) : null,
        }
      : null,
    unread: unreadStmt.get(conv.id)!.n,
    archived: !!conv.archived,
  };
}
export type ConversationDto = ReturnType<typeof conversationDto>;

function conversationAvatarUrl(conv: ConversationRow, peer?: ContactRow): string | null {
  if (conv.kind === 'group') return `/api/avatars/conversation/${conv.id}`; // 404s (and is cached) when the group has none
  return peer?.has_avatar ? `/api/avatars/conversation/${conv.id}` : null;
}

export interface GroupMember {
  key: string;
  name: string;
  number: string | null;
  username: string | null;
  about: string | null;
  admin: boolean;
  avatar: string | null;
}

/** Group members: "You" first, then admins, then everyone else alphabetically; unknown people last. */
export function groupMembers(conv: ConversationRow): GroupMember[] {
  if (!conv.group_members) return [];
  const ids: string[] = JSON.parse(conv.group_members);
  const admins = new Set<string>(conv.group_admins ? JSON.parse(conv.group_admins) : []);
  const seen = new Set<string>();
  const list: GroupMember[] = [];
  for (const id of ids) {
    const isSelf = self.is(id, id);
    const c = isSelf ? undefined : findContact(id, id);
    const key = isSelf ? 'self' : c?.key ?? id;
    if (seen.has(key)) continue;
    seen.add(key);
    const adminIds = [id, c?.uuid, c?.number].filter(Boolean) as string[];
    list.push({
      key,
      name: isSelf ? 'You' : contactName(c, id),
      number: isSelf ? self.number ?? null : c?.number ?? (id.startsWith('+') ? id : null),
      username: c?.username ?? null,
      about: c?.about ?? null,
      admin: adminIds.some((x) => admins.has(x)) || (isSelf && [self.number, self.uuid].some((x) => x && admins.has(x))),
      avatar: isSelf ? null : avatarUrlForKey(key),
    });
  }
  const rank = (m: GroupMember) => (m.key === 'self' ? 0 : m.name === 'Unknown' ? 3 : m.admin ? 1 : 2);
  return list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** Everything the info panel shows about a chat. */
export function conversationInfo(conv: ConversationRow) {
  const base = conversationDto(conv);
  const peer = conv.kind === 'direct' ? findContact(conv.peer_uuid, conv.peer_number) : undefined;
  const rows = db
    .prepare<[number], MessageRow>(
      `SELECT * FROM messages WHERE conversation_id = ? AND deleted = 0 AND (attachments IS NOT NULL OR body LIKE '%http%')
       ORDER BY sent_ts DESC LIMIT 500`,
    )
    .all(conv.id);
  const media: { messageId: number; sentAt: number; authorName: string; attachment: Attachment }[] = [];
  const files: typeof media = [];
  const links: { messageId: number; sentAt: number; authorName: string; url: string }[] = [];
  for (const m of rows) {
    const authorName = nameForKey(m.author);
    for (const a of (m.attachments ? JSON.parse(m.attachments) : []) as Attachment[]) {
      const entry = { messageId: m.id, sentAt: m.sent_ts, authorName, attachment: a };
      if (a.contentType.startsWith('image/') || a.contentType.startsWith('video/')) media.push(entry);
      else if (!a.voiceNote) files.push(entry);
    }
    for (const url of m.body?.match(/https?:\/\/[^\s<]+[^\s<.,:;"')\]!?]/g) ?? []) {
      links.push({ messageId: m.id, sentAt: m.sent_ts, authorName, url });
    }
  }
  const members = conv.kind === 'group' ? groupMembers(conv) : undefined;
  return {
    ...base,
    description: conv.kind === 'group' ? conv.group_description : null,
    about: peer?.about ?? null,
    members,
    memberCount: members?.length ?? 0,
    media: media.slice(0, 60),
    files: files.slice(0, 50),
    links: links.slice(0, 50),
  };
}

// ---------- receipts ----------

const STATUS_RANK: Record<string, number> = { failed: -1, pending: 0, sent: 1, delivered: 2, read: 3 };

export function statusRank(s: string | null) {
  return STATUS_RANK[s ?? 'sent'] ?? 1;
}

/** Record a delivery or read receipt from one recipient; returns the message's new overall status. */
export function recordReceipt(m: MessageRow, recipient: string, kind: 'delivered' | 'read', when: number): string {
  db.prepare(
    `INSERT INTO message_receipts (message_id, recipient, delivered_at, read_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(message_id, recipient) DO UPDATE SET
       delivered_at = COALESCE(delivered_at, excluded.delivered_at),
       read_at = COALESCE(read_at, excluded.read_at)`,
  ).run(m.id, recipient, when, kind === 'read' ? when : null);
  const counts = db
    .prepare<[number], { delivered: number; read: number }>(
      `SELECT count(*) AS delivered, count(read_at) AS read FROM message_receipts WHERE message_id = ?`,
    )
    .get(m.id)!;
  // Like Signal's own apps: the highest status any recipient reached (Message info has the details).
  const status = counts.read > 0 ? 'read' : counts.delivered > 0 ? 'delivered' : 'sent';
  return statusRank(status) > statusRank(m.status) ? status : m.status ?? 'sent';
}

/** Per-recipient delivery state of an outgoing message, for the "message info" view. */
export function messageReceipts(m: MessageRow) {
  const conv = convById.get(m.conversation_id)!;
  const rows = db
    .prepare<[number], { recipient: string; delivered_at: number | null; read_at: number | null }>(
      'SELECT recipient, delivered_at, read_at FROM message_receipts WHERE message_id = ?',
    )
    .all(m.id);
  const byKey = new Map(rows.map((r) => [r.recipient, r]));
  const people: { key: string; name: string }[] =
    conv.kind === 'group'
      ? groupMembers(conv).filter((x) => x.key !== 'self')
      : [{ key: contactKey(conv.peer_uuid, conv.peer_number), name: conversationTitle(conv) }];
  for (const r of rows) if (!people.some((p) => p.key === r.recipient)) people.push({ key: r.recipient, name: nameForKey(r.recipient) });
  return people.map((p) => {
    const r = byKey.get(p.key);
    return { key: p.key, name: p.name, avatar: avatarUrlForKey(p.key), deliveredAt: r?.delivered_at ?? null, readAt: r?.read_at ?? null };
  });
}

export function listConversationRows() {
  return db
    .prepare<[], ConversationRow>('SELECT * FROM conversations WHERE last_message_at IS NOT NULL ORDER BY last_message_at DESC')
    .all();
}

export function listConversations() {
  return listConversationRows().map(conversationDto);
}

/** Groups we're a member of, for the "new chat" picker. */
export function listGroups() {
  return db
    .prepare<[], ConversationRow>("SELECT * FROM conversations WHERE kind = 'group' ORDER BY group_name COLLATE NOCASE")
    .all()
    .map((c) => ({ id: c.id, title: conversationTitle(c) }));
}

// ---------- messages ----------

const msgById = db.prepare<[number], MessageRow>('SELECT * FROM messages WHERE id = ?');
const msgByTs = db.prepare<[number, number], MessageRow>('SELECT * FROM messages WHERE conversation_id = ? AND sent_ts = ? LIMIT 1');

export function getMessage(id: number) {
  return msgById.get(id);
}
export function findMessage(conversationId: number, sentTs: number) {
  return msgByTs.get(conversationId, sentTs) ?? repairOwnTimestamp(sentTs, conversationId);
}

/**
 * Something (a receipt, reaction, quote) refers to one of our messages by its real Signal timestamp,
 * but we only have a provisional one, taken a moment *before* signal-cli assigned the real one. Pick
 * the closest unconfirmed outgoing message from up to 20 s earlier and adopt the real timestamp.
 */
export function repairOwnTimestamp(realTs: number, conversationId?: number): MessageRow | undefined {
  const m = db
    .prepare<[number, number, number, number], MessageRow>(
      `SELECT * FROM messages WHERE outgoing = 1 AND ts_confirmed = 0 AND sent_ts <= ? AND sent_ts >= ?
         AND (? = 0 OR conversation_id = ?)
       ORDER BY sent_ts DESC LIMIT 1`,
    )
    .get(realTs, realTs - 20_000, conversationId ?? 0, conversationId ?? 0);
  if (!m) return undefined;
  const taken = db.prepare<[number, number, string], { id: number }>('SELECT id FROM messages WHERE conversation_id = ? AND sent_ts = ? AND author = ?').get(m.conversation_id, realTs, m.author);
  if (taken) return undefined;
  db.prepare('UPDATE messages SET sent_ts = ?, ts_confirmed = 1 WHERE id = ?').run(realTs, m.id);
  return msgById.get(m.id);
}

export function insertMessage(m: {
  conversationId: number;
  sentTs: number;
  author: string;
  authorNumber?: string | null;
  outgoing: boolean;
  kind?: string;
  body?: string | null;
  attachments?: Attachment[];
  quote?: Quote | null;
  status?: string | null;
  read: boolean;
  sticker?: StickerRef | null;
}): MessageRow | undefined {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO messages
        (conversation_id, sent_ts, author, author_number, outgoing, kind, body, attachments, quote, status, read, received_at, sticker, ts_confirmed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      m.conversationId,
      m.sentTs,
      m.author,
      m.authorNumber ?? null,
      m.outgoing ? 1 : 0,
      m.kind ?? 'message',
      m.body ?? null,
      m.attachments?.length ? JSON.stringify(m.attachments) : null,
      m.quote ? JSON.stringify(m.quote) : null,
      m.status ?? null,
      m.read ? 1 : 0,
      Date.now(),
      m.sticker ? JSON.stringify(m.sticker) : null,
      m.status === 'pending' ? 0 : 1, // our own sends get their real timestamp once signal-cli answers
    );
  if (info.changes === 0) return undefined; // duplicate
  touchConversation(m.conversationId, m.sentTs);
  return msgById.get(Number(info.lastInsertRowid));
}

export function updateMessage(
  id: number,
  fields: Partial<Pick<MessageRow, 'body' | 'status' | 'error' | 'read' | 'edited' | 'deleted' | 'reactions' | 'attachments' | 'sent_ts' | 'ts_confirmed'>>,
) {
  const keys = Object.keys(fields);
  if (!keys.length) return msgById.get(id);
  db.prepare(`UPDATE messages SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id });
  return msgById.get(id);
}

// Monotonic snapshot revision. The same message can reach the browser over HTTP and over the
// event stream in either order; the client keeps whichever copy has the higher rev.
let revCounter = 0;
function nextRev() {
  revCounter = (revCounter + 1) % 1000;
  return Date.now() * 1000 + revCounter;
}

export function messageDto(m: MessageRow) {
  const quote: Quote | null = m.quote ? JSON.parse(m.quote) : null;
  const reactions: Reaction[] = m.reactions ? JSON.parse(m.reactions) : [];
  const sticker: StickerRef | null = m.sticker && !m.deleted ? JSON.parse(m.sticker) : null;
  return {
    id: m.id,
    rev: nextRev(),
    sticker: sticker ? { ...sticker, emoji: stickerEmoji(sticker), url: stickerUrl(sticker.packId, sticker.stickerId) } : null,
    conversationId: m.conversation_id,
    sentAt: m.sent_ts,
    author: m.author,
    authorName: nameForKey(m.author),
    outgoing: !!m.outgoing,
    kind: m.kind,
    body: m.deleted ? null : renderMentions(m.body),
    attachments: m.deleted ? [] : ((m.attachments ? JSON.parse(m.attachments) : []) as Attachment[]),
    quote: quote && !m.deleted ? { sentAt: quote.sentTs, author: quote.author, authorName: nameForKey(quote.author), text: renderMentions(quote.text) ?? '' } : null,
    reactions: reactions.map((r) => ({ emoji: r.emoji, author: r.author, authorName: nameForKey(r.author) })),
    status: m.status === 'viewed' ? 'read' : m.status,
    error: m.error,
    read: !!m.read,
    edited: !!m.edited,
    deleted: !!m.deleted,
  };
}
export type MessageDto = ReturnType<typeof messageDto>;

export function listMessages(conversationId: number, before: number | undefined, limit: number) {
  const rows = db
    .prepare<[number, number, number], MessageRow>(
      'SELECT * FROM messages WHERE conversation_id = ? AND sent_ts < ? ORDER BY sent_ts DESC LIMIT ?',
    )
    .all(conversationId, before ?? Number.MAX_SAFE_INTEGER, limit);
  return rows.reverse().map(messageDto);
}

export function unreadMessages(conversationId: number) {
  return db.prepare<[number], MessageRow>('SELECT * FROM messages WHERE conversation_id = ? AND read = 0 ORDER BY sent_ts').all(conversationId);
}

export function markConversationRead(conversationId: number, upToTs = Number.MAX_SAFE_INTEGER) {
  return db.prepare('UPDATE messages SET read = 1 WHERE conversation_id = ? AND read = 0 AND sent_ts <= ?').run(conversationId, upToTs).changes;
}
