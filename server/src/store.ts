/** Data access + the JSON shapes sent to the browser. */
import { db, kvGet, kvSet } from './db.js';
import { groupRecipientId } from './signal-api.js';
import { avatarRev } from './avatars.js';
import { cachedManifest, stickerUrl } from './stickers.js';
import { type Ranges, type Rendered, plainText, renderRich } from './richtext.js';

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
  expire_timer: number;
  pinned_at: number | null;
  muted_until: number;
  network: 'signal' | 'whatsapp';
  wa_id: string | null;
}

export interface Poll {
  question: string;
  options: string[];
  multiple: boolean;
  closed?: boolean;
  votes: Record<string, { options: number[]; count: number }>; // by voter key
}

export interface LinkPreview {
  url: string;
  title?: string | null;
  description?: string | null;
  image?: Attachment | null;
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
  ranges: string | null;
  preview: string | null;
  expires_in: number;
  expires_at: number | null;
  poll: string | null;
  ext_id: string | null;
}

/** Hooks other modules plug into (avoids import cycles). */
export const storeHooks = {
  /** Disappearing-message timers started or changed: reschedule the sweeper. */
  timersChanged: () => {},
};

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
  /** Your own WhatsApp ids (phone-number id and lid). */
  get waIds(): string[] {
    return (kvGet('wa_me') ?? '').split(',').filter(Boolean);
  },
  set waIds(v: string[]) {
    kvSet('wa_me', v.filter(Boolean).join(','));
  },
  isWa(jid?: string | null): boolean {
    if (!jid) return false;
    const bare = jid.replace(/:\d+@/, '@').replace('@s.whatsapp.net', '@c.us');
    return this.waIds.includes(bare);
  },
};

export interface SelfProfile {
  givenName: string;
  familyName: string;
  about: string;
  hasAvatar: boolean;
}

export function getSelfProfile(): SelfProfile | null {
  const v = kvGet('self_profile');
  return v ? (JSON.parse(v) as SelfProfile) : null;
}
export function setSelfProfile(p: SelfProfile) {
  kvSet('self_profile', JSON.stringify(p));
}

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

// ---------- WhatsApp people ----------

export interface WaContactRow {
  jid: string;
  number: string | null;
  name: string | null;
  push_name: string | null;
}

const waByJid = db.prepare<[string], WaContactRow>('SELECT * FROM wa_contacts WHERE jid = ?');

/** "31612345678@c.us" → "+31612345678"; lids and groups have no number. */
export function waNumberOf(jid: string): string | null {
  const m = /^(\d{6,15})@(c\.us|s\.whatsapp\.net)$/.exec(jid);
  return m ? '+' + m[1] : null;
}

export function upsertWaContact(c: { jid: string; name?: string | null; pushName?: string | null; number?: string | null }) {
  if (!c.jid || c.jid.endsWith('@g.us')) return;
  const cur = waByJid.get(c.jid);
  db.prepare(
    `INSERT INTO wa_contacts (jid, number, name, push_name, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(jid) DO UPDATE SET number = excluded.number, name = excluded.name, push_name = excluded.push_name, updated_at = excluded.updated_at`,
  ).run(
    c.jid,
    c.number ?? cur?.number ?? waNumberOf(c.jid),
    c.name !== undefined ? c.name || null : cur?.name ?? null,
    c.pushName !== undefined ? c.pushName || cur?.push_name || null : cur?.push_name ?? null,
    Date.now(),
  );
}

export function waContactName(jid: string): string {
  if (self.isWa(jid)) return 'You';
  const c = waByJid.get(jid);
  return c?.name || c?.push_name || c?.number || waNumberOf(jid) || 'Unknown';
}

export function waContact(jid: string) {
  return waByJid.get(jid);
}

export function avatarUrlForKey(key: string): string | null {
  if (key.startsWith('wa:')) return `/api/avatars/wa/${encodeURIComponent(key.slice(3))}`;
  const c = contactByKeyOrId(key);
  const id = c?.uuid || c?.number;
  return c?.has_avatar && id ? `/api/avatars/contact/${encodeURIComponent(c.key)}?v=${avatarRev('profile', id)}` : null;
}

export function nameForKey(key: string): string {
  if (key === 'self') return 'You';
  if (key.startsWith('wa:')) return waContactName(key.slice(3));
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
  // New messages bring an archived chat back, unless it's muted (like Signal).
  db.prepare(
    `UPDATE conversations SET last_message_at = MAX(COALESCE(last_message_at, 0), ?),
       archived = CASE WHEN muted_until > ? THEN archived ELSE 0 END WHERE id = ?`,
  ).run(ts, Date.now(), id);
}

export function setConversationFlags(id: number, f: { pinned?: boolean; archived?: boolean; mutedUntil?: number }) {
  if (f.pinned !== undefined) db.prepare('UPDATE conversations SET pinned_at = ? WHERE id = ?').run(f.pinned ? Date.now() : null, id);
  if (f.archived !== undefined) {
    db.prepare('UPDATE conversations SET archived = ? WHERE id = ?').run(f.archived ? 1 : 0, id);
    if (f.archived) db.prepare('UPDATE conversations SET pinned_at = NULL WHERE id = ?').run(id); // archiving unpins
  }
  if (f.mutedUntil !== undefined) db.prepare('UPDATE conversations SET muted_until = ? WHERE id = ?').run(Math.max(0, f.mutedUntil), id);
}

export function pinnedCount(): number {
  return db.prepare<[], { n: number }>('SELECT count(*) AS n FROM conversations WHERE pinned_at IS NOT NULL').get()!.n;
}

export function recipientFor(conv: ConversationRow): string {
  if (conv.network === 'whatsapp') return conv.wa_id!;
  if (conv.kind === 'group') return groupRecipientId(conv.group_id!);
  return conv.peer_number || conv.peer_uuid!;
}

export function conversationTitle(conv: ConversationRow): string {
  if (conv.network === 'whatsapp') {
    if (conv.kind === 'group') return conv.group_name || 'WhatsApp group';
    if (self.isWa(conv.wa_id)) return 'Message yourself';
    return waContactName(conv.wa_id!);
  }
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

function mentionName(key: string): string {
  if (key === 'self') return getSelfProfile()?.givenName || 'You';
  return nameForKey(key);
}

/** The text of a message with names for mentions, and its style/mention ranges to match. */
export function renderBody(body: string | null, rangesJson: string | null): Rendered | null {
  if (!body) return null;
  if (rangesJson) return renderRich(body, JSON.parse(rangesJson) as Ranges, mentionName);
  // Older rows have mentions inline as "@<uuid or number>".
  const mentions: { start: number; length: number; key: string }[] = [];
  for (const match of body.matchAll(MENTION_RE)) {
    const id = match[1];
    const key = self.is(id, id) ? 'self' : findContact(id, id)?.key;
    if (key && (key === 'self' || nameForKey(key) !== 'Unknown')) mentions.push({ start: match.index!, length: match[0].length, key });
  }
  return renderRich(body, mentions.length ? { mentions } : null, mentionName);
}

export function previewText(m: MessageRow): string {
  if (m.deleted) return 'This message was deleted';
  if (m.kind === 'poll' && m.poll) return '📊 ' + (JSON.parse(m.poll) as Poll).question;
  if (m.kind === 'sticker') {
    const s: StickerRef | null = m.sticker ? JSON.parse(m.sticker) : null;
    return [s && stickerEmoji(s), 'Sticker'].filter(Boolean).join(' ');
  }
  const r = renderBody(m.body, m.ranges);
  if (r?.text) return plainText(r);
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
    network: conv.network,
    title: conversationTitle(conv),
    number: conv.kind !== 'direct' ? null : conv.network === 'whatsapp' ? waContact(conv.wa_id!)?.number ?? waNumberOf(conv.wa_id!) : conv.peer_number,
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
    pinnedAt: conv.pinned_at ?? null,
    mutedUntil: conv.muted_until > Date.now() ? conv.muted_until : 0,
    expireTimer: conv.expire_timer || 0,
  };
}
export type ConversationDto = ReturnType<typeof conversationDto>;

function conversationAvatarUrl(conv: ConversationRow, peer?: ContactRow): string | null {
  if (conv.network === 'whatsapp') return `/api/avatars/wa/${encodeURIComponent(conv.wa_id!)}`;
  // Groups: always offered; it 404s (and that is cached) when the group has no picture.
  if (conv.kind === 'group') return `/api/avatars/conversation/${conv.id}?v=${avatarRev('group', groupRecipientId(conv.group_id!))}`;
  const id = conv.peer_uuid || conv.peer_number;
  return peer?.has_avatar && id ? `/api/avatars/conversation/${conv.id}?v=${avatarRev('profile', id)}` : null;
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
  if (conv.network === 'whatsapp') return waGroupMembers(conv);
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

function waGroupMembers(conv: ConversationRow): GroupMember[] {
  const keys: string[] = JSON.parse(conv.group_members!);
  const admins = new Set<string>(conv.group_admins ? JSON.parse(conv.group_admins) : []);
  const list = keys.map((key) => {
    const jid = key.slice(3);
    const isSelf = key === 'self';
    const c = isSelf ? undefined : waContact(jid);
    return {
      key,
      name: isSelf ? 'You' : waContactName(jid),
      number: isSelf ? null : c?.number ?? waNumberOf(jid),
      username: null,
      about: null,
      admin: admins.has(key),
      avatar: isSelf ? null : avatarUrlForKey(key),
    };
  });
  const rank = (m: GroupMember) => (m.key === 'self' ? 0 : m.name === 'Unknown' ? 3 : m.admin ? 1 : 2);
  return list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** WhatsApp people with a name, for the "new chat" picker. */
export function listWaContacts() {
  return db
    .prepare<[], WaContactRow>('SELECT * FROM wa_contacts WHERE name IS NOT NULL OR push_name IS NOT NULL')
    .all()
    .filter((c) => !self.isWa(c.jid))
    .map((c) => ({ jid: c.jid, name: c.name || c.push_name || c.number || 'Unknown', number: c.number ?? waNumberOf(c.jid) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A WhatsApp chat by its id, created on first sight. */
export function getOrCreateWaChat(jid: string, name?: string | null): ConversationRow {
  const group = jid.endsWith('@g.us');
  const existing = db.prepare<[string], ConversationRow>('SELECT * FROM conversations WHERE wa_id = ?').get(jid);
  if (existing) {
    if (group && name && name !== existing.group_name) {
      db.prepare('UPDATE conversations SET group_name = ? WHERE id = ?').run(name, existing.id);
      return convById.get(existing.id)!;
    }
    return existing;
  }
  const info = db
    .prepare("INSERT INTO conversations (kind, network, wa_id, group_name, created_at) VALUES (?, 'whatsapp', ?, ?, ?)")
    .run(group ? 'group' : 'direct', jid, group ? name || null : null, Date.now());
  return convById.get(Number(info.lastInsertRowid))!;
}

export function setWaGroupMembers(conversationId: number, members: string[], admins: string[]) {
  db.prepare('UPDATE conversations SET group_members = ?, group_admins = ? WHERE id = ?').run(JSON.stringify(members), JSON.stringify(admins), conversationId);
}

export function listWaGroups(): ConversationRow[] {
  return db.prepare<[], ConversationRow>("SELECT * FROM conversations WHERE network = 'whatsapp' AND kind = 'group'").all();
}

/** A WhatsApp message by id. Engines sometimes report only the last part ("ABCDEF") of "false_123@c.us_ABCDEF". */
export function findMessageByExt(id: string | null | undefined): MessageRow | undefined {
  if (!id) return undefined;
  const exact = db.prepare<[string], MessageRow>('SELECT * FROM messages WHERE ext_id = ?').get(id);
  if (exact) return exact;
  const raw = id.split('_').pop()!;
  if (!/^[A-Za-z0-9]{6,}$/.test(raw)) return undefined;
  return db.prepare<[string], MessageRow>("SELECT * FROM messages WHERE ext_id LIKE '%\\_' || ? ESCAPE '\\'").get(raw);
}

/** WhatsApp timestamps are whole seconds: nudge by a millisecond until (chat, time, author) is free. */
export function freeTimestamp(conversationId: number, ts: number, author: string): number {
  const taken = db.prepare<[number, number, string], { id: number }>('SELECT id FROM messages WHERE conversation_id = ? AND sent_ts = ? AND author = ?');
  let t = ts;
  while (taken.get(conversationId, t, author)) t++;
  return t;
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

/**
 * Overall tick status of an outgoing message, worked out from its receipts. Delivered as soon as anyone
 * has it (so inactive members don't keep a group message at one tick forever); read only once every
 * other current member has read it. Message info shows who exactly.
 */
export function receiptStatus(m: MessageRow): string {
  if (m.status === 'pending' || m.status === 'failed') return m.status;
  const rows = db
    .prepare<[number], { recipient: string; read_at: number | null }>('SELECT recipient, read_at FROM message_receipts WHERE message_id = ?')
    .all(m.id);
  if (!rows.length) return m.status === 'delivered' || m.status === 'read' ? m.status : 'sent'; // e.g. synced from the phone
  const readers = new Set(rows.filter((r) => r.read_at).map((r) => r.recipient));
  const conv = convById.get(m.conversation_id)!;
  let everyoneRead = readers.size > 0;
  if (conv.kind === 'group') {
    const others = groupMembers(conv).filter((x) => x.key !== 'self').map((x) => x.key);
    if (others.length) everyoneRead = others.every((k) => readers.has(k));
  }
  return everyoneRead ? 'read' : 'delivered';
}

/** One-off: group messages that were marked read when only one member had read them. */
export function recomputeGroupReadStatuses(): number {
  const rows = db
    .prepare<[], MessageRow>(
      `SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.kind = 'group' AND m.outgoing = 1 AND m.status = 'read'`,
    )
    .all();
  let changed = 0;
  for (const m of rows) {
    const status = receiptStatus(m);
    if (status !== m.status) {
      db.prepare('UPDATE messages SET status = ? WHERE id = ?').run(status, m.id);
      changed++;
    }
  }
  return changed;
}

/** Record a delivery or read receipt from one recipient; returns the message's new overall status. */
export function recordReceipt(m: MessageRow, recipient: string, kind: 'delivered' | 'read', when: number): string {
  db.prepare(
    `INSERT INTO message_receipts (message_id, recipient, delivered_at, read_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(message_id, recipient) DO UPDATE SET
       delivered_at = COALESCE(delivered_at, excluded.delivered_at),
       read_at = COALESCE(read_at, excluded.read_at)`,
  ).run(m.id, recipient, when, kind === 'read' ? when : null);
  return receiptStatus(m);
}

/** Per-recipient delivery state of an outgoing message, for the "message info" view. */
export function messageReceipts(m: MessageRow) {
  const conv = convById.get(m.conversation_id)!;
  if (conv.network === 'whatsapp') return []; // WhatsApp only reports the overall ticks
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
    .map((c) => ({ id: c.id, title: conversationTitle(c), network: c.network }));
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
  ranges?: Ranges | null;
  preview?: LinkPreview | null;
  expiresIn?: number;
  expiresAt?: number | null;
  poll?: Poll | null;
  extId?: string | null;
}): MessageRow | undefined {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO messages
        (conversation_id, sent_ts, author, author_number, outgoing, kind, body, attachments, quote, status, read, received_at, sticker, ts_confirmed,
         ranges, preview, expires_in, expires_at, poll, ext_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      m.ranges ? JSON.stringify(m.ranges) : null,
      m.preview ? JSON.stringify(m.preview) : null,
      m.expiresIn ?? 0,
      m.expiresAt ?? null,
      m.poll ? JSON.stringify(m.poll) : null,
      m.extId ?? null,
    );
  if (info.changes === 0) return undefined; // duplicate
  touchConversation(m.conversationId, m.sentTs);
  if (m.expiresAt) storeHooks.timersChanged();
  return msgById.get(Number(info.lastInsertRowid));
}

export function updateMessage(
  id: number,
  fields: Partial<Pick<MessageRow, 'body' | 'status' | 'error' | 'read' | 'edited' | 'deleted' | 'reactions' | 'attachments' | 'sent_ts' | 'ts_confirmed' | 'ranges' | 'preview' | 'expires_at' | 'poll' | 'ext_id'>>,
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
  const rich = m.deleted ? null : renderBody(m.body, m.ranges);
  const preview: LinkPreview | null = m.preview && !m.deleted ? JSON.parse(m.preview) : null;
  const poll: Poll | null = m.poll && !m.deleted ? JSON.parse(m.poll) : null;
  return {
    poll: poll ? pollDto(poll) : null,
    id: m.id,
    rev: nextRev(),
    sticker: sticker ? { ...sticker, emoji: stickerEmoji(sticker), url: stickerUrl(sticker.packId, sticker.stickerId) } : null,
    conversationId: m.conversation_id,
    sentAt: m.sent_ts,
    author: m.author,
    authorName: nameForKey(m.author),
    outgoing: !!m.outgoing,
    kind: m.kind,
    body: rich?.text ?? null,
    styles: rich?.styles.length ? rich.styles : undefined,
    mentions: rich?.mentions.length ? rich.mentions : undefined,
    preview,
    expiresIn: m.expires_in || undefined,
    expiresAt: m.expires_at ?? undefined,
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

function pollDto(p: Poll) {
  const voters: { key: string; name: string }[][] = p.options.map(() => []);
  for (const [key, v] of Object.entries(p.votes)) {
    for (const i of v.options) if (voters[i]) voters[i].push({ key, name: nameForKey(key) });
  }
  return {
    question: p.question,
    multiple: p.multiple,
    closed: !!p.closed,
    options: p.options.map((text, i) => ({ text, voters: voters[i] })),
    mine: p.votes.self?.options ?? [],
    totalVoters: Object.values(p.votes).filter((v) => v.options.length).length,
  };
}

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
  const now = Date.now();
  // Disappearing messages you received start their countdown once you've read them.
  const started = db
    .prepare(
      `UPDATE messages SET expires_at = ? + expires_in * 1000
       WHERE conversation_id = ? AND read = 0 AND sent_ts <= ? AND expires_in > 0 AND expires_at IS NULL`,
    )
    .run(now, conversationId, upToTs).changes;
  const changes = db.prepare('UPDATE messages SET read = 1 WHERE conversation_id = ? AND read = 0 AND sent_ts <= ?').run(conversationId, upToTs).changes;
  if (started) storeHooks.timersChanged();
  return changes;
}

export function setConversationTimer(conversationId: number, seconds: number) {
  db.prepare('UPDATE conversations SET expire_timer = ? WHERE id = ?').run(seconds, conversationId);
}

/** Messages around a moment (for jumping to a search result or a quoted message). */
export function listMessagesAround(conversationId: number, ts: number, limit: number) {
  const half = Math.floor(limit / 2);
  const older = db
    .prepare<[number, number, number], MessageRow>('SELECT * FROM messages WHERE conversation_id = ? AND sent_ts < ? ORDER BY sent_ts DESC LIMIT ?')
    .all(conversationId, ts, half + 1);
  const newer = db
    .prepare<[number, number, number], MessageRow>('SELECT * FROM messages WHERE conversation_id = ? AND sent_ts >= ? ORDER BY sent_ts ASC LIMIT ?')
    .all(conversationId, ts, half + 1);
  const hasOlder = older.length > half;
  const hasNewer = newer.length > half;
  const rows = [...older.slice(0, half).reverse(), ...newer.slice(0, half)];
  return { messages: rows.map(messageDto), hasOlder, hasNewer };
}

export function listMessagesAfter(conversationId: number, after: number, limit: number) {
  return db
    .prepare<[number, number, number], MessageRow>('SELECT * FROM messages WHERE conversation_id = ? AND sent_ts > ? ORDER BY sent_ts ASC LIMIT ?')
    .all(conversationId, after, limit)
    .map(messageDto);
}

/** Text search over messages, newest first. */
export function searchMessages(q: string, conversationId: number | undefined, limit = 50) {
  const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  const rows = db
    .prepare<[string, number, number, number], MessageRow>(
      `SELECT * FROM messages
       WHERE deleted = 0 AND kind IN ('message', 'poll') AND body LIKE ? ESCAPE '\\' AND (? = 0 OR conversation_id = ?)
       ORDER BY sent_ts DESC LIMIT ?`,
    )
    .all(like, conversationId ?? 0, conversationId ?? 0, limit);
  const needle = q.toLowerCase();
  return rows.map((m) => {
    const conv = convById.get(m.conversation_id)!;
    const text = plainText(renderBody(m.body, m.ranges)!);
    const at = text.toLowerCase().indexOf(needle);
    const from = Math.max(0, (at < 0 ? 0 : at) - 40);
    return {
      id: m.id,
      conversationId: m.conversation_id,
      conversationTitle: conversationTitle(conv),
      group: conv.kind === 'group',
      sentAt: m.sent_ts,
      authorName: nameForKey(m.author),
      outgoing: !!m.outgoing,
      snippet: (from > 0 ? '…' : '') + text.slice(from, from + 160),
    };
  });
}

export function expiredMessages(now: number) {
  return db.prepare<[number], MessageRow>('SELECT * FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?').all(now);
}

export function nextExpiry(): number | null {
  return db.prepare<[], { t: number | null }>('SELECT MIN(expires_at) AS t FROM messages WHERE expires_at IS NOT NULL').get()?.t ?? null;
}

export function deleteMessageRow(id: number) {
  db.prepare('DELETE FROM messages WHERE id = ?').run(id);
}
