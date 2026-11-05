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
import { getSettings } from './settings.js';
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
  findWaChat,
  freeTimestamp,
  getConversation,
  getMessage,
  getOrCreateWaChat,
  insertMessage,
  listWaGroups,
  messageDto,
  nameForKey,
  recordReceipt,
  renderBody,
  self,
  setConversationFlags,
  setGroupDescription,
  setWaAbout,
  setWaGroupMembers,
  statusRank,
  updateMessage,
  upsertWaContact,
  waAboutCached,
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
  importProgress?: { done: number; total: number };
  lastImport?: { chats: number; messages: number; at: number; error?: string };
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
  setState({ ...state, importing: true, importProgress: undefined });
  try {
    const r = await importHistory((done, total) => setState({ ...state, importProgress: { done, total } }));
    log.info(`whatsapp: history import: ${r.messages} new messages from ${r.chats} chats`);
    await refreshDirectory().catch(() => {});
    setState({ ...state, lastImport: { ...r, at: Date.now() } });
    return r;
  } catch (e) {
    const msg = (e as Error).message;
    log.warn(`whatsapp: history import failed: ${msg}${/store/i.test(msg) ? ' (NOWEB engine: enable the store in the session config, or use GOWS)' : ''}`);
    setState({ ...state, lastImport: { chats: 0, messages: 0, at: Date.now(), error: msg } });
    throw e;
  } finally {
    importing = false;
    setState({ ...state, importing: false, importProgress: undefined });
  }
}

/** Import again now (button in Settings). Runs in the background: a big import takes many minutes. */
export function importHistoryNow() {
  requireWa();
  if (importing) throw Object.assign(new Error('An import is already running'), { httpStatus: 409 });
  runHistoryImport().catch(() => {});
  return { started: true };
}

export function startWhatsApp(logger: Logger) {
  log = logger;
  if (!config.wahaUrl) return;
  stopped = false;
  void check();
  dirTimer = setInterval(() => state.status === 'connected' && refreshDirectory().catch(() => {}), 6 * 3600_000);
  // Mutes change more often than names: check those every 15 minutes.
  setInterval(() => state.status === 'connected' && syncMutes().catch(() => {}), 15 * 60_000).unref();
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
  await syncMutes().catch((e) => log.warn(`whatsapp: mute status: ${(e as Error).message}`));
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

  if (m._data?.type === 'call_log') return callLogMessage(m, conv, chatId, fromMe, !!opts.history);

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
    // WhatsApp sends the quoted text raw ("@2718973… be like"): use our copy, or at least resolve its mentions.
    let text = q ? renderBody(q.body, q.ranges)?.text ?? null : null;
    if (text === null && m.replyTo.body) {
      const rich = await richFromWa(m.replyTo.body, conv);
      text = renderBody(rich.body, rich.ranges ? JSON.stringify(rich.ranges) : null)?.text ?? m.replyTo.body;
    }
    quote = { sentTs: q?.sent_ts ?? 0, author: qAuthor, text: text || (m.replyTo.hasMedia || q?.attachments ? 'Attachment' : '') };
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

/**
 * When the chat is muted on your phone, as far as the engine tells: WEBJS/WPP report isMuted and
 * muteExpiration (seconds, -1 = always), NOWEB muteEndTime (ms). GOWS doesn't pass it on.
 * Returns undefined when this engine says nothing about muting.
 */
function mutedUntilOf(chat: Json): number | undefined {
  if (!chat || typeof chat !== 'object') return undefined;
  if (typeof chat.isMuted === 'boolean' || 'muteExpiration' in chat) {
    const exp = Number(chat.muteExpiration ?? 0);
    if (!chat.isMuted && exp <= 0) return 0;
    if (exp < 0) return FOREVER;
    return exp > 1e12 ? exp : exp * 1000;
  }
  for (const k of ['muteEndTime', 'mutedUntil', 'MutedUntil', 'muteEnd']) {
    if (k in chat) {
      const v = Number(chat[k] ?? 0);
      if (v < 0) return FOREVER;
      return v > 1e12 ? v : v * 1000;
    }
  }
  return undefined;
}
const FOREVER = 8.64e15;
let muteNoticeShown = false;

/**
 * Copy mutes and "marked as unread" from your phone. What you set here is kept unless the phone has
 * news about that chat.
 */
async function syncMutes() {
  const chats = await waha.chats(300);
  let known = 0;
  let changed = 0;
  for (const c of chats ?? []) {
    const id = typeof c.id === 'string' ? c.id : c.id?._serialized;
    if (!id || skipChat(id)) continue;
    const until = mutedUntilOf(c) ?? mutedUntilOf(c._chat);
    const unreadCount = c.unreadCount ?? c._chat?.unreadCount;
    if (until === undefined && unreadCount === undefined) continue;
    const jid = await resolve(id);
    if (!jid) continue;
    const conv = getOrCreateWaChat(jid, jid.endsWith('@g.us') ? c.name ?? null : null);
    if (unreadCount !== undefined) phoneUnread(conv, Number(unreadCount));
    if (until === undefined) continue;
    known++;
    const remote = until > Date.now() ? until : 0;
    const last = kvGet(`wa_mute:${jid}`);
    if (String(remote) === last) continue; // nothing changed on the phone since last time
    kvSet(`wa_mute:${jid}`, String(remote));
    if ((conv.muted_until > Date.now() ? conv.muted_until : 0) !== remote) {
      setConversationFlags(conv.id, { mutedUntil: remote });
      changed++;
      if (conv.last_message_at) emitConversation(conv.id);
    }
  }
  if (!known && !muteNoticeShown) {
    muteNoticeShown = true;
    log.info(`whatsapp: this WAHA engine (${state.engine ?? 'unknown'}) doesn't report which chats are muted on your phone`);
  } else if (changed) log.info(`whatsapp: copied ${changed} mute setting${changed === 1 ? '' : 's'} from your phone`);
}

/**
 * "Mark as unread" on the phone shows up as an unread count of -1 (WEBJS). From the periodic check only
 * changes are copied (so a mark you cleared here isn't put back); a live event always is.
 */
function phoneUnread(conv: ConversationRow, unreadCount: number, live = false) {
  const marked = unreadCount < 0 ? '1' : '0';
  if (!live && kvGet(`wa_unread:${conv.wa_id}`) === marked) return;
  kvSet(`wa_unread:${conv.wa_id}`, marked);
  if (!!conv.marked_unread === (marked === '1')) return;
  setConversationFlags(conv.id, { markedUnread: marked === '1' });
  if (conv.last_message_at) emitConversation(conv.id);
}

/** Name from a group object, whatever the engine: GOWS {JID, Name}, NOWEB {id, subject}, WEBJS {name | groupMetadata.subject}. */
function groupNameOf(g: Json): string | null {
  return g?.Name || g?.subject || g?.name || g?.groupMetadata?.subject || g?.GroupName?.Name || null;
}
/** Group description: WEBJS groupMetadata.desc, NOWEB desc, GOWS Topic. undefined = this object doesn't say. */
function descriptionOf(g: Json): string | null | undefined {
  if (!g || typeof g !== 'object') return undefined;
  for (const src of [g.groupMetadata, g]) {
    if (!src || typeof src !== 'object') continue;
    for (const k of ['desc', 'description', 'Topic']) if (k in src) return src[k] ? String(src[k]) : null;
  }
  if (g.GroupTopic && typeof g.GroupTopic === 'object') return g.GroupTopic.Topic ? String(g.GroupTopic.Topic) : null;
  return undefined;
}
function groupIdOf(g: Json): string | null {
  const id = g?.JID ?? g?.id ?? g?.groupMetadata?.id;
  return typeof id === 'string' ? id : id?._serialized ?? null;
}

const groupNameTried = new Map<string, number>();
let descWarnings = 0;
/** Group info was opened: fetch its name and description fresh (at most once a minute). */
export async function refreshGroupInfoWa(conv: ConversationRow) {
  if (state.status !== 'connected') return;
  try {
    await refreshGroupName(conv);
  } catch (e) {
    if (descWarnings++ < 5) log.warn(`whatsapp: group info for ${conv.wa_id}: ${(e as Error).message}`);
  }
}
async function refreshGroupName(conv: ConversationRow) {
  const last = groupNameTried.get(conv.wa_id!) ?? 0;
  if (Date.now() - last < 60_000) return;
  groupNameTried.set(conv.wa_id!, Date.now());
  const g = await waha.group(conv.wa_id!);
  if (descriptionOf(g) === undefined && descWarnings++ < 5) {
    log.info(`whatsapp: group ${conv.wa_id} came without a description field (fields: ${Object.keys(g?.groupMetadata ?? g ?? {}).slice(0, 40).join(', ')})`);
  }
  const name = groupNameOf(g);
  const desc = descriptionOf(g);
  if (desc !== undefined && desc !== conv.group_description) setGroupDescription(conv.id, desc);
  if (name) getOrCreateWaChat(conv.wa_id!, name);
  if (name || desc !== undefined) emitConversation(conv.id);
}

/** Names of all groups in one call. */
async function refreshGroupNames() {
  const res = await waha.groups();
  const list: Json[] = Array.isArray(res) ? res : res && typeof res === 'object' ? Object.values(res) : [];
  const known = new Map(listWaGroups().map((g) => [g.wa_id, g]));
  for (const g of list) {
    const id = groupIdOf(g);
    const conv = id ? known.get(bare(id)) : undefined;
    if (!conv) continue;
    const name = groupNameOf(g);
    if (name && conv.group_name !== name) getOrCreateWaChat(conv.wa_id!, name);
    const desc = descriptionOf(g);
    if (desc !== undefined && (desc || null) !== conv.group_description) setGroupDescription(conv.id, desc);
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
    case 'message.ack':
    case 'message.ack.group': {
      // Direct chats: one ack for the other person. Groups (WEBJS): one per member who received/read it.
      const target = findMessageByExt(p?.id);
      if (!target?.outgoing) return;
      const ack = Number(p.ack);
      const status = STATUS_FOR_ACK[ack];
      if (!status) return;
      if (status === 'failed') return emitMessage(updateMessage(target.id, { status }));
      if (ack >= 2) {
        const conv = getConversation(target.conversation_id)!;
        const who = conv.kind === 'group' ? await resolve(p.participant) : conv.wa_id;
        if (who && !self.isWa(who)) {
          const next = recordReceipt(target, keyFor(who), ack >= 3 ? 'read' : 'delivered', Date.now());
          if (next !== target.status && statusRank(next) >= statusRank(target.status)) emitMessage(updateMessage(target.id, { status: next }));
          else broadcast({ type: 'receipt', messageId: target.id });
          return;
        }
      }
      // A group ack without a member, or "reached the server": move the ticks forward only.
      if (statusRank(status) > statusRank(target.status) && (getConversation(target.conversation_id)!.kind !== 'group' || status === 'sent')) {
        emitMessage(updateMessage(target.id, { status }));
      }
      return;
    }
    case 'message.revoked': {
      // WEBJS sends the deletion notice ("after") and the deleted message ("before"); we want the latter.
      const id = p?.revokedMessageId ?? p?.before?.id;
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
        const recording = pr.lastKnownPresence === 'recording';
        const typing = pr.lastKnownPresence === 'typing' || recording;
        broadcast({ type: 'typing', conversationId: conv.id, author: key, authorName: nameForKey(key), started: typing, ...(recording ? { recording } : {}) });
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
    case 'engine.event': {
      // WEBJS passes on whatsapp-web.js's own events; "unread_count" fires as soon as a chat's count
      // changes, including when you mark it unread (or read it) on your phone.
      if (p?.event !== 'unread_count') return;
      const id = typeof p.data?.id === 'string' ? p.data.id : p.data?.id?._serialized;
      if (!id || skipChat(id) || typeof p.data?.unreadCount !== 'number') return;
      const jid = await resolve(id);
      if (!jid) return;
      const conv = findWaChat(jid);
      if (conv) phoneUnread(conv, p.data.unreadCount, true);
      return;
    }
    case 'call.received':
    case 'call.accepted':
    case 'call.rejected': {
      // WEBJS only tells us a call came in (not whether you picked up on your phone); other engines say more.
      if (!p?.id || !p?.from) return;
      const outcome = e.event === 'call.accepted' ? 'answered' : e.event === 'call.rejected' ? 'declined' : 'incoming';
      await recordCall(p.from, String(p.id), !!p.isVideo, outcome, Number(p.timestamp) * 1000 || Date.now());
      return;
    }
    case 'group.v2.update':
    case 'group.v2.participants': {
      const id = p?.group?.id ?? p?.id;
      if (typeof id === 'string' && id.endsWith('@g.us')) {
        if (p?.group?.subject) getOrCreateWaChat(id, p.group.subject);
        const desc = descriptionOf(p?.group);
        if (desc !== undefined) setGroupDescription(getOrCreateWaChat(id).id, desc);
        refreshGroupSoon(id);
      }
      return;
    }
  }
}

// ---------- history ----------

async function importHistory(progress: (done: number, total: number) => void = () => {}): Promise<{ chats: number; messages: number }> {
  const { waHistoryChats, waHistoryMessages } = getSettings();
  const chats = await waha.chatsOverview(waHistoryChats || 5000);
  log.info(`whatsapp: checking ${chats?.length ?? 0} recent chats for history`);
  let total = 0;
  let touched = 0;
  let failures = 0;
  let done = 0;
  progress(0, chats?.length ?? 0);
  for (const c of chats ?? []) {
    progress(done++, chats.length);
    const idRaw = typeof c.id === 'string' ? c.id : c.id?._serialized;
    if (!idRaw || skipChat(idRaw)) continue;
    const id = await resolve(idRaw);
    if (!id) continue;
    const conv = getOrCreateWaChat(id, id.endsWith('@g.us') ? c.name : null);
    if (!id.endsWith('@g.us') && c.name && !waContact(id)?.name) upsertWaContact({ jid: id, pushName: c.name });
    let list: Json[] = [];
    try {
      list = await waha.messages(idRaw, waHistoryMessages || 100_000, true);
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
  const ids = unread.filter((m) => !m.outgoing && m.ext_id && !m.ext_id.startsWith('call:')).map((m) => m.ext_id!);
  await waha.seen(conv.wa_id!, ids.slice(-50));
  kvSet(`wa_unread:${conv.wa_id}`, '0'); // reading it clears "marked as unread" on the phone too
}

export async function markUnreadWa(conv: ConversationRow) {
  await waha.markUnread(conv.wa_id!);
  kvSet(`wa_unread:${conv.wa_id}`, '1');
}

let aboutWarnings = 0;
/** Someone's "about" text (cached for an hour; null when they hide it or have none). */
export async function waAbout(jid: string): Promise<string | null> {
  const cached = waAboutCached(jid);
  // An empty answer is asked again sooner: it may have been a hiccup rather than their privacy setting.
  if (cached && Date.now() - cached.at < (cached.about ? 3600_000 : 5 * 60_000)) return cached.about;
  if (state.status !== 'connected') return cached?.about ?? null;
  try {
    const r = await waha.about(jid);
    const about = typeof r === 'string' ? r : r?.about ?? null;
    if (!about && aboutWarnings++ < 5) log.info(`whatsapp: no about text for ${jid} (WAHA answered ${JSON.stringify(r)?.slice(0, 200)})`);
    setWaAbout(jid, about ? String(about) : null);
    return about ? String(about) : null;
  } catch (e) {
    if (aboutWarnings++ < 5) log.warn(`whatsapp: about for ${jid}: ${(e as Error).message}`);
    return cached?.about ?? null;
  }
}

// ---------- calls ----------

type CallOutcome = 'incoming' | 'missed' | 'answered' | 'declined' | 'outgoing';

function callText(video: boolean, outcome: CallOutcome, seconds?: number) {
  const what = video ? 'video call' : 'voice call';
  const icon = video ? '🎥' : '📞';
  const dur = seconds && seconds > 0 ? ` (${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')})` : '';
  const label = { incoming: `Incoming ${what}`, missed: `Missed ${what}`, answered: what[0].toUpperCase() + what.slice(1), declined: `Declined ${what}`, outgoing: `Outgoing ${what}` }[outcome];
  return `${icon} ${label}${dur}`;
}

/** A line in the chat for a call. Later news about the same call updates the line. */
async function recordCall(fromRaw: string, callId: string, video: boolean, outcome: CallOutcome, ts: number) {
  const jid = await resolve(fromRaw);
  if (!jid || skipChat(jid) || self.isWa(jid)) return;
  const extId = 'call:' + callId;
  const existing = findMessageByExt(extId);
  if (existing) {
    if (outcome !== 'incoming') emitMessage(updateMessage(existing.id, { body: callText(video, outcome) }));
    return;
  }
  const conv = getOrCreateWaChat(jid);
  const author = keyFor(jid);
  const row = insertMessage({
    conversationId: conv.id,
    sentTs: freeTimestamp(conv.id, ts, author),
    author,
    outgoing: false,
    kind: 'system',
    body: callText(video, outcome),
    read: outcome === 'answered',
    extId,
  });
  if (row) {
    emitMessage(row);
    emitConversation(conv.id);
  }
}

/** A call-log message (WhatsApp's own "Missed voice call" line), if the engine passes them on. */
function callLogMessage(m: Json, conv: ConversationRow, chatId: string, fromMe: boolean, history: boolean): MessageRow | undefined {
  const d = m._data ?? {};
  const video = !!(d.isVideoCall ?? d.isVideo);
  const seconds = Number(d.callDuration ?? 0) || 0;
  const said = String(d.callOutcome ?? d.callResult ?? '');
  const outcome: CallOutcome = fromMe
    ? 'outgoing'
    : /miss|unanswer|timeout/i.test(said)
      ? 'missed'
      : /reject|declin|busy/i.test(said)
        ? 'declined'
        : seconds > 0 || /accept|connect|complete/i.test(said)
          ? 'answered'
          : 'missed';
  const ts = Math.round(Number(m.timestamp) * 1000) || Date.now();
  const body = callText(video, outcome, seconds);
  // The "call.received" event may already have put a line in for this call.
  const earlier = db
    .prepare<[number, number, number], MessageRow>(
      "SELECT * FROM messages WHERE conversation_id = ? AND ext_id LIKE 'call:%' AND sent_ts BETWEEN ? AND ? ORDER BY sent_ts DESC",
    )
    .get(conv.id, ts - 10 * 60_000, ts + 60_000);
  if (earlier) {
    const row = updateMessage(earlier.id, { body, ext_id: String(m.id), ...(outcome === 'answered' ? { read: 1 } : {}) });
    emitMessage(row);
    emitConversation(conv.id);
    return undefined;
  }
  const author = fromMe ? 'self' : keyFor(chatId);
  const row = insertMessage({
    conversationId: conv.id,
    sentTs: freeTimestamp(conv.id, ts, author),
    author,
    outgoing: fromMe,
    kind: 'system',
    body,
    read: fromMe || outcome === 'answered',
    extId: String(m.id),
  });
  if (row && !history) {
    emitMessage(row);
    emitConversation(conv.id);
  }
  return row;
}

const presenceSubscribed = new Map<string, number>();
/** WEBJS only reports "typing…" for chats you subscribe to, like WhatsApp Web does when you open one. */
export async function subscribePresenceWa(conv: ConversationRow) {
  const last = presenceSubscribed.get(conv.wa_id!) ?? 0;
  if (Date.now() - last < 10 * 60_000) return;
  presenceSubscribed.set(conv.wa_id!, Date.now());
  await waha.subscribePresence(conv.wa_id!).catch(() => presenceSubscribed.delete(conv.wa_id!));
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
