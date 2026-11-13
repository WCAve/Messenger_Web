/**
 * WhatsApp through WAHA (WEBJS engine: WhatsApp Web in a browser inside the WAHA container). Keeps the
 * session linked and running, turns WAHA's websocket events into stored messages, imports history, and
 * sends on behalf of the browser. waha-api.ts is the thin HTTP client; this is the logic.
 *
 * Sections (search for "// ----------"):
 *   ids          WhatsApp ids: …@c.us (number), …@lid (privacy id), …@g.us (group). resolve() prefers the
 *                number; lid↔number links are remembered in kv (lid:/lidof:) and come from WAHA, the
 *                Android backup (seedLids) and group members (linkGroupLids). keyFor() → "wa:<jid>" / "self".
 *   connection   check() polls the session status; connectWs() opens the event websocket; afterConnect()
 *                runs once per connect: directory, one-off clean-ups, history import. A FAILED session is
 *                restarted automatically.
 *   directory    contacts and groups (names, members, admins); refreshGroupSoon batches member refreshes.
 *   incoming     ingestMessage(): one entry point for live events AND the history import. A per-message
 *                lock stops the two from storing the same message twice; HD photo/video copies
 *                (associationType *_DUAL_UPLOAD) merge into their original. richFromWa() turns WhatsApp
 *                markup and @mentions into stored text + ranges. Files: downloaded live; for imported
 *                history only noted (wa_media) and fetched when someone looks (fetchWaMedia).
 *   handleEvent  the switch over WAHA events (message, ack, reaction, revoked, edited, presence, poll,
 *                calls, groups, labels, archive, engine.event for unread counts and group lines). Events
 *                are handled strictly one after another.
 *   history      importHistory(): pages of 1000 per chat, resumable, skips chats that crash WhatsApp Web.
 *                catchUpWa(): the light version, after every (re)connect and from the refresh button:
 *                each chat active since the last event seen (the button: a week), back to then, filling holes.
 *   outgoing     deliverWa() sends a stored pending message; replies only link when WhatsApp Web has the
 *                original (linkableQuoteId), otherwise the quote goes as text.
 *   presence, contacts and profile, stickers, group system lines, calls, avatars, blocking.
 *
 * WEBJS quirks worth knowing: getChats is heavy (it looks up every group), so the directory is loaded
 * once and then patched by events; replies need the quoted message to be known to WhatsApp Web; member
 * labels only exist for labels set after WAHA was linked (older ones come from the Android backup); video
 * sending needs WAHA's Chrome image (devlikeapro/waha:chrome).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { attachmentHooks, isSafeId, isSilentVideo, localPath } from './attachments.js';
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
  quotedMedia,
  findWaChat,
  freeTimestamp,
  getConversation,
  getMessage,
  getOrCreateWaChat,
  insertMessage,
  isPreviewData,
  listWaGroups,
  messageDto,
  nameForKey,
  recordReceipt,
  renderBody,
  self,
  setConversationFlags,
  setGroupDescription,
  extRawOf,
  mergeGroupSettings,
  setWaAbout,
  setWaBlocked,
  setWaGroupMembers,
  statusRank,
  unreadMessages,
  updateMessage,
  deleteMessageContent,
  upsertWaContact,
  waAboutCached,
  waBlocked,
  waContact,
  waNumberOf,
} from './store.js';
import { recordLabelEvent, refreshWaLabels } from './groups.js';
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
  importProgress?: { done: number; total: number; waiting?: boolean };
  lastImport?: { chats: number; messages: number; at: number; error?: string; skipped?: number };
  /** "Check for missed messages": running now, or the last result. */
  catchUp?: { running: boolean; at?: number; chats?: number; messages?: number; error?: string };
  backup?: BackupState;
}

/** Importing an Android backup (msgstore.db.crypt15) and its media folder; see wabackup.ts. */
export interface BackupState {
  stage: 'idle' | 'decrypting' | 'importing' | 'media' | 'done' | 'failed';
  file?: { name: string; size: number; at: number; app?: string } | null;
  progress?: { done: number; total: number; phase?: 'scan' | 'copy' };
  result?: { chats: number; messages: number; reactions: number; files: number; skipped: number; mediaFound?: number; mediaMissing?: number; labels?: number; labelGroups?: number; labelsOnly?: boolean };
  error?: string;
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

/** Merge into the shared WhatsApp state (shown in Settings). */
export function updateWaState(patch: Partial<WaState>) {
  setState({ ...state, ...patch });
}

export function emitMessage(m: MessageRow | undefined) {
  if (m) broadcast({ type: 'message', message: messageDto(m) });
}
export function emitConversation(id: number) {
  const c = getConversation(id);
  if (c) broadcast({ type: 'conversation', conversation: conversationDto(c) });
}

// ---------- ids ----------

const lidCache = new Map<string, string | null>();

/** Privacy ids (@lid) and the phone numbers they belong to, as a backup knows them. */
export function seedLids(pairs: [string, string][]) {
  for (const [lid, pn] of pairs) {
    const l = bare(lid);
    const p = bare(pn);
    if (!l.endsWith('@lid') || !p.endsWith('@c.us')) continue;
    lidCache.set(l, p);
    kvSet(`lid:${l}`, p);
    kvSet(`lidof:${p}`, l);
  }
}

/** Ids come as strings, or (WEBJS, some fields) as {server, user, _serialized} objects. */
function idString(x: unknown): string | null {
  if (typeof x === 'string') return x || null;
  if (x && typeof x === 'object') {
    const o = x as { _serialized?: unknown; user?: unknown; server?: unknown };
    if (typeof o._serialized === 'string') return o._serialized;
    if (typeof o.user === 'string' && typeof o.server === 'string') return `${o.user}@${o.server}`;
  }
  return null;
}

/** Strip the device part and use one spelling: "316…:12@s.whatsapp.net" → "316…@c.us". */
export function bare(jid: unknown): string {
  return (idString(jid) ?? '').replace(/:\d+@/, '@').replace('@s.whatsapp.net', '@c.us');
}

/** Prefer phone-number ids over WhatsApp's privacy ids (@lid) when WAHA knows the number. */
export async function resolve(jid: unknown): Promise<string | null> {
  if (!idString(jid)) return null;
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
    if (pn) kvSet(`lidof:${pn}`, j);
    return pn ?? j;
  } catch {
    lidCache.set(j, null); // try again after a restart
    return j;
  }
}

export function keyFor(jid: string): string {
  return self.isWa(jid) ? 'self' : 'wa:' + jid;
}

export function skipChat(raw: unknown) {
  const jid = idString(raw) ?? '';
  return !jid || jid.startsWith('0@') || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast');
}

// ---------- connection ----------

let failedSince = 0;
let restartAttempts = 0;
const RESTART_BACKOFF = [Number(process.env.WAHA_RESTART_AFTER_MS) || 20_000, 60_000, 3 * 60_000, 10 * 60_000, 30 * 60_000];

async function check() {
  clearTimeout(checkTimer);
  if (stopped || !config.wahaUrl) return;
  let next = Number(process.env.WAHA_CHECK_MS) || 60_000; // while connected (tests: a few seconds)
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
    // The regular status check rebuilds the state; keep what the import is showing.
    const base = { engine, version: state.version, importing: state.importing, importProgress: state.importProgress, lastImport: state.lastImport };
    if (!state.version) waha.version().then((v) => setState({ ...state, version: v.version, engine: state.engine ?? v.engine })).catch(() => {});
    if (s.status !== 'WORKING' && state.status === 'connected') eventsInterrupted();
    switch (s.status) {
      case 'WORKING': {
        if (state.status !== 'connected') sentPresence = null; // say it again after (re)connecting
        restartAttempts = 0;
        failedSince = 0;
        const me = s.me?.id ? bare(s.me.id) : undefined;
        if (me) self.waIds = [me, s.me?.lid ? bare(s.me.lid) : ''];
        const wasConnected = state.status === 'connected';
        setState({ ...base, status: 'connected', me: me ? me.split('@')[0].replace(/^/, '+') : undefined, name: s.me?.pushName });
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
      case 'FAILED': {
        // WAHA is supposed to restart a crashed WhatsApp Web itself, but doesn't always: do it for it,
        // after giving it a moment, and less often if it keeps failing.
        const now = Date.now();
        if (!failedSince) failedSince = now;
        const wait = RESTART_BACKOFF[Math.min(restartAttempts, RESTART_BACKOFF.length - 1)];
        if (now - failedSince >= wait) {
          restartAttempts++;
          failedSince = now;
          log.info(`whatsapp: session failed; restarting it (attempt ${restartAttempts})`);
          await waha.restartSession().catch(() => waha.startSession().catch(() => {}));
          next = 5000;
        } else next = 10_000;
        setState({ ...base, status: 'failed', error: 'WhatsApp Web stopped working. Restarting it automatically…' });
        break;
      }
      default:
        setState({ ...base, status: 'starting', error: `WAHA session status ${s.status}` });
        next = 5000;
    }
  } catch (e) {
    const msg = (e as Error).message;
    if (state.status === 'connected') eventsInterrupted();
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
    // The connection for events was gone for a moment while WhatsApp itself stayed up: fetch what it missed.
    if (missedSince !== undefined && !afterConnectBusy) setTimeout(() => void catchUpMissed('after the event connection dropped'), 15_000).unref();
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
    eventsInterrupted();
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

let afterConnectBusy = false; // afterConnect does the catch-up itself, a little later
async function afterConnect() {
  afterConnectBusy = true;
  try {
    await afterConnectSteps();
  } finally {
    afterConnectBusy = false;
  }
}
async function afterConnectSteps() {
  // With WEBJS the chat list makes WhatsApp Web look up every group, which keeps it busy for up to a
  // minute. Once contacts are known, let the app load first and do this a little later.
  const known = kvGet('wa_directory_v1') === 'done';
  if (known) await pause(Number(process.env.WAHA_AFTER_CONNECT_PAUSE_MS) || 60_000);
  if (state.status !== 'connected') return;
  await refreshDirectory().catch((e) => log.warn(`whatsapp: contacts: ${(e as Error).message}`));
  kvSet('wa_directory_v1', 'done');
  if (kvGet('wa_hd_pairs_v2') !== 'done') {
    const r = await mergeStoredHdPairs().catch((e) => (log.warn(`whatsapp: HD pairs: ${(e as Error).message}`), null));
    if (r) {
      // At most three tries: what WhatsApp Web still can't answer for after that stays as it is.
      const tries = Number(kvGet('wa_hd_pairs_tries') ?? 0) + 1;
      kvSet('wa_hd_pairs_tries', String(tries));
      if (!r.unchecked || tries >= 3) kvSet('wa_hd_pairs_v2', 'done');
      log.info(`whatsapp: HD photo/video pairs: ${r.candidates} to check, ${r.merged} merged${r.unchecked ? `, ${r.unchecked} WhatsApp Web couldn't answer for (tried again next start)` : ''}`);
    }
  }
  if (kvGet('wa_mention_lids_v1') !== 'done') {
    const r = await linkLidsForOldMentions().catch((e) => (log.warn(`whatsapp: mentions: ${(e as Error).message}`), null));
    if (r) {
      kvSet('wa_mention_lids_v1', 'done');
      if (r.groups) log.info(`whatsapp: mentions without a name in ${r.groups} groups: linked ${r.linked} members' privacy ids`);
    }
  }
  setTimeout(() => void downloadPendingMedia().catch(() => {}), 60_000); // carry on with files, if switched on
  if (kvGet(HISTORY_KEY) === 'done') {
    // Messages that came in while this app or WAHA was down never arrived as events: fetch them.
    await catchUpMissed('after connecting');
    return;
  }
  missedSince = undefined; // the history import that follows fetches everything
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
    const r = await importHistory((done, total, waiting) => setState({ ...state, importProgress: { done, total, ...(waiting ? { waiting } : {}) } }));
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
    // Afterwards, gently: member lists of groups the import found, then (if switched on) the files.
    void refreshImportedGroups()
      .catch(() => {})
      .then(() => downloadPendingMedia())
      .catch(() => {});
  }
}

/**
 * Missed messages: WAHA only sends events while both it and this app are running, so after a restart
 * (or a dropped connection) messages can be missing, also in the middle of a chat when newer ones came
 * in live afterwards. Asks for the chat list once, then for each chat with something since `since`,
 * pages newest first back to `since`, storing what we don't have. After connecting `since` is just
 * before the last event we saw; the refresh button looks back a week. Missed messages keep WhatsApp's
 * read state (unread on the phone = unread here). Files are fetched when someone looks.
 */
let catchingUp = false;
const CATCHUP_CHATS = 100;
const CATCHUP_PAGE = 50;
const CATCHUP_MAX_PER_CHAT = 500;
const WEEK = 7 * 24 * 3600_000;
const CATCHUP_MARGIN = Number(process.env.WAHA_CATCHUP_MARGIN_MS) || 10 * 60_000;
/** How far back to look to cover everything missed, or undefined when nothing was. At most 30 days. */
function missedFrom(): number | undefined {
  if (missedSince === undefined) return undefined;
  return Math.max((missedSince || Date.now() - WEEK) - CATCHUP_MARGIN, Date.now() - 30 * 24 * 3600_000);
}
export async function catchUpWa(why: string, since?: number): Promise<{ chats: number; messages: number }> {
  if (catchingUp || importing || state.status !== 'connected') return { chats: 0, messages: 0 };
  const interrupted = missedSince;
  const needed = missedFrom();
  since ??= needed ?? Date.now() - CATCHUP_MARGIN;
  catchingUp = true;
  setState({ ...state, catchUp: { ...state.catchUp, running: true } });
  let chatsTouched = 0;
  let total = 0;
  try {
    const chats = (await waha.chats(CATCHUP_CHATS)) ?? [];
    for (const c of chats) {
      if (state.status !== 'connected') break;
      const idRaw = idString(c.id);
      if (!idRaw || skipChat(idRaw)) continue;
      const id = await resolve(idRaw);
      if (!id) continue;
      const theirs = Number(c.timestamp ?? c.conversationTimestamp ?? c._chat?.t ?? 0) * 1000;
      if (theirs && theirs < since) continue; // nothing since then
      const added: MessageRow[] = [];
      const seenIncoming: { id: string; ts: number }[] = []; // to tell which ones the phone has as unread
      let offset = 0;
      while (offset < CATCHUP_MAX_PER_CHAT && state.status === 'connected') {
        const page = (await waha.messages(idRaw, CATCHUP_PAGE, false, offset)) ?? [];
        for (const m of page) if (m?.id && !m.fromMe) seenIncoming.push({ id: String(m.id), ts: Number(m.timestamp) });
        const sorted = [...page].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
        const reachedSince = sorted.length > 0 && Number(sorted[0].timestamp) * 1000 < since;
        for (const m of sorted) {
          if (Number(m?.timestamp) * 1000 < since) continue;
          if (m?.id && findMessageByExt(String(m.id))) continue;
          const row = await ingestMessage(m, { history: true }).catch((e) => {
            log.warn(`whatsapp: missed message ${m?.id}: ${(e as Error).message}`);
            return undefined;
          });
          if (row) added.push(row);
        }
        if (reachedSince || page.length < CATCHUP_PAGE) break;
        offset += page.length;
        await pause(200);
      }
      if (!added.length) continue;
      // Same read state as on the phone: its unread count says how many of the newest incoming are unread.
      const unread = Number(c._chat?.unreadCount ?? c.unreadCount ?? 0);
      if (unread > 0) {
        const unreadIds = new Set(seenIncoming.sort((a, b) => b.ts - a.ts).slice(0, unread).map((x) => x.id));
        for (const r of added) if (!r.outgoing && r.ext_id && unreadIds.has(r.ext_id) && !readBefore(r.conversation_id, r.sent_ts)) updateMessage(r.id, { read: 0 });
      }
      for (const r of added) emitMessage(getMessage(r.id));
      const conv = findWaChat(id);
      if (conv) emitConversation(conv.id);
      chatsTouched++;
      total += added.length;
      await pause(250);
    }
    if (total) log.info(`whatsapp: missed messages (${why}): ${total} from ${chatsTouched} chat${chatsTouched === 1 ? '' : 's'}`);
    // Everything missed is covered, unless the stream was interrupted again meanwhile.
    if (needed !== undefined && since <= needed && missedSince === interrupted && state.status === 'connected') missedSince = undefined;
    setState({ ...state, catchUp: { running: false, at: Date.now(), chats: chatsTouched, messages: total } });
    return { chats: chatsTouched, messages: total };
  } catch (e) {
    const msg = (e as Error).message;
    log.warn(`whatsapp: checking for missed messages failed: ${msg}`);
    setState({ ...state, catchUp: { running: false, at: Date.now(), chats: chatsTouched, messages: total, error: msg } });
    throw e;
  } finally {
    catchingUp = false;
  }
}

/** After the event stream was interrupted: fetch what was missed; once more a few minutes later if WhatsApp Web was too busy. */
async function catchUpMissed(why: string, retry = true) {
  if (missedSince === undefined || kvGet(HISTORY_KEY) !== 'done') return;
  try {
    await catchUpWa(why);
  } catch {
    if (retry) setTimeout(() => void catchUpMissed(why, false), 5 * 60_000).unref();
  }
}

/** The refresh button: runs in the background, the result arrives with the WhatsApp state. */
export function catchUpWaNow() {
  requireWa();
  if (importing) throw Object.assign(new Error('A history import is running; it fetches these too'), { httpStatus: 409 });
  if (!catchingUp) catchUpWa('refresh button', Math.min(Date.now() - WEEK, missedFrom() ?? Infinity)).catch(() => {});
  return { started: true };
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
  attachmentHooks.whatsapp = fetchWaMedia;
  if (!config.wahaUrl) return;
  stopped = false;
  eventsInterrupted(); // whatever came in while this app wasn't running
  void check();
  dirTimer = setInterval(() => state.status === 'connected' && refreshDirectory().catch(() => {}), 6 * 3600_000);
  // Mutes and pins change more often than names: check those every 15 minutes. (Not more often: with
  // WEBJS every chat-list request makes WhatsApp Web look up all your groups at once.)
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
  await waha.restartSession().catch(() => waha.startSession().catch(() => {}));
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
    if (typeof c.isBlocked === 'boolean' && c.isBlocked !== waBlocked(jid)) setWaBlocked(jid, c.isBlocked);
  }
  // One chat list for both (WEBJS's group list is the same list, filtered).
  const chats = await waha.chats(2000).catch((e) => (log.warn(`whatsapp: chat list: ${(e as Error).message}`), null));
  if (chats) {
    await refreshGroupNames(chats.filter((c) => c?.isGroup || groupIdOf(c)?.endsWith('@g.us'))).catch((e) => log.warn(`whatsapp: group names: ${(e as Error).message}`));
    await syncMutes(chats).catch((e) => log.warn(`whatsapp: mute status: ${(e as Error).message}`));
  }
  for (const g of listWaGroups()) {
    if (!g.group_name) await refreshGroupName(g).catch(() => {});
    await refreshGroup(g).catch(() => {});
  }
  for (const g of listWaGroups()) emitConversation(g.id);
}

const groupsAfterImport = new Set<string>();
/** Member lists for groups first seen during the import, one at a time. */
async function refreshImportedGroups() {
  const list = [...groupsAfterImport];
  groupsAfterImport.clear();
  for (const jid of list) {
    if (state.status !== 'connected') return;
    const conv = getOrCreateWaChat(jid);
    if (!conv.group_name) await refreshGroupName(conv).catch(() => {});
    await refreshGroup(conv).catch(() => {});
    emitConversation(conv.id);
    await pause(300);
  }
}

const groupRefreshPending = new Map<string, ReturnType<typeof setTimeout>>();
function refreshGroupSoon(jid: string) {
  clearTimeout(groupRefreshPending.get(jid));
  groupRefreshPending.set(
    jid,
    setTimeout(() => {
      groupRefreshPending.delete(jid);
      const conv = getOrCreateWaChat(jid);
      groupNameTried.delete(jid); // a change came in: name, description and settings fresh too
      Promise.all([refreshGroup(conv).catch(() => {}), refreshGroupName(conv).catch(() => {})])
        .then(() => refreshWaLabels(getConversation(conv.id)!).catch(() => {}))
        .then(() => (emitConversation(conv.id), groupChanged(conv.id)));
    }, 2000),
  );
}

/** Open group-info panels reload (join requests, labels, settings changed). */
export function groupChanged(conversationId: number) {
  broadcast({ type: 'group', conversationId });
}

/** You left or were removed: you're no longer among the members (WhatsApp Web stops reporting them). */
export function dropSelfFromGroup(conv: ConversationRow) {
  const c = getConversation(conv.id)!;
  const members: string[] = c.group_members ? JSON.parse(c.group_members) : [];
  const admins: string[] = c.group_admins ? JSON.parse(c.group_admins) : [];
  setWaGroupMembers(c.id, members.filter((k) => k !== 'self'), admins.filter((k) => k !== 'self'));
  emitConversation(c.id);
}

/** After a change you made: members, admins, name and description fresh, now. */
export async function refreshWaGroupNow(conv: ConversationRow) {
  groupNameTried.delete(conv.wa_id!);
  await Promise.all([refreshGroup(conv).catch((e) => log.warn(`whatsapp: group members ${conv.wa_id}: ${(e as Error).message}`)), refreshGroupName(conv).catch(() => {})]);
  emitConversation(conv.id);
  groupChanged(conv.id);
}

export async function refreshGroup(conv: ConversationRow) {
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

const TYPE_MIME: Record<string, string> = { image: 'image/jpeg', video: 'video/mp4', ptt: 'audio/ogg', audio: 'audio/ogg', sticker: 'image/webp', document: 'application/octet-stream' };

/** An attachment for a file that isn't downloaded yet, from what the message itself says about it. */
function pendingMedia(m: Json, extId: string): Attachment {
  const d = m._data ?? {};
  const mimetype = String(d.mimetype ?? m.media?.mimetype ?? TYPE_MIME[d.type] ?? 'application/octet-stream').split(';')[0].trim() || 'application/octet-stream';
  const filename: string | null = d.filename ?? m.media?.filename ?? null;
  const ext = path.extname(filename ?? '').replace(/[^A-Za-z0-9.]/g, '').slice(0, 10) || EXT[mimetype] || '';
  const att: Attachment = {
    id: 'wa-' + crypto.createHash('sha1').update(extId).digest('hex').slice(0, 24) + ext,
    contentType: mimetype,
    filename,
    size: Number(d.size) || null,
    ...(Number(d.width) && Number(d.height) ? { width: Number(d.width), height: Number(d.height) } : {}),
  };
  if (mimetype.startsWith('audio/') && (d.type === 'ptt' || /ogg.*opus/i.test(String(d.mimetype ?? '')))) att.voiceNote = true;
  if (mimetype.startsWith('video/') && d.isGif) att.gif = true;
  if (d.type === 'sticker') att.sticker = true;
  return att;
}

// Files are fetched one or two at a time: WhatsApp Web may have to ask your phone for each.
let mediaSlots = 2;
const mediaWaiting: (() => void)[] = [];
async function withMediaSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (mediaSlots === 0) await new Promise<void>((r) => mediaWaiting.push(r));
  mediaSlots--;
  try {
    return await fn();
  } finally {
    mediaSlots++;
    mediaWaiting.pop()?.(); // newest first: what you just scrolled to matters more than what you scrolled past
  }
}
const mediaInflight = new Map<string, Promise<boolean>>();
let mediaWarnings = 0;

type MediaRow = { id: string; chat: string; msg: string; message_id: number | null; ts: number | null; state: string; tried_at: number | null };

/**
 * A file from imported history, fetched now (someone opened it, or the background download).
 * True when it's on the server afterwards. Files WhatsApp can't provide any more are marked missing
 * on the message (asked again after a day).
 */
export function fetchWaMedia(id: string): Promise<boolean> {
  let p = mediaInflight.get(id);
  if (p) return p;
  p = (async () => {
    const file = localPath(id);
    if (fs.existsSync(file)) return true;
    const row = db.prepare<[string], MediaRow>('SELECT * FROM wa_media WHERE id = ?').get(id);
    if (!row) return false;
    if (row.state === 'missing' && Date.now() - (row.tried_at ?? 0) < 24 * 3600_000) return false;
    if (state.status !== 'connected') return false;
    return withMediaSlot(async () => {
      let ok = false;
      try {
        const msg = await waha.message(row.chat, row.msg);
        const url = msg?.media?.url;
        if (url) {
          const res = await waha.file(url);
          if (res.ok && res.body) {
            const tmp = file + '.part';
            await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(tmp));
            fs.renameSync(tmp, file);
            ok = true;
          }
        }
      } catch (e) {
        if (mediaWarnings++ < 5) log.warn(`whatsapp: file ${row.msg}: ${(e as Error).message}`);
      }
      db.prepare('UPDATE wa_media SET state = ?, tried_at = ? WHERE id = ?').run(ok ? 'done' : 'missing', Date.now(), id);
      if (ok) db.prepare('DELETE FROM wa_media WHERE id = ?').run(id);
      const m = row.message_id ? getMessage(row.message_id) : undefined;
      if (m?.attachments) {
        const atts: Attachment[] = JSON.parse(m.attachments);
        const next = atts.map((a) => {
          if (a.id !== id) return a;
          const b: Attachment = { ...a };
          delete b.missing;
          if (!ok) b.missing = true;
          else {
            b.size = fs.statSync(file).size;
            if (b.sticker) addSticker(b.id);
            if (b.contentType.startsWith('video/')) {
              const silent = isSilentVideo(id);
              if (silent) b.gif = true;
            }
          }
          return b;
        });
        emitMessage(updateMessage(m.id, { attachments: JSON.stringify(next) }));
      }
      return ok;
    });
  })().finally(() => mediaInflight.delete(id));
  mediaInflight.set(id, p);
  return p;
}

let mediaJob = false;
/** Settings → "Download files from imported history": newest first, one at a time, in the background. */
export async function downloadPendingMedia() {
  if (mediaJob || !getSettings().waHistoryMedia) return;
  mediaJob = true;
  let n = 0;
  try {
    for (;;) {
      if (state.status !== 'connected' || importing || !getSettings().waHistoryMedia) break;
      const next = db
        .prepare<[number], { id: string }>("SELECT id FROM wa_media WHERE state = 'pending' OR (state = 'missing' AND tried_at < ?) ORDER BY ts DESC LIMIT 1")
        .get(Date.now() - 24 * 3600_000);
      if (!next) break;
      const before = db.prepare<[string], { tried_at: number | null }>('SELECT tried_at FROM wa_media WHERE id = ?').get(next.id);
      await fetchWaMedia(next.id);
      // Not fetched and not marked (session went down, …): stop rather than loop on it.
      const after = db.prepare<[string], { tried_at: number | null }>('SELECT tried_at FROM wa_media WHERE id = ?').get(next.id);
      if (after && after.tried_at === before?.tried_at) break;
      n++;
      await pause(500);
    }
  } finally {
    mediaJob = false;
    if (n) log.info(`whatsapp: background download: ${n} file${n === 1 ? '' : 's'} from imported history`);
  }
}

const EXT: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'application/pdf': '.pdf',
};

/**
 * Mentions name people by privacy id, members are often known by number, and WhatsApp Web can't
 * always say which number a privacy id belongs to. Ask the other way round, for each member of the
 * group: which privacy id has this number? Remembered, so once per person; then mentions show names.
 */
const lidsLinked = new Map<string, number>();
export async function linkGroupLids(conv: ConversationRow): Promise<number> {
  const g = conv.wa_id!;
  if ((lidsLinked.get(g) ?? 0) > Date.now() - 6 * 3600_000) return 0;
  lidsLinked.set(g, Date.now());
  const members: string[] = conv.group_members ? JSON.parse(conv.group_members) : [];
  let linked = 0;
  for (const k of members) {
    const jid = k.startsWith('wa:') ? k.slice(3) : '';
    if (!jid.endsWith('@c.us') || kvGet(`lidof:${jid}`) !== undefined) continue;
    const lid = await waha.phoneToLid(jid).then((r) => (r?.lid ? bare(r.lid) : ''), () => null);
    if (lid === null) continue; // try again another time
    kvSet(`lidof:${jid}`, lid);
    if (lid) {
      seedLids([[lid, jid]]);
      linked++;
    }
  }
  if (linked) {
    // Messages that show a privacy id get their names now.
    const rows = db.prepare<[number], { id: number }>("SELECT id FROM messages WHERE conversation_id = ? AND ranges LIKE '%@lid%' ORDER BY id DESC LIMIT 500").all(conv.id);
    for (const r of rows) {
      const row = getMessage(r.id);
      if (row) emitMessage(row);
    }
  }
  return linked;
}

/**
 * One-off, once connected: groups with mentions that show a privacy id or a made-up number get their
 * members' privacy ids looked up.
 */
export async function linkLidsForOldMentions() {
  const rows = db
    .prepare<[], { conversation_id: number; ranges: string }>("SELECT conversation_id, ranges FROM messages WHERE ranges LIKE '%\"mentions\"%' AND ranges LIKE '%wa:%'")
    .all();
  const groups = new Set<number>();
  for (const r of rows) {
    try {
      for (const mm of (JSON.parse(r.ranges).mentions ?? []) as { key: string }[]) {
        const jid = mm.key?.startsWith('wa:') ? mm.key.slice(3) : '';
        if (!jid) continue;
        const c = waContact(jid);
        if (!c?.name && !c?.push_name && !kvGet(`lid:${jid.split('@')[0]}@lid`)) groups.add(r.conversation_id);
      }
    } catch {
      /* not JSON */
    }
  }
  let linked = 0;
  for (const id of groups) {
    const conv = getConversation(id);
    if (conv?.network === 'whatsapp' && conv.kind === 'group' && state.status === 'connected') linked += await linkGroupLids(conv);
  }
  return { groups: groups.size, linked };
}

/** WhatsApp text → stored body: formatting markers become styles, "@<number>" becomes a real mention. */
export async function richFromWa(
  text: string | null | undefined,
  conv: ConversationRow,
  mentioned?: unknown,
): Promise<{ body: string | null; ranges: Ranges | null }> {
  if (!text) return { body: text ?? null, ranges: null };
  const { text: plain, styles } = parseWaMarkup(text);
  const found: { start: number; end: number; key: string }[] = [];
  const members = new Set<string>(conv.group_members ? JSON.parse(conv.group_members) : []);
  // The message says exactly who's mentioned ("…@lid" privacy id, or "…@c.us" number).
  const listed = new Map<string, string>();
  for (const x of Array.isArray(mentioned) ? mentioned : []) {
    const j = bare(x);
    if (j) listed.set(j.split('@')[0], j);
  }
  let unresolved = false;
  for (const m of plain.matchAll(/@(\d{6,20})\b/g)) {
    const digits = m[1];
    const exact = listed.get(digits);
    const candidates = exact ? [exact] : [`${digits}@c.us`, `${digits}@lid`];
    let key: string | null = null;
    for (const c of candidates) {
      if (self.isWa(c)) key = 'self';
      else if (members.has('wa:' + c) || waContact(c)?.name || waContact(c)?.push_name) key = 'wa:' + c;
      if (key) break;
    }
    // A privacy id (any length): the number behind it, if WhatsApp or the backup told us.
    if (!key && (!exact || exact.endsWith('@lid'))) {
      const pn = kvGet(`lid:${digits}@lid`) || (exact || digits.length >= 13 ? await resolve(`${digits}@lid`) : null);
      if (pn && !pn.endsWith('@lid')) key = keyFor(pn);
      else if (exact || kvGet(`lid:${digits}@lid`) !== undefined) {
        key = 'wa:' + `${digits}@lid`; // named once we learn whose it is (see linkGroupLids)
        unresolved = true;
      }
    }
    if (!key && conv.kind === 'group') key = 'wa:' + (exact ?? candidates[0]);
    if (key) found.push({ start: m.index!, end: m.index! + m[0].length, key });
  }
  if (unresolved && conv.kind === 'group') void linkGroupLids(conv).catch(() => {});
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
/** The original's raw id, when this message is WhatsApp's HD copy of a photo or video. */
function hdParentOf(m: Json): string | null {
  const d = m?._data;
  if (!/DUAL_UPLOAD/.test(String(d?.associationType ?? ''))) return null;
  const k = d?.parentMsgKey;
  const id = typeof k === 'string' ? k : idString(k?.id) ?? idString(k?._serialized) ?? idString(k);
  return id ? extRawOf(id) : null;
}

/** The HD copy: its id points to the original; its file replaces the original's if it's bigger. */
async function mergeHdCopy(parent: MessageRow, m: Json, extId: string, history: boolean): Promise<MessageRow> {
  kvSet(`waalias:${extRawOf(extId)}`, String(parent.id));
  const atts: Attachment[] = parent.attachments ? JSON.parse(parent.attachments) : [];
  const size = Number(m?._data?.size ?? m?.media?.size ?? 0);
  const current = atts[0];
  const better = !!m.hasMedia && (!current || !!current.missing || (size > 0 && size > Number(current.size ?? 0)));
  if (!better || history) return parent;
  const a = await downloadMedia(m, extId).catch(() => null);
  if (!a) return parent;
  if (current?.caption) a.caption = current.caption;
  const row = updateMessage(parent.id, { attachments: JSON.stringify([a]) });
  if (row) emitMessage(row);
  return row ?? parent;
}

/**
 * One-off, once connected: HD pairs stored as two messages before they were recognised. Only pairs
 * WhatsApp confirms (the copy names the original) are merged: a photo really sent twice stays.
 */
export async function mergeStoredHdPairs(): Promise<{ candidates: number; merged: number; unchecked: number }> {
  const pairs = db
    .prepare<[number], { a: number; b: number; a_ext: string; b_ext: string; chat: string; a_att: string; b_att: string }>(
      `SELECT a.id AS a, b.id AS b, a.ext_id AS a_ext, b.ext_id AS b_ext, c.wa_id AS chat, a.attachments AS a_att, b.attachments AS b_att
       FROM messages a JOIN messages b ON b.conversation_id = a.conversation_id AND b.author = a.author AND b.id > a.id
         AND b.sent_ts >= a.sent_ts AND b.sent_ts < (a.sent_ts / 1000) * 1000 + 1000
       JOIN conversations c ON c.id = a.conversation_id
       WHERE c.network = 'whatsapp' AND a.attachments IS NOT NULL AND b.attachments IS NOT NULL
         AND a.ext_id IS NOT NULL AND b.ext_id IS NOT NULL AND a.deleted = 0 AND b.deleted = 0
         AND a.received_at > ?
       ORDER BY b.id DESC`,
    )
    .all(Date.now() - 30 * 86_400_000);
  const first = (j: string): Attachment | undefined => {
    try {
      const l = JSON.parse(j) as Attachment[];
      return l.length === 1 ? l[0] : undefined;
    } catch {
      return undefined;
    }
  };
  const merge = (keep: number, drop: number) => {
    const k = getMessage(keep), d = getMessage(drop);
    if (!k || !d) return false;
    const patch: Partial<MessageRow> = {};
    if (!k.reactions && d.reactions) patch.reactions = d.reactions;
    const ka = first(k.attachments ?? '[]'), da = first(d.attachments ?? '[]');
    if (da && !da.missing && (!ka || ka.missing || Number(da.size ?? 0) > Number(ka.size ?? 0))) patch.attachments = d.attachments;
    if (Object.keys(patch).length) updateMessage(k.id, patch);
    db.prepare('DELETE FROM messages WHERE id = ?').run(d.id);
    kvSet(`waalias:${extRawOf(d.ext_id!)}`, String(k.id));
    broadcast({ type: 'remove', conversationId: k.conversation_id, messageId: d.id });
    emitMessage(getMessage(k.id)!);
    return true;
  };
  let merged = 0;
  let unchecked = 0;
  let asked = 0;
  const gone = new Set<number>();
  for (const p of pairs) {
    if (gone.has(p.a) || gone.has(p.b)) continue;
    const aa = first(p.a_att), ba = first(p.b_att);
    if (!aa || !ba || aa.contentType !== ba.contentType || !/^(image|video)\//.test(aa.contentType)) continue;
    // The very same file twice, in the same second, from the same person: an HD pair (the HD copy of a
    // file that was already small enough is identical). No need to ask WhatsApp.
    if (Number(aa.size) > 0 && aa.size === ba.size && !aa.missing && !ba.missing) {
      if (merge(p.a, p.b)) (merged++, gone.add(p.b));
      continue;
    }
    // Otherwise only WhatsApp can tell. Ask about a few recent ones, one at a time, gently.
    if (asked >= 40 || state.status !== 'connected') {
      unchecked++;
      continue;
    }
    asked++;
    const ma = await waha.message(p.chat, p.a_ext, false).catch(() => null);
    const mb = ma?._data ? await waha.message(p.chat, p.b_ext, false).catch(() => null) : null;
    await pause(1500);
    if (!ma?._data || !mb?._data) {
      unchecked++;
      continue;
    }
    const pa = hdParentOf(ma), pb = hdParentOf(mb);
    const [keep, drop] = pb === extRawOf(p.a_ext) ? [p.a, p.b] : pa === extRawOf(p.b_ext) ? [p.b, p.a] : [0, 0];
    if (keep && merge(keep, drop)) (merged++, gone.add(drop));
  }
  return { candidates: pairs.length, merged, unchecked };
}

/**
 * WAHA sends one message as several events ("message" and "message.any"). Processing one can take
 * seconds (downloading a video), so a second event for the same message waits for the first
 * instead of storing it again.
 */
const ingesting = new Map<string, Promise<MessageRow | undefined>>();
function ingestMessage(m: Json, opts: { history?: boolean } = {}): Promise<MessageRow | undefined> {
  if (!m?.id) return Promise.resolve(undefined);
  const key = extRawOf(String(m.id));
  const running = ingesting.get(key);
  if (running) return running.then(() => undefined);
  const job = ingestMessageNow(m, opts).finally(() => ingesting.delete(key));
  ingesting.set(key, job);
  return job;
}

async function ingestMessageNow(m: Json, opts: { history?: boolean } = {}): Promise<MessageRow | undefined> {
  if (!m?.id) return;
  const fromMe = !!m.fromMe;
  const chatRaw = fromMe ? m.to : m.from;
  if (!chatRaw || skipChat(chatRaw)) return;
  const chatId = await resolve(chatRaw);
  if (!chatId) return;
  const extId = String(m.id);
  if (findMessageByExt(extId)) return; // already have it (our own send, or a repeat)

  // HD photos and videos come as two messages: the normal one, and an HD copy linked to it. WhatsApp
  // shows one; so do we.
  const parentRaw = hdParentOf(m);
  if (parentRaw) {
    const parent = findMessageByExt(parentRaw);
    if (parent) return mergeHdCopy(parent, m, extId, !!opts.history);
    kvSet(`wahd_wait:${parentRaw}`, extId); // the original isn't here yet: keep this one until it is
  } else {
    const copy = kvGet(`wahd_wait:${extRawOf(extId)}`);
    const child = copy ? findMessageByExt(copy) : undefined;
    if (child) {
      kvSet(`waalias:${extRawOf(extId)}`, String(child.id));
      return child;
    }
  }

  const isGroup = chatId.endsWith('@g.us');
  const conv = getOrCreateWaChat(chatId);
  // During an import, member lists of new groups are fetched afterwards (one WhatsApp Web call each).
  if (isGroup && !conv.group_name && !opts.history) refreshGroupName(conv).catch(() => {});
  if (isGroup && !conv.group_members) {
    if (opts.history) groupsAfterImport.add(chatId);
    else refreshGroupSoon(chatId);
  }

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
      if (match.kind === 'sticker' && m.hasMedia && !(match.attachments ?? '').includes('image/webp')) {
        const a = await downloadMedia(m, extId).catch(() => null);
        if (a) {
          a.sticker = true;
          addSticker(a.id);
          emitMessage(updateMessage(match.id, { attachments: JSON.stringify([a]) }));
        }
      }
      return;
    }
    if (m.source === 'api') return;
  }

  if (m._data?.type === 'call_log') return callLogMessage(m, conv, chatId, fromMe, !!opts.history);
  if (m._data?.type === 'gp2') {
    if (!isGroup) return;
    const d = m._data;
    return groupNotice({ id: extId, chat: chatId, type: String(d.subtype ?? ''), author: d.author ?? m.author ?? null, recipients: d.recipients ?? [], body: m.body ?? d.body ?? '', ts: Number(m.timestamp) * 1000 }, !!opts.history);
  }

  // View-once media can't be opened on a linked device (WhatsApp Web can't either).
  const viewOnce = !!(m._data?.isViewOnce ?? m.isViewOnce);
  const forwarded = m._data?.isForwarded || m.isForwarded ? (Number(m._data?.forwardingScore ?? m.forwardingScore ?? 0) >= 5 ? 2 : 1) : 0;

  const poll = pollOf(m);
  let { body, ranges } = poll
    ? { body: poll.question, ranges: null }
    : await richFromWa(isPreviewData(m.body) ? '' : m.body, conv, m._data?.mentionedJidList ?? m.mentionedIds);
  const attachments: Attachment[] = [];
  const pending: { id: string; chat: string; msg: string }[] = [];
  if (viewOnce) {
    const t = String(m._data?.type ?? '');
    body = `${t === 'video' ? '🎥 View-once video' : t === 'ptt' || t === 'audio' ? '🎤 View-once voice message' : '📷 View-once photo'}: open it on your phone`;
    ranges = null;
  } else if (m.hasMedia && opts.history && !m.media?.url) {
    // Imported history: don't download now (old files can take WhatsApp Web 15–50 s each, if they
    // come at all). Record the file; it's fetched when someone looks at it.
    const a = pendingMedia(m, extId);
    attachments.push(a);
    pending.push({ id: a.id, chat: String(chatRaw), msg: extId });
  } else if (m.hasMedia) {
    try {
      const a = await downloadMedia(m, extId);
      if (a) {
        if (m._data?.type === 'sticker') {
          a.sticker = true;
          addSticker(a.id);
        }
        attachments.push(a);
      }
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
    // WhatsApp Web puts a photo's tiny preview picture (as text) where a reply's quoted text goes when
    // the photo has no caption: that's never shown; the quote shows "Photo" and the picture instead.
    const q = findMessageByExt(m.replyTo.id ?? m.replyTo.messageId);
    const qAuthor = q ? q.author : m.replyTo.participant ? keyFor((await resolve(m.replyTo.participant)) ?? '') : 'unknown';
    // WhatsApp sends the quoted text raw ("@2718973… be like"): use our copy, or at least resolve its mentions.
    let text = q ? renderBody(q.body, q.ranges)?.text ?? null : null;
    if (text === null && m.replyTo.body && !isPreviewData(m.replyTo.body)) {
      const rich = await richFromWa(m.replyTo.body, conv);
      text = renderBody(rich.body, rich.ranges ? JSON.stringify(rich.ranges) : null)?.text ?? m.replyTo.body;
    }
    quote = {
      sentTs: q?.sent_ts ?? 0,
      author: qAuthor,
      text: text || (isPreviewData(m.replyTo.body) ? 'Photo' : m.replyTo.hasMedia || q?.attachments ? 'Attachment' : ''),
      // A private reply: the quoted message is in a group
      ...(q && q.conversation_id !== conv.id ? { chat: q.conversation_id } : {}),
    };
  }

  const ts = freeTimestamp(conv.id, Math.round(Number(m.timestamp) * 1000) || Date.now(), author);
  const status = fromMe ? STATUS_FOR_ACK[Number(m.ack)] ?? 'sent' : null;
  const readEarlier = !fromMe && !opts.history && readBefore(conv.id, ts);
  const row = insertMessage({
    conversationId: conv.id,
    sentTs: ts,
    author,
    outgoing: fromMe,
    kind: poll ? 'poll' : attachments[0]?.sticker ? 'sticker' : 'message',
    body,
    ranges,
    attachments,
    quote,
    status: status === 'pending' ? 'sent' : status,
    read: fromMe || !!opts.history || readEarlier,
    poll,
    extId,
    forwarded,
  });
  if (row && pending.length) {
    const add = db.prepare("INSERT OR IGNORE INTO wa_media (id, chat, msg, message_id, ts, state) VALUES (?, ?, ?, ?, ?, 'pending')");
    for (const x of pending) add.run(x.id, x.chat, x.msg, row.id, ts);
  }
  if (row && readEarlier && extId) queueSeen(conv, extId);
  if (row && !opts.history) {
    emitMessage(row);
    emitConversation(conv.id);
  }
  return row;
}

/*
 * Already read: WhatsApp Web sometimes hands over old messages again as new, or counts them as unread
 * again. A message sent before the last time you read that chat (here, or on the phone as far as
 * WhatsApp says) is stored as read, and WhatsApp is told so your phone clears it too. The margin keeps
 * a message that was just being sent while you read the chat unread. "Mark as unread" (the dot) is
 * separate and not affected.
 */
const READ_MARGIN = 2 * 60_000;
export function noteWaRead(convId: number, at = Date.now()) {
  kvSet(`wa_read_at:${convId}`, String(at));
}
function readBefore(convId: number, ts: number) {
  const at = Number(kvGet(`wa_read_at:${convId}`) ?? 0);
  return at > 0 && ts < at - READ_MARGIN;
}
/** Once: every WhatsApp chat starts read up to its first unread message (or its newest message). */
export function seedWaReadMarks() {
  if (kvGet('wa_read_at_v1')) return 0;
  const rows = db
    .prepare<[], { id: number; at: number | null }>(
      `SELECT c.id, coalesce(
         (SELECT min(sent_ts) FROM messages m WHERE m.conversation_id = c.id AND m.read = 0 AND m.outgoing = 0),
         c.last_message_at) AS at
       FROM conversations c WHERE c.network = 'whatsapp'`,
    )
    .all();
  let n = 0;
  for (const r of rows) {
    if (!r.at || kvGet(`wa_read_at:${r.id}`)) continue;
    noteWaRead(r.id, r.at);
    n++;
  }
  kvSet('wa_read_at_v1', '1');
  return n;
}
const seenQueue = new Map<number, { conv: ConversationRow; ids: Set<string>; timer: NodeJS.Timeout }>();
function queueSeen(conv: ConversationRow, extId: string) {
  let q = seenQueue.get(conv.id);
  if (!q) {
    q = {
      conv,
      ids: new Set(),
      timer: setTimeout(() => {
        seenQueue.delete(conv.id);
        const ids = [...q!.ids];
        log.info(`whatsapp: ${ids.length} old message${ids.length === 1 ? '' : 's'} came in again as new in ${conv.group_name ?? conv.wa_id}; kept as read`);
        // Telling WhatsApp marks the whole chat read on the phone: only when nothing here is unread.
        if (getSettings().sendReadReceipts && state.status === 'connected' && !unreadMessages(conv.id).length) waha.seen(conv.wa_id!, ids.slice(-50)).catch(() => {});
      }, 3000),
    };
    seenQueue.set(conv.id, q);
  }
  q.ids.add(extId);
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
async function syncMutes(list?: Json[]) {
  const chats = list ?? (await waha.chats(2000));
  let known = 0;
  let changed = 0;
  for (const c of chats ?? []) {
    const id = typeof c.id === 'string' ? c.id : c.id?._serialized;
    if (!id || skipChat(id)) continue;
    const until = mutedUntilOf(c) ?? mutedUntilOf(c._chat);
    const unreadCount = c.unreadCount ?? c._chat?.unreadCount;
    if (until === undefined && unreadCount === undefined && c.pinned === undefined && c.archived === undefined) continue;
    const jid = await resolve(id);
    if (!jid) continue;
    const conv = getOrCreateWaChat(jid, jid.endsWith('@g.us') ? c.name ?? null : null);
    if (unreadCount !== undefined) phoneUnread(conv, Number(unreadCount));
    // Archived on the phone. Only changes are copied (archiving here is sent to the phone too).
    const archived = typeof c.archived === 'boolean' ? c.archived : typeof c._chat?.archived === 'boolean' ? c._chat.archived : undefined;
    if (archived !== undefined && kvGet(`wa_arch:${jid}`) !== String(archived)) {
      kvSet(`wa_arch:${jid}`, String(archived));
      if (!!getConversation(conv.id)!.archived !== archived) {
        setConversationFlags(conv.id, { archived });
        changed++;
        emitConversation(conv.id);
      }
    }
    // Pinned on the phone (one way: WAHA can't pin chats). Only changes are copied.
    const pinned = typeof c.pinned === 'boolean' ? c.pinned : typeof c._chat?.pinned === 'boolean' ? c._chat.pinned : undefined;
    if (pinned !== undefined && kvGet(`wa_pin:${jid}`) !== String(pinned)) {
      kvSet(`wa_pin:${jid}`, String(pinned));
      if (!!getConversation(conv.id)!.pinned_at !== pinned) {
        setConversationFlags(conv.id, pinned ? { pinned: true, archived: false } : { pinned: false });
        changed++;
        emitConversation(conv.id);
      }
    }
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
  } else if (changed) log.info(`whatsapp: copied ${changed} mute/pin setting${changed === 1 ? '' : 's'} from your phone`);
}

/**
 * "Mark as unread" on the phone shows up as an unread count of -1 (WEBJS). From the periodic check only
 * changes are copied (so a mark you cleared here isn't put back); a live event always is.
 */
function phoneUnread(conv: ConversationRow, unreadCount: number, live = false) {
  // Nothing unread on the phone: read up to now, as far as later copies of old messages go.
  if (unreadCount === 0 && (live || Number(kvGet(`wa_read_at:${conv.id}`) ?? 0) < (conv.last_message_at ?? 0))) noteWaRead(conv.id);
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
    log.debug?.(`whatsapp: group ${conv.wa_id} came without a description field (fields: ${Object.keys(g?.groupMetadata ?? g ?? {}).slice(0, 40).join(', ')})`);
  }
  const name = groupNameOf(g);
  const desc = descriptionOf(g);
  if (desc !== undefined && desc !== conv.group_description) setGroupDescription(conv.id, desc);
  if (name) getOrCreateWaChat(conv.wa_id!, name);
  const md = g?.groupMetadata ?? g;
  if (typeof md?.announce === 'boolean' || typeof md?.restrict === 'boolean') {
    mergeGroupSettings(conv.id, {
      sendMessages: typeof md.announce === 'boolean' ? (md.announce ? 'admins' : 'all') : undefined,
      editInfo: typeof md.restrict === 'boolean' ? (md.restrict ? 'admins' : 'all') : undefined,
    });
  }
  if (name || desc !== undefined) emitConversation(conv.id);
}

/** Names of all groups in one call. */
async function refreshGroupNames(groups?: Json[]) {
  const res = groups ?? (await waha.groups());
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

/**
 * When events last came in (also kept in kv, at most 30 s behind, for after a restart), and since when
 * some may have been missed. `missedSince` is set the moment the stream is interrupted (start-up, the
 * session stops, WAHA unreachable, the websocket closes): by the time the catch-up runs, new events have
 * already moved "last event" on, so it can't be read then. 0 = interrupted, but no idea since when.
 */
let lastEventAt = 0;
let lastEventSaved = 0;
let missedSince: number | undefined;
function noteEvent() {
  const now = Date.now();
  lastEventAt = now;
  if (now - lastEventSaved < (Number(process.env.WAHA_EVENT_SAVE_MS) || 30_000)) return;
  lastEventSaved = now;
  kvSet('wa_last_event_at', String(now));
}
function eventsInterrupted() {
  if (missedSince === undefined) missedSince = lastEventAt || Number(kvGet('wa_last_event_at') ?? 0) || 0;
}

async function handleEvent(e: Json) {
  const p = e?.payload;
  if (e?.event !== 'session.status') noteEvent();
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
      // Someone else's deletion is kept (click it to see); when you delete your own, it's gone.
      emitMessage(deleteMessageContent(target.id, target.outgoing ? false : 'deleted'));
      emitConversation(target.conversation_id);
      return;
    }
    case 'message.edited': {
      const target = findMessageByExt(p?.editedMessageId);
      if (!target) return;
      const conv = getConversation(target.conversation_id)!;
      const rich = await richFromWa(p.body, conv, p._data?.mentionedJidList ?? p.mentionedIds);
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
        if (conv.kind === 'direct' && who === chat) {
          const online = ['online', 'typing', 'recording'].includes(String(pr.lastKnownPresence));
          setPresenceOf(conv.id, online, pr.lastSeen ? Number(pr.lastSeen) * (Number(pr.lastSeen) > 1e12 ? 1 : 1000) : null);
        }
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
      if (['group_join', 'group_leave', 'group_admin_changed', 'group_update'].includes(p?.event)) {
        const n = p.data ?? {};
        const id = typeof n.id === 'string' ? n.id : n.id?._serialized;
        const chat = n.chatId ?? n.id?.remote;
        if (!id || typeof chat !== 'string' || !chat.endsWith('@g.us')) return;
        await groupNotice({ id, chat, type: String(n.type ?? ''), author: n.author ?? null, recipients: n.recipientIds ?? [], body: n.body ?? '', ts: Number(n.timestamp) * 1000 }, false);
        return;
      }
      if (p?.event !== 'unread_count') return;
      const id = typeof p.data?.id === 'string' ? p.data.id : p.data?.id?._serialized;
      if (!id || skipChat(id) || typeof p.data?.unreadCount !== 'number') return;
      const jid = await resolve(id);
      if (!jid) return;
      const conv = findWaChat(jid);
      if (conv) phoneUnread(conv, p.data.unreadCount, true);
      return;
    }
    case 'chat.archive': {
      const jid = await resolve(p?.id);
      if (!jid || typeof p?.archived !== 'boolean') return;
      const conv = findWaChat(jid);
      if (!conv) return;
      kvSet(`wa_arch:${jid}`, String(p.archived));
      if (!!conv.archived !== p.archived) {
        setConversationFlags(conv.id, { archived: p.archived });
        emitConversation(conv.id);
      }
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
    case 'group.v2.join': // you joined, or made, a group
    case 'group.v2.leave': // you left or were removed
    case 'group.v2.update':
    case 'group.v2.participants':
    case 'group.v2.participants.tag':
    case 'group.join-request': {
      const id = bare(p?.group?.id ?? p?.groupId ?? p?.id);
      if (id.endsWith('@g.us')) {
        const subject = p?.group?.subject ?? p?.group?.name;
        if (subject) getOrCreateWaChat(id, subject);
        const desc = descriptionOf(p?.group);
        if (desc !== undefined) setGroupDescription(getOrCreateWaChat(id).id, desc);
        const conv = getOrCreateWaChat(id);
        if (e.event === 'group.v2.participants.tag') {
          const who = p?.participant;
          recordLabelEvent(conv.id, [idString(who?.id ?? who), idString(who?.pn)], typeof p?.tag === 'string' ? p.tag : null);
        }
        const removed = e.event === 'group.v2.leave' || (p?.type === 'leave' || p?.type === 'remove') && (p?.participants ?? []).some((x: Json) => self.isWa(bare(x?.id ?? x)));
        if (removed) dropSelfFromGroup(conv);
        else refreshGroupSoon(id);
        groupChanged(conv.id);
      }
      return;
    }
  }
}

// ---------- history ----------

let cancelRequested = false;
/** "As many as possible": per chat, as far back as WhatsApp Web has them, up to this many. */
const MAX_PER_CHAT = 20_000;
/** "Stop import" in Settings: finishes the message it's on, then stops. */
export function cancelImportWa() {
  if (importing) cancelRequested = true;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Gentle on WhatsApp Web (WEBJS runs it in a headless browser, which a burst of work can crash):
 * the plain chat list (the "overview" looks up every chat's picture at once), messages without
 * media, then each file on its own, one chat at a time. Stops when the session goes down.
 */
/** Wait (up to a few minutes) for the session to come back after WAHA restarted it. */
async function waitForSession(maxMs: number): Promise<boolean> {
  const until = Date.now() + maxMs;
  while (Date.now() < until && !cancelRequested) {
    if (state.status === 'connected') {
      await pause(Number(process.env.WAHA_RESUME_SETTLE_MS) || 20_000); // let WhatsApp Web finish starting up first
      if (state.status === 'connected') return true;
    }
    await pause(2000);
  }
  return false;
}

async function importHistory(
  progress: (done: number, total: number, waiting?: boolean) => void = () => {},
): Promise<{ chats: number; messages: number; skipped?: number }> {
  const { waHistoryChats, waHistoryMessages } = getSettings();
  cancelRequested = false;
  let chats: Json[] = [];
  for (let attempt = 0; ; attempt++) {
    try {
      chats = (await waha.chats(waHistoryChats || 5000)) ?? [];
      break;
    } catch (e) {
      if (attempt >= 2) throw e;
      await pause(5000);
    }
  }
  log.info(`whatsapp: checking ${chats.length} recent chats for history`);
  let total = 0;
  let touched = 0;
  let failures = 0;
  let chatFailures = 0;
  let restarts = 0;
  const crashedOn = new Map<string, number>(); // chat → how often WhatsApp Web went down while on it
  const skipped: string[] = [];
  progress(0, chats.length);
  for (let i = 0; i < chats.length; i++) {
    if (cancelRequested) {
      log.info('whatsapp: history import stopped');
      break;
    }
    const c = chats[i];
    const idRaw = idString(c.id);
    if (!idRaw || skipChat(idRaw)) continue;
    // WAHA restarts WhatsApp Web when it crashes: wait for it, then carry on with the same chat.
    if (state.status !== 'connected') {
      if (++restarts > 5) throw new Error('WhatsApp Web keeps restarting; stopped the import (what was imported so far is kept)');
      log.warn(`whatsapp: session went down during the import (chat ${i + 1} of ${chats.length}); waiting for it to come back`);
      progress(i, chats.length, true);
      const back = await waitForSession(5 * 60_000);
      if (cancelRequested) break;
      if (!back) throw new Error('WhatsApp disconnected during the import and did not come back; what was imported so far is kept');
    }
    progress(i, chats.length);
    const id = await resolve(idRaw);
    if (!id) continue;
    const conv = getOrCreateWaChat(id, id.endsWith('@g.us') ? c.name : null);
    if (!id.endsWith('@g.us') && c.name && !waContact(id)?.name) upsertWaContact({ jid: id, pushName: c.name });
    // In pages, newest first: one huge answer (a big group's whole history) is what makes WhatsApp
    // Web fall over. Pages overlap a little, in case new messages arrive and shift them.
    const target = waHistoryMessages || MAX_PER_CHAT;
    const PAGE = Math.min(1000, target);
    const doneKey = `wa_hist_complete:${id}`;
    let offset = 0;
    let first = true;
    let pageFailed = false;
    const newest: MessageRow[] = [];
    while (offset < target && !cancelRequested && state.status === 'connected') {
      const limit = Math.min(PAGE, target - offset);
      let page: Json[];
      try {
        page = (await waha.messages(idRaw, limit, false, offset)) ?? [];
        chatFailures = 0;
      } catch (e) {
        log.warn(`whatsapp: history for ${id}: ${(e as Error).message}`);
        pageFailed = true;
        if (state.status !== 'connected' || !(await waha.session().then((x) => x.status === 'WORKING').catch(() => false))) {
          // It took the session down. Try this chat once more after the restart, then skip it.
          const n = (crashedOn.get(id) ?? 0) + 1;
          crashedOn.set(id, n);
          if (n < 2) i--;
          else skipped.push(id);
          recheckWa(500);
          await pause(3000);
        } else {
          if (++chatFailures >= 3) throw new Error(`WAHA stopped answering (${(e as Error).message.slice(0, 120)}); what was imported so far is kept`);
          await pause(3000);
        }
        break;
      }
      const sorted = [...page].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
      let added = 0;
      for (const m of sorted) {
        if (cancelRequested || state.status !== 'connected') break;
        const row = await ingestMessage(m, { history: true }).catch((e) => {
          if (failures++ < 3) log.warn(`whatsapp: couldn't import message ${m?.id}: ${(e as Error).message}`);
          return undefined;
        });
        if (row) {
          added++;
          if (first) newest.push(row);
        }
      }
      total += added;
      if (added) touched++;
      first = false;
      if (page.length < limit) {
        kvSet(doneKey, '1'); // reached the start of what WhatsApp Web has
        break;
      }
      // Everything on this page was here already and an earlier import reached the start: done.
      if (!added && kvGet(doneKey) === '1') break;
      offset += Math.max(1, page.length - 20);
      if (page.length) await pause(200);
    }
    if (pageFailed) continue;
    // Keep WhatsApp's unread count for the chat.
    const unread = Number(c._chat?.unreadCount ?? c.unreadCount ?? c._chat?.UnreadCount ?? 0);
    if (unread > 0) {
      const incoming = newest.filter((r) => !r.outgoing).slice(-unread);
      for (const r of incoming) if (!readBefore(r.conversation_id, r.sent_ts)) updateMessage(r.id, { read: 0 });
    }
    emitConversation(conv.id);
    if (state.status !== 'connected' && !cancelRequested) {
      // Went down halfway through this chat: do the rest after the restart (once), or skip it.
      const n = (crashedOn.get(id) ?? 0) + 1;
      crashedOn.set(id, n);
      if (n < 2) i--;
      else skipped.push(id);
    }
    await pause(250);
  }
  if (skipped.length) log.warn(`whatsapp: skipped ${skipped.length} chat(s) that made WhatsApp Web crash: ${skipped.join(', ')}`);
  return { chats: touched, messages: total, ...(skipped.length ? { skipped: skipped.length } : {}) };
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

/** The other spelling of someone's id: phone number ↔ privacy id (@lid), when we know both. */
function otherId(jid: string): string | null {
  if (jid.endsWith('@lid')) {
    const pn = lidCache.get(jid) ?? kvGet(`lid:${jid}`);
    return pn || null;
  }
  if (jid.endsWith('@c.us')) {
    const lid = kvGet(`lidof:${jid}`);
    if (lid) return lid;
    const r = db.prepare<[string], { key: string }>("SELECT key FROM kv WHERE key LIKE 'lid:%' AND value = ? LIMIT 1").get(jid);
    return r ? r.key.slice(4) : null;
  }
  return null;
}

/**
 * WhatsApp Web only links a reply when it has the quoted message itself, and it may know it by
 * another spelling of the id (the chat or the sender by privacy id instead of number). Returns the id
 * it knows, or null. Remembered per message (a miss for a day).
 */
export async function linkableQuoteId(m: MessageRow): Promise<string | null> {
  if (!m.ext_id || m.ext_id.startsWith('call:')) return null;
  const cacheKey = `waquote:${m.id}`;
  const cached = kvGet(cacheKey);
  if (cached) {
    const c = JSON.parse(cached) as { id: string | null; at: number };
    if (c.id || Date.now() - c.at < 24 * 3600_000) return c.id;
  }
  if (state.status !== 'connected') return m.ext_id; // can't check: try as is
  const parts = m.ext_id.split('_');
  const candidates = new Set<string>([m.ext_id]);
  if ((parts[0] === 'true' || parts[0] === 'false') && parts.length >= 3) {
    const [fromMe, chat, raw, ...rest] = parts;
    const author = rest.join('_');
    const chats = [chat, otherId(chat)].filter((x): x is string => !!x);
    const authors = author ? [author, otherId(author)].filter((x): x is string => !!x) : [''];
    for (const c of chats) for (const a of authors) candidates.add(`${fromMe}_${c}_${raw}${a ? '_' + a : ''}`);
  }
  const conv = getConversation(m.conversation_id)!;
  const found = await Promise.all(
    [...candidates].map((id) =>
      waha
        .message(conv.wa_id!, id, false)
        .then((r) => (r && (r.id || r._data) ? id : null))
        .catch(() => null),
    ),
  );
  const id = found.find(Boolean) ?? null;
  kvSet(cacheKey, JSON.stringify({ id, at: Date.now() }));
  return id;
}

/** "> Jan: the quoted text" in WhatsApp's quote formatting, for replies WhatsApp Web can't link. */
function textQuote(q: MessageRow): string {
  const who = q.outgoing ? 'You' : nameForKey(q.author);
  const text =
    (renderBody(q.body, q.ranges)?.text ?? '').replace(/￼/g, '').trim() ||
    quotedMedia(q.conversation_id, { sentTs: q.sent_ts, author: q.author })?.label ||
    (q.attachments || q.sticker ? 'Attachment' : '');
  const short = text.length > 160 ? text.slice(0, 157).trimEnd() + '…' : text;
  const lines = short.split('\n').slice(0, 3);
  return `> *${who}:* ${lines[0] ?? ''}\n` + lines.slice(1).map((l) => `> ${l}\n`).join('') + '\n';
}

/** Send a stored pending message. Several files go out as several WhatsApp messages; the first one's id is kept. */
export async function deliverWa(
  conv: ConversationRow,
  messageId: number,
  p: { text: string; ranges?: Ranges | null; base64: string[]; quote?: { sentTs: number } | null; sticker?: unknown; preview?: LinkPreview | null; forwardOf?: string | null },
) {
  const chatId = conv.wa_id!;
  if (p.forwardOf) {
    // WhatsApp's own forward: no new upload, and the other side sees "Forwarded". The echo links our row.
    await waha.forward(chatId, p.forwardOf);
    const current = getMessage(messageId);
    emitMessage(updateMessage(messageId, { status: current && statusRank(current.status) > statusRank('sent') ? current.status! : 'sent', error: null, ts_confirmed: 1 }));
    return;
  }
  const wa = toWaText(p.text, p.ranges ?? null, jidFor);
  let reply_to: string | undefined;
  if (p.quote) {
    // A private reply quotes a message in a group: WhatsApp links it like any reply (by the group message's id).
    const quotedChat = (p.quote as { chat?: number }).chat ?? conv.id;
    const q = db.prepare<[number, number], MessageRow>('SELECT * FROM messages WHERE conversation_id = ? AND sent_ts = ?').get(quotedChat, p.quote.sentTs);
    if (q) {
      reply_to = (await linkableQuoteId(q)) ?? undefined;
      if (!reply_to) {
        // Too old for WhatsApp Web to link: quote it as text, and show the same here.
        wa.text = textQuote(q) + wa.text;
        const row = getMessage(messageId);
        if (row?.quote) emitMessage(updateMessage(messageId, { quote: JSON.stringify({ ...JSON.parse(row.quote), unlinked: true }) }));
      }
    }
  }
  let first: Json;
  if (p.sticker) throw new Error("Signal stickers can't be sent to WhatsApp");
  if (p.base64.length) {
    for (const [i, b] of p.base64.entries()) {
      const file = parseDataUrl(b);
      if (!file) continue;
      const kind = file.mimetype.startsWith('image/') && file.mimetype !== 'image/gif' ? 'sendImage' : file.mimetype.startsWith('video/') ? 'sendVideo' : 'sendFile';
      const caption = i === 0 && wa.text ? wa.text : undefined;
      const opts = { caption, reply_to: i === 0 ? reply_to : undefined, mentions: i === 0 && wa.mentions.length ? wa.mentions : undefined };
      let res: Json;
      if (file.mimetype.startsWith('audio/')) {
        // Audio (a recording, an .m4a or .mp3): as a voice message, so it plays in the chat instead of
        // being a file to download. WAHA converts it to the format WhatsApp needs. A voice message has no
        // caption: the text follows as its own message. If WAHA can't, it goes as a file, as before.
        try {
          res = await waha.sendMedia('sendVoice', chatId, file, { reply_to: opts.reply_to });
          if (caption) await waha.sendText(chatId, caption, { mentions: opts.mentions, linkPreview: true });
        } catch (e) {
          log.warn(`whatsapp: couldn't send audio as a voice message (${(e as Error).message}); sending it as a file`);
          res = await waha.sendMedia('sendFile', chatId, file, opts);
        }
      } else res = await waha.sendMedia(kind, chatId, file, opts);
      if (i === 0) first = res;
    }
  } else if (p.preview && wa.text.includes(p.preview.url) && kvGet('wa_no_custom_preview') !== '1') {
    let image: { mimetype: string; data: string } | undefined;
    if (p.preview.image && isSafeId(p.preview.image.id)) {
      try {
        image = { mimetype: p.preview.image.contentType, data: fs.readFileSync(localPath(p.preview.image.id)).toString('base64') };
      } catch {
        /* without a picture */
      }
    }
    try {
      first = await waha.linkPreview(chatId, wa.text, { url: p.preview.url, title: p.preview.title ?? p.preview.url, description: p.preview.description ?? '', ...(image ? { image } : {}) }, reply_to);
    } catch (e) {
      // WEBJS can't send our own preview ("not implemented by 'WEBJS' engine"): send it as text and let
      // WhatsApp make the preview itself, and don't try our own again.
      if (!/not implemented/i.test((e as Error).message)) throw e;
      kvSet('wa_no_custom_preview', '1');
      log.info('whatsapp: this engine cannot send custom link previews; WhatsApp makes them from now on');
      first = await waha.sendText(chatId, wa.text, { reply_to, mentions: wa.mentions.length ? wa.mentions : undefined, linkPreview: true });
    }
  } else if (p.preview && wa.text.includes(p.preview.url)) {
    first = await waha.sendText(chatId, wa.text, { reply_to, mentions: wa.mentions.length ? wa.mentions : undefined, linkPreview: true });
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

// ---------- presence (online / last seen, and yours) ----------

const presenceKnown = new Map<number, { online: boolean; lastSeen: number | null }>();
const presenceAsked = new Map<number, number>();

function setPresenceOf(conversationId: number, online: boolean, lastSeen: number | null) {
  const prev = presenceKnown.get(conversationId);
  const next = { online, lastSeen: lastSeen ?? (online ? null : prev?.lastSeen ?? null) };
  if (prev && prev.online === next.online && prev.lastSeen === next.lastSeen) return;
  presenceKnown.set(conversationId, next);
  broadcast({ type: 'presence', conversationId, ...next });
}

export function presenceFor(conv: ConversationRow) {
  return presenceKnown.get(conv.id) ?? null;
}

/** Ask once (per half minute) whether someone is online, when their chat is opened. */
export async function refreshPresenceWa(conv: ConversationRow) {
  if (conv.kind !== 'direct' || state.status !== 'connected') return;
  if (Date.now() - (presenceAsked.get(conv.id) ?? 0) < 30_000) return;
  presenceAsked.set(conv.id, Date.now());
  const r = await waha.presence(conv.wa_id!).catch(() => null);
  const pr = r?.presences?.find((x) => bare(x.participant) === conv.wa_id) ?? r?.presences?.[0];
  if (!pr) return;
  const seen = pr.lastSeen ? Number(pr.lastSeen) : null;
  setPresenceOf(conv.id, ['online', 'typing', 'recording'].includes(String(pr.lastKnownPresence)), seen ? (seen > 1e12 ? seen : seen * 1000) : null);
}

// You show as online only while a browser has Messenger Web open and in front, if you switched it on.
let lastActive = 0;
let sentPresence: 'online' | 'offline' | null = null;
export function browserActive(active: boolean) {
  lastActive = active ? Date.now() : 0;
  void applyOwnPresence();
}
async function applyOwnPresence() {
  if (state.status !== 'connected') return;
  const want = getSettings().waShowOnline && Date.now() - lastActive < 90_000 ? 'online' : 'offline';
  if (want === sentPresence) return;
  sentPresence = want;
  await waha.setPresence(want).catch(() => (sentPresence = null));
}
setInterval(() => void applyOwnPresence(), 30_000).unref();
setInterval(() => (sentPresence = null), 10 * 60_000).unref(); // say it again now and then: WhatsApp Web may change it

// ---------- contacts and your profile ----------

/** Save someone in your WhatsApp contacts (your phone's address book), or rename them there. */
export async function saveContactWa(jid: string, firstName: string, lastName: string) {
  requireWa();
  await waha.upsertContact(jid, firstName, lastName);
  upsertWaContact({ jid, name: [firstName, lastName].filter(Boolean).join(' ') || null });
}

export async function waProfile() {
  requireWa();
  const p = await waha.profile();
  return { name: p?.name ?? state.name ?? '', about: p?.status ?? '', picture: p?.picture ?? null, number: state.me ?? null };
}

export async function updateWaProfile(patch: { name?: string; about?: string; picture?: string | null }) {
  requireWa();
  if (patch.name !== undefined) {
    await waha.setProfileName(patch.name);
    setState({ ...state, name: patch.name });
  }
  if (patch.about !== undefined) await waha.setProfileStatus(patch.about);
  if (patch.picture === null) await waha.deleteProfilePicture();
  else if (patch.picture) {
    const file = parseDataUrl(patch.picture);
    if (!file) throw Object.assign(new Error('Unreadable picture'), { httpStatus: 400 });
    await waha.setProfilePicture(file);
  }
  if (patch.picture !== undefined && self.waIds[0]) {
    // our own picture is cached like everyone else's
    for (const f of [waAvatarCached(self.waIds[0])].filter(Boolean)) fs.rmSync(f!, { force: true });
  }
}

export async function archiveWa(conv: ConversationRow, on: boolean) {
  kvSet(`wa_arch:${conv.wa_id}`, String(on));
  if (state.status === 'connected') await waha.archive(conv.wa_id!, on);
}

// ---------- stickers ----------

/** Stickers you can send again: the ones you've received or sent, and imported ones. Newest first. */
export function addSticker(id: string) {
  const list = stickerLibrary().filter((s) => s.id !== id);
  list.unshift({ id, at: Date.now() });
  kvSet('wa_stickers', JSON.stringify(list.slice(0, 500)));
}
function stickerLibrary(): { id: string; at: number }[] {
  try {
    return JSON.parse(kvGet('wa_stickers') ?? '[]');
  } catch {
    return [];
  }
}
export function listStickersWa() {
  return stickerLibrary()
    .filter((s) => isSafeId(s.id) && fs.existsSync(localPath(s.id)))
    .map((s) => ({ id: s.id, url: `/api/attachments/${encodeURIComponent(s.id)}` }));
}
export function removeStickerWa(id: string) {
  kvSet('wa_stickers', JSON.stringify(stickerLibrary().filter((s) => s.id !== id)));
}

/**
 * Send a sticker: one from the library, or any image (WhatsApp Web turns it into a 512×512 sticker
 * itself, in WAHA's browser).
 */
export async function sendStickerWa(
  conv: ConversationRow,
  src: { id?: string; image?: string; path?: string; mimetype?: string },
  quote: { sentTs: number; author: string; text?: string | null } | null,
) {
  requireWa();
  let file: WaFile;
  let attachment: Attachment;
  if (src.path) {
    // A Signal pack sticker: WhatsApp gets its image (and makes a WhatsApp sticker of it).
    const buf = fs.readFileSync(src.path);
    const mimetype = src.mimetype || 'image/webp';
    const id = 'stk-' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 24) + (EXT[mimetype] ?? '.webp');
    if (!fs.existsSync(localPath(id))) fs.writeFileSync(localPath(id), buf);
    file = { mimetype, data: buf.toString('base64') };
    attachment = { id, contentType: mimetype, sticker: true, size: buf.length };
  } else if (src.id) {
    if (!isSafeId(src.id) || !fs.existsSync(localPath(src.id))) throw Object.assign(new Error('Sticker not found'), { httpStatus: 404 });
    const ext = src.id.slice(src.id.lastIndexOf('.')).toLowerCase();
    const mimetype = Object.entries(EXT).find(([, e]) => e === ext)?.[0] ?? 'image/webp';
    file = { mimetype, data: fs.readFileSync(localPath(src.id)).toString('base64') };
    attachment = { id: src.id, contentType: mimetype, sticker: true, size: fs.statSync(localPath(src.id)).size };
  } else {
    const f = src.image ? parseDataUrl(src.image) : null;
    if (!f || !f.mimetype.startsWith('image/')) throw Object.assign(new Error('Pick an image'), { httpStatus: 400 });
    file = { mimetype: f.mimetype, data: f.data };
    const buf = Buffer.from(f.data, 'base64');
    const id = 'out-' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 24) + (EXT[f.mimetype] ?? '');
    if (!fs.existsSync(localPath(id))) fs.writeFileSync(localPath(id), buf);
    attachment = { id, contentType: f.mimetype, sticker: true, size: buf.length };
  }
  const row = insertMessage({
    conversationId: conv.id,
    sentTs: Date.now(),
    author: 'self',
    outgoing: true,
    kind: 'sticker',
    body: null,
    attachments: [attachment],
    quote,
    status: 'pending',
    read: true,
  });
  if (!row) throw Object.assign(new Error('Try again'), { httpStatus: 409 });
  emitMessage(row);
  emitConversation(conv.id);
  try {
    const q = quote ? db.prepare<[number, number], MessageRow>('SELECT * FROM messages WHERE conversation_id = ? AND sent_ts = ?').get(conv.id, quote.sentTs) : undefined;
    const reply_to = q ? (await linkableQuoteId(q)) ?? undefined : undefined;
    const res = await waha.sendSticker(conv.wa_id!, file, reply_to);
    const ext = extIdOf(res);
    emitMessage(updateMessage(row.id, { status: 'sent', ts_confirmed: 1, ...(ext && !findMessageByExt(ext) ? { ext_id: ext } : {}) }));
    if (src.id) addSticker(src.id);
  } catch (e) {
    emitMessage(updateMessage(row.id, { status: 'failed', error: (e as Error).message.replace(/^WhatsApp API .*? failed \(\d+\): /, '') }));
  }
  emitConversation(conv.id);
  return getMessage(row.id)!;
}

// ---------- group system lines ----------

async function nameOfJid(raw: unknown): Promise<string> {
  const id = typeof raw === 'string' ? raw : (raw as { _serialized?: string } | null)?._serialized;
  const jid = await resolve(id);
  if (!jid) return 'Someone';
  if (self.isWa(jid)) return 'You';
  const name = nameForKey(keyFor(jid));
  return name === 'Unknown' ? waNumberOf(jid) ?? name : name;
}

function listNames(names: string[]) {
  return names.length <= 1 ? names[0] ?? 'Someone' : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

/** "Jan added Sanne", "Sanne left", "You changed the group name to …": from live events or history. */
async function groupNotice(
  n: { id: string; chat: string; type: string; author: unknown; recipients: unknown[]; body: string; ts: number },
  history: boolean,
): Promise<MessageRow | undefined> {
  if (findMessageByExt(n.id)) return; // the event and the history message are the same notification
  const chatJid = await resolve(n.chat);
  if (!chatJid) return;
  const authorId = typeof n.author === 'string' ? n.author : (n.author as { _serialized?: string } | null)?._serialized ?? null;
  const recipientIds = (n.recipients ?? []).map((r) => (typeof r === 'string' ? r : (r as { _serialized?: string })?._serialized)).filter((r): r is string => !!r);
  const A = authorId ? await nameOfJid(authorId) : 'Someone';
  const R = listNames(await Promise.all(recipientIds.map(nameOfJid)));
  const byOther = !!authorId && !recipientIds.includes(authorId);
  const many = recipientIds.length > 1;
  const quote = (s: string) => `“${s}”`;
  const text: string | null = (() => {
    switch (n.type) {
      case 'add':
        return byOther ? `${A} added ${R}` : `${R} joined`;
      case 'invite':
      case 'linked_group_join':
        return `${R} joined using this group's invite link`;
      case 'remove':
        return byOther ? `${A} removed ${R}` : `${R} left`;
      case 'leave':
        return `${R} left`;
      case 'promote':
        return R === 'You' ? "You're now an admin" : `${R} ${many ? 'are now admins' : 'is now an admin'}`;
      case 'demote':
        return R === 'You' ? "You're no longer an admin" : `${R} ${many ? 'are no longer admins' : 'is no longer an admin'}`;
      case 'subject':
        return n.body ? `${A} changed the group name to ${quote(n.body)}` : `${A} changed the group name`;
      case 'description':
        return `${A} changed the group description`;
      case 'picture':
        return `${A} changed this group's icon`;
      case 'announce':
        return n.body === 'off' ? `${A} changed this group's settings to allow all members to send messages` : `${A} changed this group's settings to allow only admins to send messages`;
      case 'restrict':
        return n.body === 'off' ? `${A} changed this group's settings to allow all members to edit this group's info` : `${A} changed this group's settings to allow only admins to edit this group's info`;
      case 'create':
        return n.body ? `${A} created group ${quote(n.body)}` : `${A} created this group`;
      default:
        return null;
    }
  })();
  if (!text) return;
  const conv = getOrCreateWaChat(chatJid);
  const author = authorId ? (self.isWa(authorId) ? 'self' : keyFor((await resolve(authorId)) ?? authorId)) : 'unknown';
  const row = insertMessage({
    conversationId: conv.id,
    sentTs: freeTimestamp(conv.id, n.ts || Date.now(), author),
    author,
    outgoing: false, // a system line, even when you did it (no ticks)
    kind: 'system',
    body: text,
    read: true,
    extId: n.id,
  });
  if (row && !history) {
    emitMessage(row);
    emitConversation(conv.id);
    refreshGroupSoon(chatJid);
  }
  return row;
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
    outgoing: false,
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
/** The cached picture right away, however old (waAvatar refreshes it in the background). */
export function waAvatarCached(jid: string): string | null {
  const file = path.join(avatarDir, 'wa-' + crypto.createHash('sha256').update(jid).digest('hex').slice(0, 32));
  return fs.existsSync(file) ? file : null;
}

/** A picture was changed here: drop the cached copy (and bump its URL so browsers do too). */
export function forgetWaAvatar(jid: string) {
  const file = path.join(avatarDir, 'wa-' + crypto.createHash('sha256').update(jid).digest('hex').slice(0, 32));
  for (const f of [file, file + '.none', file + '.fail']) fs.rmSync(f, { force: true });
  kvSet(`wa_avatar_rev:${jid}`, String(Number(kvGet(`wa_avatar_rev:${jid}`) ?? 0) + 1));
}

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

/** Start (or open) a WhatsApp chat with a phone number, after checking the number is on WhatsApp. */
export async function waChatForNumber(number: string): Promise<ConversationRow> {
  const digits = number.replace(/\D/g, '');
  const existing = findWaChat(`${digits}@c.us`);
  if (existing?.last_message_at || state.status !== 'connected') return existing ?? getOrCreateWaChat(`${digits}@c.us`);
  const r = await waha.checkExists(digits);
  if (!r?.numberExists) throw Object.assign(new Error(`${number} isn't on WhatsApp`), { httpStatus: 400 });
  const jid = (await resolve(r.chatId ?? `${digits}@c.us`)) ?? `${digits}@c.us`;
  return getOrCreateWaChat(jid);
}

export async function blockWa(conv: ConversationRow, block: boolean) {
  await (block ? waha.block(conv.wa_id!) : waha.unblock(conv.wa_id!));
  setWaBlocked(conv.wa_id!, block);
}

export { findWaChat as findWaChatExport };
