/** Data access + the JSON shapes sent to the browser. */
import { db, kvGet, kvSet } from './db.js';
import { groupRecipientId } from './signal-api.js';

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
}

export interface ConversationRow {
  id: number;
  kind: 'direct' | 'group';
  peer_uuid: string | null;
  peer_number: string | null;
  group_id: string | null;
  group_name: string | null;
  group_members: string | null;
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
      updated_at: Date.now(),
    };
    db.prepare(
      `INSERT INTO contacts (key, uuid, number, name, profile_name, envelope_name, username, blocked, updated_at)
       VALUES (@key, @uuid, @number, @name, @profile_name, @envelope_name, @username, @blocked, @updated_at)
       ON CONFLICT(key) DO UPDATE SET uuid=@uuid, number=@number, name=@name, profile_name=@profile_name,
         envelope_name=@envelope_name, username=@username, blocked=@blocked, updated_at=@updated_at`,
    ).run(merged);
  });
  tx();
}

export function contactName(c: ContactRow | undefined, fallback?: string | null): string {
  if (!c) return fallback || 'Unknown';
  return c.name || c.profile_name || c.envelope_name || c.number || (c.username ? '@' + c.username : null) || fallback || 'Unknown';
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

export function getOrCreateGroup(groupId: string, name?: string | null, members?: string[]): ConversationRow {
  const conv = convByGroup.get(groupId);
  if (conv) {
    if ((name && name !== conv.group_name) || members) {
      db.prepare('UPDATE conversations SET group_name = COALESCE(?, group_name), group_members = COALESCE(?, group_members) WHERE id = ?').run(
        name || null,
        members ? JSON.stringify(members) : null,
        conv.id,
      );
      return convById.get(conv.id)!;
    }
    return conv;
  }
  const info = db
    .prepare("INSERT INTO conversations (kind, group_id, group_name, group_members, created_at) VALUES ('group', ?, ?, ?, ?)")
    .run(groupId, name || null, members ? JSON.stringify(members) : null, Date.now());
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

export function previewText(m: MessageRow): string {
  if (m.deleted) return 'This message was deleted';
  if (m.kind === 'sticker') return 'Sticker';
  if (m.body) return m.body;
  const atts: Attachment[] = m.attachments ? JSON.parse(m.attachments) : [];
  if (atts.length) {
    const a = atts[0];
    if (a.voiceNote) return '🎤 Voice message';
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
  let members: { key: string; name: string }[] | undefined;
  if (conv.kind === 'group' && conv.group_members) {
    const ids: string[] = JSON.parse(conv.group_members);
    members = ids.map((id) => {
      const c = findContact(id, id);
      const key = self.is(id, id) ? 'self' : c?.key ?? id;
      return { key, name: key === 'self' ? 'You' : contactName(c, id) };
    });
  }
  const peer = conv.kind === 'direct' ? findContact(conv.peer_uuid, conv.peer_number) : undefined;
  return {
    id: conv.id,
    kind: conv.kind,
    title: conversationTitle(conv),
    number: conv.kind === 'direct' ? conv.peer_number : null,
    username: peer?.username ?? null,
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

export function listConversations() {
  const rows = db
    .prepare<[], ConversationRow>('SELECT * FROM conversations WHERE last_message_at IS NOT NULL ORDER BY last_message_at DESC')
    .all();
  return rows.map(conversationDto);
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
  return msgByTs.get(conversationId, sentTs);
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
}): MessageRow | undefined {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO messages
        (conversation_id, sent_ts, author, author_number, outgoing, kind, body, attachments, quote, status, read, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );
  if (info.changes === 0) return undefined; // duplicate
  touchConversation(m.conversationId, m.sentTs);
  return msgById.get(Number(info.lastInsertRowid));
}

export function updateMessage(id: number, fields: Partial<Pick<MessageRow, 'body' | 'status' | 'error' | 'read' | 'edited' | 'deleted' | 'reactions' | 'attachments' | 'sent_ts'>>) {
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
  return {
    id: m.id,
    rev: nextRev(),
    conversationId: m.conversation_id,
    sentAt: m.sent_ts,
    author: m.author,
    authorName: nameForKey(m.author),
    outgoing: !!m.outgoing,
    kind: m.kind,
    body: m.deleted ? null : m.body,
    attachments: m.deleted ? [] : ((m.attachments ? JSON.parse(m.attachments) : []) as Attachment[]),
    quote: quote && !m.deleted ? { sentAt: quote.sentTs, author: quote.author, authorName: nameForKey(quote.author), text: quote.text ?? '' } : null,
    reactions: reactions.map((r) => ({ emoji: r.emoji, author: r.author, authorName: nameForKey(r.author) })),
    status: m.status,
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
