/**
 * WhatsApp through WAHA: keeps the session linked and running, turns WAHA's websocket events into
 * stored messages, imports recent history once, and sends on behalf of the browser.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isSafeId, isSilentVideo, localPath } from './attachments.js';
import { config } from './config.js';
import { db, kvGet, kvSet } from './db.js';
import { broadcast } from './events.js';
import { type Ranges, parseWaMarkup, placeMentions, toWaText } from './richtext.js';
import {
  type Attachment,
  type ConversationRow,
  type LinkPreview,
  type MessageRow,
  type Poll,
  type Reaction,
  conversationDto,
  findMessageByExt,
  freeTimestamp,
  getConversation,
  getMessage,
  getOrCreateWaChat,
  insertMessage,
  listWaGroups,
  messageDto,
  nameForKey,
  self,
  setWaGroupMembers,
  statusRank,
  updateMessage,
  upsertWaContact,
  waContact,
} from './store.js';
import { type Json, type WaFile, waha } from './waha-api.js';

export type WaStatus = 'disabled' | 'unreachable' | 'starting' | 'scan_qr' | 'connected' | 'failed' | 'stopped';
export interface WaState {
  status: WaStatus;
  me?: string; // your number
  name?: string;
  engine?: string;
  version?: string;
  error?: string;
  importing?: boolean;
}

type Logger = { info: (m: string) => void; warn: (m: string) => void; debug?: (m: string) => void };
let log: Logger = console;
let state: WaState = { status: config.wahaUrl ? 'starting' : 'disabled' };
let ws: WebSocket | undefined;
let wsDelay = 1000;
let checkTimer: ReturnType<typeof setTimeout> | undefined;
let dirTimer: ReturnType<typeof setInterval> | undefined;
let stopped = false;

export function getWaState() {
  return state;
}

function setState(next: WaState) {
  const changed = JSON.stringify(next) !== JSON.stringify(state);
  const loggable = next.status !== state.status || next.me !== state.me || next.error !== state.error;
  state = next;
  if (changed) {
    if (loggable) log.info(`whatsapp: ${next.status}${next.me ? ' (' + next.me + ')' : ''}${next.error ? ' — ' + next.error : ''}`);
    broadcast({ type: 'wastate', state: next });
  }
}

function emitMessage(m: MessageRow | undefined) {
  if (m) broadcast({ type: 'message', message: messageDto(m) });
}
function emitConversation(id: number) {
  const c = getConversation(id);
  if (c) broadcast({ type: 'conversation', conversation: conversationDto(c) });
}

// ---------- ids ----------

const lidCache = new Map<string, string | null>();

/** Strip the device part and use one spelling: "316…:12@s.whatsapp.net" → "316…@c.us". */
function bare(jid: string): string {
  return jid.replace(/:\d+@/, '@').replace('@s.whatsapp.net', '@c.us');
}

/** Prefer phone-number ids over WhatsApp's privacy ids (@lid) when WAHA knows the number. */
async function resolve(jid: string | null | undefined): Promise<string | null> {
  if (!jid) return null;
  const j = bare(jid);
  if (!j.endsWith('@lid')) return j;
  if (lidCache.has(j)) return lidCache.get(j) ?? j;
  const stored = kvGet(`lid:${j}`);
  if (stored !== undefined) {
    lidCache.set(j, stored || null);
    return stored || j;
  }
  try {
    const r = await waha.lidToPhone(j);
    const pn = r?.pn ? bare(r.pn) : null;
    lidCache.set(j, pn);
    kvSet(`lid:${j}`, pn ?? '');
    return pn ?? j;
  } catch {
    lidCache.set(j, null); // try again after a restart
    return j;
  }
}

function keyFor(jid: string): string {
  return self.isWa(jid) ? 'self' : 'wa:' + jid;
}

function skipChat(jid: string) {
  return jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast');
}

// ---------- connection ----------

async function check() {
  clearTimeout(checkTimer);
  if (stopped || !config.wahaUrl) return;
  let next = 60_000;
  try {
    let s;
    try {
      s = await waha.session();
    } catch (e) {
      if ((e as { status?: number }).status === 404) {
        await waha.createSession();
        s = await waha.session();
      } else throw e;
    }
    const engine = s.engine?.engine;
    const base = { engine, version: state.version };
    if (!state.version) waha.version().then((v) => setState({ ...state, version: v.version, engine: state.engine ?? v.engine })).catch(() => {});
    switch (s.status) {
      case 'WORKING': {
        const me = s.me?.id ? bare(s.me.id) : undefined;
        if (me) self.waIds = [me, s.me?.lid ? bare(s.me.lid) : ''];
        const wasConnected = state.status === 'connected';
        setState({ ...base, status: 'connected', me: me ? me.split('@')[0].replace(/^/, '+') : undefined, name: s.me?.pushName, importing: state.importing });
        connectWs();
        if (!wasConnected) void afterConnect();
        break;
      }
      case 'SCAN_QR_CODE':
        setState({ ...base, status: 'scan_qr' });
        next = 3000;
        break;
      case 'STARTING':
        setState({ ...base, status: 'starting' });
        next = 3000;
        break;
      case 'STOPPED':
        setState({ ...base, status: 'starting' });
        await waha.startSession().catch(() => {});
        next = 3000;
        break;
      case 'FAILED':
        setState({ ...base, status: 'failed', error: 'WhatsApp session failed. Restart it, or link again.' });
        next = 15_000;
        break;
      default:
        setState({ ...base, status: 'starting', error: `WAHA session status ${s.status}` });
        next = 5000;
    }
  } catch (e) {
    const msg = (e as Error).message;
    const auth = /\b401\b|\b403\b/.test(msg);
    setState({ status: 'unreachable', error: auth ? 'WAHA refused the API key (check WAHA_API_KEY).' : `Can't reach WAHA at ${config.wahaUrl}: ${msg}` });
    next = 10_000;
  }
  checkTimer = setTimeout(check, next);
}

export function recheckWa(delay = 300) {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(check, delay);
}

function connectWs() {
  if (ws || stopped) return;
  const sock = new WebSocket(waha.wsUrl());
  ws = sock;
  sock.onopen = () => {
    wsDelay = 1000;
    log.info('whatsapp: listening for events');
  };
  sock.onmessage = (ev) => {
    let data: Json;
    try {
      data = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    queue = queue.then(() => handleEvent(data)).catch((e) => log.warn(`whatsapp: event ${data?.event} failed: ${(e as Error).message}`));
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = undefined;
    if (stopped) return;
    setTimeout(() => {
      if (state.status === 'connected') connectWs();
    }, wsDelay);
    wsDelay = Math.min(wsDelay * 2, 30_000);
  };
  sock.onerror = () => sock.close();
}

let queue: Promise<unknown> = Promise.resolve(); // handle events one at a time, in order

const HISTORY_KEY = 'wa_history_v2';
let historyTimers: ReturnType<typeof setTimeout>[] = [];

async function afterConnect() {
  await refreshDirectory().catch((e) => log.warn(`whatsapp: contacts: ${(e as Error).message}`));
  if (kvGet(HISTORY_KEY) === 'done') return;
  // Right after linking, the phone keeps sending WAHA older chats for several minutes. Import in a few
  // rounds; messages we already have are skipped, so later rounds only add what arrived since.
  const rounds = (process.env.WAHA_HISTORY_ROUNDS_MS ?? '').split(',').map(Number).filter((n) => n > 0);
  scheduleHistory(rounds.length ? rounds : [20_000, 3 * 60_000, 10 * 60_000]);
}

function scheduleHistory(delays: number[]) {
  historyTimers.forEach(clearTimeout);
  historyTimers = delays.map((d, i) =>
    setTimeout(async () => {
      if (state.status !== 'connected') return;
      await runHistoryImport();
      if (i === delays.length - 1) kvSet(HISTORY_KEY, 'done');
    }, d),
  );
}

let importing = false;
export async function runHistoryImport(): Promise<{ chats: number; messages: number }> {
  if (importing) return { chats: 0, messages: 0 };
  importing = true;
  setState({ ...state, importing: true });
  try {
    const r = await importHistory();
    log.info(`whatsapp: history import: ${r.messages} new messages from ${r.chats} chats`);
    await refreshDirectory().catch(() => {});
    return r;
  } catch (e) {
    const msg = (e as Error).message;
    log.warn(`whatsapp: history import failed: ${msg}${/store/i.test(msg) ? ' (NOWEB engine: enable the store in the session config, or use GOWS)' : ''}`);
    throw e;
  } finally {
    importing = false;
    setState({ ...state, importing: false });
  }
}

/** Import again now (button in Settings). */
export async function importHistoryNow() {
  requireWa();
  return runHistoryImport();
}

export function startWhatsApp(logger: Logger) {
  log = logger;
  if (!config.wahaUrl) return;
  stopped = false;
  void check();
  dirTimer = setInterval(() => state.status === 'connected' && refreshDirectory().catch(() => {}), 6 * 3600_000);
}

export function stopWhatsApp() {
  stopped = true;
  clearTimeout(checkTimer);
  clearInterval(dirTimer);
  ws?.close();
  ws = undefined;
}

export async function logoutWhatsApp() {
  await waha.logout();
  kvSet(HISTORY_KEY, '');
  historyTimers.forEach(clearTimeout);
  setState({ ...state, status: 'starting', me: undefined, name: undefined });
  recheckWa(1500);
}

export async function restartWhatsApp() {
  await waha.startSession().catch(() => {});
  recheckWa(1500);
}

// ---------- directory ----------

export async function refreshDirectory() {
  const list = await waha.contacts();
  for (const c of list ?? []) {
    const id = typeof c.id === 'string' ? c.id : c.id?._serialized;
    if (!id || id.endsWith('@g.us') || skipChat(id)) continue;
    const jid = bare(id);
    upsertWaContact({ jid, name: c.name ?? c.Name ?? null, pushName: c.pushname ?? c.pushName ?? c.PushName ?? null, number: c.number ? '+' + String(c.number).replace(/\D/g, '') : undefined });
  }
  await refreshGroupNames().catch((e) => log.warn(`whatsapp: group names: ${(e as Error).message}`));
  for (const g of listWaGroups()) {
    if (!g.group_name) await refreshGroupName(g).catch(() => {});
    await refreshGroup(g).catch(() => {});
  }
  for (const g of listWaGroups()) emitConversation(g.id);
}

const groupRefreshPending = new Map<string, ReturnType<typeof setTimeout>>();
function refreshGroupSoon(jid: string) {
  clearTimeout(groupRefreshPending.get(jid));
  groupRefreshPending.set(
    jid,
    setTimeout(() => {
      groupRefreshPending.delete(jid);
      const conv = getOrCreateWaChat(jid);
      refreshGroup(conv).then(() => emitConversation(conv.id)).catch(() => {});
    }, 2000),
  );
}

async function refreshGroup(conv: ConversationRow) {
  const parts = await waha.participants(conv.wa_id!);
  const members: string[] = [];
  const admins: string[] = [];
  for (const p of parts ?? []) {
    const id = typeof p.id === 'string' ? p.id : p.id?._serialized ?? p.JID;
    const jid = await resolve(id);
    if (!jid) continue;
    const key = keyFor(jid);
    members.push(key);
    if (p.role === 'admin' || p.role === 'superadmin' || p.isAdmin || p.IsAdmin) admins.push(key);
  }
  if (members.length) setWaGroupMembers(conv.id, members, admins);
}

// ---------- incoming ----------

const STATUS_FOR_ACK: Record<number, string> = { [-1]: 'failed', 0: 'pending', 1: 'sent', 2: 'delivered', 3: 'read', 4: 'read' };

function pushNameOf(m: Json): string | null {
  const d = m._data ?? {};
  return d.notifyName ?? d.pushName ?? d.Info?.PushName ?? null;
}

function pollOf(m: Json): Poll | null {
  const d = m._data ?? {};
  if (d.type === 'poll_creation' || d.pollName) {
    const options = (d.pollOptions ?? []).map((o: Json) => String(o.name ?? o));
    if (!options.length) return null;
    return { question: String(d.pollName ?? m.body ?? ''), options, multiple: (d.pollSelectableOptionsCount ?? 1) !== 1, votes: {} };
  }
  const msg = d.Message ?? d.message ?? {};
  const pc = msg.pollCreationMessage ?? msg.pollCreationMessageV2 ?? msg.pollCreationMessageV3 ?? msg.pollCreationMessageV5;
  if (!pc) return null;
  const options = (pc.options ?? []).map((o: Json) => String(o.optionName ?? ''));
  if (!options.length) return null;
  return { question: String(pc.name ?? m.body ?? ''), options, multiple: Number(pc.selectableOptionsCount ?? 0) !== 1, votes: {} };
}

function isVoiceNote(m: Json, mimetype: string) {
  const d = m._data ?? {};
  return d.type === 'ptt' || !!d.Message?.audioMessage?.PTT || !!d.message?.audioMessage?.ptt || /ogg.*opus/i.test(mimetype);
}

async function downloadMedia(m: Json, extId: string): Promise<Attachment | null> {
  let media = m.media;
  if (!media?.url && m.hasMedia) {
    try {
      const chatId = m.fromMe ? m.to : m.from;
      media = (await waha.message(chatId, m.id))?.media;
    } catch {
      /* not available */
    }
  }
  if (!media?.url) return null;
  const mimetype = String(media.mimetype ?? 'application/octet-stream').split(';')[0].trim() || 'application/octet-stream';
  const ext = path.extname(media.filename ?? '').replace(/[^A-Za-z0-9.]/g, '').slice(0, 10) || EXT[mimetype] || '';
  const id = 'wa-' + crypto.createHash('sha1').update(extId).digest('hex').slice(0, 24) + ext;
  const file = localPath(id);
  if (!fs.existsSync(file)) {
    const res = await waha.file(media.url);
    if (!res.ok || !res.body) return null;
    const tmp = file + '.part';
    await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(tmp));
    fs.renameSync(tmp, file);
  }
  const size = fs.statSync(file).size;
  const att: Attachment = { id, contentType: mimetype, filename: media.filename ?? null, size };
  if (mimetype.startsWith('audio/') && isVoiceNote(m, String(media.mimetype ?? ''))) att.voiceNote = true;
  if (mimetype.startsWith('video/')) {
    const silent = isSilentVideo(id);
    if (silent !== null) att.gif = silent || !!m._data?.isGif || !!m._data?.Message?.videoMessage?.gifPlayback;
  }
  return att;
}

const EXT: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'application/pdf': '.pdf',
};

/** WhatsApp text → stored body: formatting markers become styles, "@<number>" becomes a real mention. */
async function richFromWa(text: string | null | undefined, conv: ConversationRow): Promise<{ body: string | null; ranges: Ranges | null }> {
  if (!text) return { body: text ?? null, ranges: null };
  const { text: plain, styles } = parseWaMarkup(text);
  const found: { start: number; end: number; key: string }[] = [];
  const members = new Set<string>(conv.group_members ? JSON.parse(conv.group_members) : []);
  for (const m of plain.matchAll(/@(\d{6,20})\b/g)) {
    const digits = m[1];
    const candidates = [`${digits}@c.us`, `${digits}@lid`];
    let key: string | null = null;
    for (const c of candidates) {
      if (self.isWa(c)) key = 'self';
      else if (members.has('wa:' + c) || waContact(c)) key = 'wa:' + c;
      if (key) break;
    }
    if (!key && digits.length >= 15) {
      const pn = await resolve(`${digits}@lid`);
      if (pn && !pn.endsWith('@lid')) key = keyFor(pn);
    }
    if (!key && conv.kind === 'group') key = 'wa:' + candidates[0];
    if (key) found.push({ start: m.index!, end: m.index! + m[0].length, key });
  }
  if (!found.length) return { body: plain, ranges: styles.length ? { styles } : null };
  return placeMentions(plain, styles, found);
}

function describeOther(m: Json): string | null {
  if (m.location) {
    const { latitude, longitude, description, name } = m.location;
    const label = description || name || 'Location';
    return `📍 ${label} https://maps.google.com/?q=${latitude},${longitude}`;
  }
  if (Array.isArray(m.vCards) && m.vCards.length) {
    const names = m.vCards.map((v: string) => /^FN[^:]*:(.*)$/m.exec(v)?.[1]?.trim()).filter(Boolean);
    return `👤 Contact: ${names.join(', ') || 'contact card'}`;
  }
  return null;
}

/** One WhatsApp message (event or history). Returns the stored row, or undefined when skipped. */
async function ingestMessage(m: Json, opts: { history?: boolean } = {}): Promise<MessageRow | undefined> {
  if (!m?.id) return;
  const fromMe = !!m.fromMe;
  const chatRaw = fromMe ? m.to : m.from;
  if (!chatRaw || skipChat(chatRaw)) return;
  const chatId = await resolve(chatRaw);
  if (!chatId) return;
  const extId = String(m.id);
  if (findMessageByExt(extId)) return; // already have it (our own send, or a repeat)

  const isGroup = chatId.endsWith('@g.us');
  const conv = getOrCreateWaChat(chatId);
  if (isGroup && !conv.group_name) refreshGroupName(conv).catch(() => {});
  if (isGroup && !conv.group_members) refreshGroupSoon(chatId);

  const senderRaw = fromMe ? null : isGroup ? m.participant ?? m.author : m.from;
  const sender = fromMe ? null : await resolve(senderRaw);
  const author = fromMe ? 'self' : sender ? keyFor(sender) : 'unknown';
  if (sender && !fromMe) {
    const push = pushNameOf(m);
    if (push && (!waContact(sender)?.push_name || waContact(sender)?.push_name !== push)) upsertWaContact({ jid: sender, pushName: push });
    else if (!waContact(sender)) upsertWaContact({ jid: sender });
  }
  if (!isGroup && !fromMe && !waContact(chatId)) upsertWaContact({ jid: chatId });

  // Our own messages sent through the API come back as events too: link them to the row we stored.
  if (fromMe && !opts.history) {
    const recent = db
      .prepare<[number, number], MessageRow>(
        "SELECT * FROM messages WHERE conversation_id = ? AND outgoing = 1 AND ext_id IS NULL AND status IN ('pending','sent') AND sent_ts > ? ORDER BY sent_ts DESC",
      )
      .all(conv.id, Date.now() - 120_000);
    const body = String(m.body ?? '');
    const match = recent.find((r) => (r.body ?? '') === body || (!!r.body && body.includes(r.body.replace(/￼/g, ''))));
    if (match && m.source !== 'app') {
      emitMessage(updateMessage(match.id, { ext_id: extId }));
      return;
    }
    if (m.source === 'api') return;
  }

  const poll = pollOf(m);
  let { body, ranges } = poll ? { body: poll.question, ranges: null } : await richFromWa(m.body, conv);
  const attachments: Attachment[] = [];
  if (m.hasMedia) {
    try {
      const a = await downloadMedia(m, extId);
      if (a) attachments.push(a);
    } catch (e) {
      log.warn(`whatsapp: media for ${extId}: ${(e as Error).message}`);
    }
    if (!attachments.length) body = [body, '📎 Media that WAHA did not download — open it on your phone'].filter(Boolean).join('\n');
    // A caption is the body; WAHA sometimes puts the file name there for documents.
    if (body && attachments[0]?.filename && body === attachments[0].filename) body = null;
  }
  if (!body && !attachments.length && !poll) {
    const other = describeOther(m);
    if (!other) return; // protocol messages, reactions (separate event), etc.
    body = other;
  }

  let quote = null;
  if (m.replyTo) {
    const q = findMessageByExt(m.replyTo.id ?? m.replyTo.messageId);
    const qAuthor = q ? q.author : m.replyTo.participant ? keyFor((await resolve(m.replyTo.participant)) ?? '') : 'unknown';
    quote = { sentTs: q?.sent_ts ?? 0, author: qAuthor, text: m.replyTo.body ?? (m.replyTo.hasMedia ? 'Attachment' : '') };
  }

  const ts = freeTimestamp(conv.id, Math.round(Number(m.timestamp) * 1000) || Date.now(), author);
  const status = fromMe ? STATUS_FOR_ACK[Number(m.ack)] ?? 'sent' : null;
  const row = insertMessage({
    conversationId: conv.id,
    sentTs: ts,
    author,
    outgoing: fromMe,
    kind: poll ? 'poll' : 'message',
    body,
    ranges,
    attachments,
    quote,
    status: status === 'pending' ? 'sent' : status,
    read: fromMe || !!opts.history,
    poll,
    extId,
  });
  if (row && !opts.history) {
    emitMessage(row);
    emitConversation(conv.id);
  }
  return row;
}

/** Name from a group object, whatever the engine: GOWS {JID, Name}, NOWEB {id, subject}, WEBJS {name | groupMetadata.subject}. */
function groupNameOf(g: Json): string | null {
  return g?.Name || g?.subject || g?.name || g?.groupMetadata?.subject || g?.GroupName?.Name || null;
}
function groupIdOf(g: Json): string | null {
  const id = g?.JID ?? g?.id ?? g?.groupMetadata?.id;
  return typeof id === 'string' ? id : id?._serialized ?? null;
}

const groupNameTried = new Map<string, number>();
async function refreshGroupName(conv: ConversationRow) {
  const last = groupNameTried.get(conv.wa_id!) ?? 0;
  if (Date.now() - last < 60_000) return;
  groupNameTried.set(conv.wa_id!, Date.now());
  const name = groupNameOf(await waha.group(conv.wa_id!));
  if (name) {
    getOrCreateWaChat(conv.wa_id!, name);
    emitConversation(conv.id);
  }
}

/** Names of all groups in one call. */
async function refreshGroupNames() {
  const res = await waha.groups();
  const list: Json[] = Array.isArray(res) ? res : res && typeof res === 'object' ? Object.values(res) : [];
  const known = new Map(listWaGroups().map((g) => [g.wa_id, g]));
  for (const g of list) {
    const id = groupIdOf(g);
    const name = groupNameOf(g);
    if (id && name && known.has(bare(id)) && known.get(bare(id))!.group_name !== name) getOrCreateWaChat(bare(id), name);
  }
}

async function handleEvent(e: Json) {
  const p = e?.payload;
  switch (e?.event) {
    case 'session.status':
      recheckWa(200);
      return;
    case 'message':
    case 'message.any':
      await ingestMessage(p);
      return;
    case 'message.reaction': {
      const target = findMessageByExt(p?.reaction?.messageId);
      if (!target) return;
      const who = p.fromMe ? 'self' : keyFor((await resolve(p.participant ?? p.from)) ?? 'unknown');
      let reactions: Reaction[] = target.reactions ? JSON.parse(target.reactions) : [];
      reactions = reactions.filter((r) => r.author !== who);
      if (p.reaction.text) reactions.push({ emoji: p.reaction.text, author: who });
      emitMessage(updateMessage(target.id, { reactions: reactions.length ? JSON.stringify(reactions) : null }));
      return;
    }
    case 'message.ack': {
      const target = findMessageByExt(p?.id);
      if (!target?.outgoing) return;
      const status = STATUS_FOR_ACK[Number(p.ack)];
      if (status && (status === 'failed' || statusRank(status) > statusRank(target.status))) emitMessage(updateMessage(target.id, { status }));
      return;
    }
    case 'message.revoked': {
      const id = p?.revokedMessageId ?? p?.before?.id ?? p?.after?.id;
      const target = findMessageByExt(id);
      if (!target) return;
      emitMessage(updateMessage(target.id, { deleted: 1, body: null, ranges: null, attachments: null, reactions: null, preview: null }));
      emitConversation(target.conversation_id);
      return;
    }
    case 'message.edited': {
      const target = findMessageByExt(p?.editedMessageId);
      if (!target) return;
      const conv = getConversation(target.conversation_id)!;
      const rich = await richFromWa(p.body, conv);
      emitMessage(updateMessage(target.id, { body: rich.body, ranges: rich.ranges ? JSON.stringify(rich.ranges) : null, edited: 1 }));
      emitConversation(conv.id);
      return;
    }
    case 'presence.update': {
      const chat = await resolve(p?.id);
      if (!chat) return;
      const conv = getOrCreateWaChat(chat);
      for (const pr of p.presences ?? []) {
        const who = await resolve(pr.participant ?? chat);
        if (!who || self.isWa(who)) continue;
        const key = keyFor(who);
        const typing = pr.lastKnownPresence === 'typing' || pr.lastKnownPresence === 'recording';
        broadcast({ type: 'typing', conversationId: conv.id, author: key, authorName: nameForKey(key), started: typing });
      }
      return;
    }
    case 'poll.vote': {
      const target = findMessageByExt(p?.poll?.id);
      if (!target?.poll) return;
      const poll: Poll = JSON.parse(target.poll);
      const v = p.vote ?? {};
      const voter = v.fromMe ? 'self' : keyFor((await resolve(v.participant ?? v.from)) ?? 'unknown');
      const options = (v.selectedOptions ?? []).map((name: string) => poll.options.indexOf(name)).filter((i: number) => i >= 0);
      const count = Number(v.timestamp) || Date.now();
      if (poll.votes[voter] && poll.votes[voter].count > count) return;
      poll.votes[voter] = { options, count };
      emitMessage(updateMessage(target.id, { poll: JSON.stringify(poll) }));
      return;
    }
    case 'group.v2.update':
    case 'group.v2.participants': {
      const id = p?.group?.id ?? p?.id;
      if (typeof id === 'string' && id.endsWith('@g.us')) {
        if (p?.group?.subject) getOrCreateWaChat(id, p.group.subject);
        refreshGroupSoon(id);
      }
      return;
    }
  }
}

// ---------- history ----------

async function importHistory(): Promise<{ chats: number; messages: number }> {
  const chats = await waha.chatsOverview(config.wahaHistoryChats);
  log.info(`whatsapp: checking ${chats?.length ?? 0} recent chats for history`);
  let total = 0;
  let touched = 0;
  let failures = 0;
  for (const c of chats ?? []) {
    const idRaw = typeof c.id === 'string' ? c.id : c.id?._serialized;
    if (!idRaw || skipChat(idRaw)) continue;
    const id = await resolve(idRaw);
    if (!id) continue;
    const conv = getOrCreateWaChat(id, id.endsWith('@g.us') ? c.name : null);
    if (!id.endsWith('@g.us') && c.name && !waContact(id)?.name) upsertWaContact({ jid: id, pushName: c.name });
    let list: Json[] = [];
    try {
      list = await waha.messages(idRaw, config.wahaHistoryMessages, true);
    } catch (e) {
      log.warn(`whatsapp: history for ${id}: ${(e as Error).message}`);
      continue;
    }
    list = [...(list ?? [])].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
    const rows: MessageRow[] = [];
    for (const m of list) {
      const row = await ingestMessage(m, { history: true }).catch((e) => {
        if (failures++ < 3) log.warn(`whatsapp: couldn't import message ${m?.id}: ${(e as Error).message}`);
        return undefined;
      });
      if (row) rows.push(row);
    }
    total += rows.length;
    if (rows.length) touched++;
    // Keep WhatsApp's unread count for the chat.
    const unread = Number(c._chat?.unreadCount ?? c.unreadCount ?? c._chat?.UnreadCount ?? 0);
    if (unread > 0) {
      const incoming = rows.filter((r) => !r.outgoing).slice(-unread);
      for (const r of incoming) updateMessage(r.id, { read: 0 });
    }
    emitConversation(conv.id);
  }
  return { chats: touched, messages: total };
}

// ---------- outgoing ----------

function extIdOf(res: Json): string | null {
  const id = res?.id ?? res?.key?.id ?? res?._data?.id;
  if (typeof id === 'string') return id;
  if (id?._serialized) return String(id._serialized);
  if (res?.ID) return String(res.ID);
  return null;
}

function jidFor(key: string): string | null {
  if (key === 'self') return self.waIds[0] ?? null;
  return key.startsWith('wa:') ? key.slice(3) : null;
}

export function requireWa() {
  if (state.status !== 'connected') {
    throw Object.assign(new Error(state.status === 'disabled' ? 'WhatsApp is not set up' : 'WhatsApp is not connected'), { httpStatus: 503 });
  }
}

function parseDataUrl(s: string): WaFile | null {
  const m = /^data:([^;,]+)(?:;filename=([^;,]*))?;base64,([\s\S]*)$/.exec(s);
  return m ? { mimetype: m[1], filename: m[2] || undefined, data: m[3] } : null;
}

function quoteExt(conv: ConversationRow, q: { sentTs: number } | null | undefined) {
  if (!q) return undefined;
  const r = db.prepare<[number, number], { ext_id: string | null }>('SELECT ext_id FROM messages WHERE conversation_id = ? AND sent_ts = ?').get(conv.id, q.sentTs);
  return r?.ext_id ?? undefined;
}

/** Send a stored pending message. Several files go out as several WhatsApp messages; the first one's id is kept. */
export async function deliverWa(
  conv: ConversationRow,
  messageId: number,
  p: { text: string; ranges?: Ranges | null; base64: string[]; quote?: { sentTs: number } | null; sticker?: unknown; preview?: LinkPreview | null },
) {
  const chatId = conv.wa_id!;
  const wa = toWaText(p.text, p.ranges ?? null, jidFor);
  const reply_to = quoteExt(conv, p.quote);
  let first: Json;
  if (p.sticker) throw new Error("Signal stickers can't be sent to WhatsApp");
  if (p.base64.length) {
    for (const [i, b] of p.base64.entries()) {
      const file = parseDataUrl(b);
      if (!file) continue;
      const kind = file.mimetype.startsWith('image/') && file.mimetype !== 'image/gif' ? 'sendImage' : file.mimetype.startsWith('video/') ? 'sendVideo' : 'sendFile';
      const caption = i === 0 && wa.text ? wa.text : undefined;
      const res = await waha.sendMedia(kind, chatId, file, { caption, reply_to: i === 0 ? reply_to : undefined, mentions: i === 0 && wa.mentions.length ? wa.mentions : undefined });
      if (i === 0) first = res;
    }
  } else if (p.preview && wa.text.includes(p.preview.url)) {
    let image: { mimetype: string; data: string } | undefined;
    if (p.preview.image && isSafeId(p.preview.image.id)) {
      try {
        image = { mimetype: p.preview.image.contentType, data: fs.readFileSync(localPath(p.preview.image.id)).toString('base64') };
      } catch {
        /* without a picture */
      }
    }
    first = await waha.linkPreview(chatId, wa.text, { url: p.preview.url, title: p.preview.title ?? p.preview.url, description: p.preview.description ?? '', ...(image ? { image } : {}) }, reply_to);
  } else {
    first = await waha.sendText(chatId, wa.text, { reply_to, mentions: wa.mentions.length ? wa.mentions : undefined, linkPreview: false });
  }
  const ext = extIdOf(first);
  const current = getMessage(messageId);
  emitMessage(updateMessage(messageId, { status: current && statusRank(current.status) > statusRank('sent') ? current.status! : 'sent', error: null, ts_confirmed: 1, ...(ext && !findMessageByExt(ext) ? { ext_id: ext } : {}) }));
}

function ext(m: MessageRow) {
  if (!m.ext_id) throw Object.assign(new Error("This message hasn't reached WhatsApp yet"), { httpStatus: 400 });
  return m.ext_id;
}

export async function reactWa(m: MessageRow, emoji: string) {
  await waha.react(ext(m), emoji);
}

export async function editWa(conv: ConversationRow, m: MessageRow, text: string, ranges: Ranges | null) {
  const wa = toWaText(text, ranges, jidFor);
  await waha.edit(conv.wa_id!, ext(m), wa.text, wa.mentions);
}

export async function deleteWa(conv: ConversationRow, m: MessageRow) {
  await waha.remove(conv.wa_id!, ext(m));
}

export async function markReadWa(conv: ConversationRow, unread: MessageRow[]) {
  const ids = unread.filter((m) => !m.outgoing && m.ext_id).map((m) => m.ext_id!);
  await waha.seen(conv.wa_id!, ids.slice(-50));
}

export async function typingWa(conv: ConversationRow, on: boolean) {
  await waha.typing(conv.wa_id!, on);
}

export async function createPollWa(conv: ConversationRow, question: string, options: string[], multiple: boolean) {
  const res = await waha.sendPoll(conv.wa_id!, question, options, multiple);
  const ts = Date.now();
  const row = insertMessage({
    conversationId: conv.id,
    sentTs: ts,
    author: 'self',
    outgoing: true,
    kind: 'poll',
    body: question,
    status: 'sent',
    read: true,
    poll: { question, options, multiple, votes: {} },
    extId: extIdOf(res),
  });
  return row;
}

export async function voteWa(conv: ConversationRow, m: MessageRow, poll: Poll, picked: number[]) {
  await waha.vote(conv.wa_id!, ext(m), picked.map((i) => poll.options[i]));
}

// ---------- avatars ----------

const avatarDir = path.join(config.dataDir, 'avatars');
const avatarInflight = new Map<string, Promise<string | null>>();

// Picture lookups go through WhatsApp, which rate-limits bursts (a chat list asks for dozens at once).
let avatarSlots = 2;
const avatarWaiting: (() => void)[] = [];
async function withAvatarSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (avatarSlots === 0) await new Promise<void>((r) => avatarWaiting.push(r));
  avatarSlots--;
  try {
    return await fn();
  } finally {
    avatarSlots++;
    setTimeout(() => avatarWaiting.shift()?.(), 150);
  }
}
let avatarWarnings = 0;

/** A WhatsApp profile/group picture, cached for 12 hours (no picture: 6 hours; errors: 30 minutes). */
export function waAvatar(jid: string): Promise<string | null> {
  const name = 'wa-' + crypto.createHash('sha256').update(jid).digest('hex').slice(0, 32);
  const file = path.join(avatarDir, name);
  const miss = file + '.none';
  const fail = file + '.fail';
  let p = avatarInflight.get(name);
  if (p) return p;
  p = (async () => {
    const now = Date.now();
    const age = (f: string) => (fs.existsSync(f) ? now - fs.statSync(f).mtimeMs : Infinity);
    const cached = fs.existsSync(file);
    if (cached && age(file) < 12 * 3600_000) return file;
    if (!cached && age(miss) < 6 * 3600_000) return null;
    if (age(fail) < 30 * 60_000) return cached ? file : null;
    if (state.status !== 'connected') return cached ? file : null;
    try {
      const url = await withAvatarSlot(async () => (await waha.chatPicture(jid)).url);
      fs.mkdirSync(avatarDir, { recursive: true });
      if (!url) {
        fs.writeFileSync(miss, '');
        fs.rmSync(file, { force: true });
        return null;
      }
      const res = url.includes('/api/files/') ? await waha.file(url) : await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`picture download answered ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(file + '.part', buf);
      fs.renameSync(file + '.part', file);
      fs.rmSync(miss, { force: true });
      fs.rmSync(fail, { force: true });
      return file;
    } catch (e) {
      if (avatarWarnings++ < 5) log.warn(`whatsapp: picture for ${jid}: ${(e as Error).message}`);
      fs.mkdirSync(avatarDir, { recursive: true });
      fs.writeFileSync(fail, '');
      return cached ? file : null;
    } finally {
      avatarInflight.delete(name);
    }
  })();
  avatarInflight.set(name, p);
  return p;
}

/** Start (or open) a WhatsApp chat with a phone number. */
export function waChatForNumber(number: string): ConversationRow {
  const digits = number.replace(/\D/g, '');
  return getOrCreateWaChat(`${digits}@c.us`);
}
