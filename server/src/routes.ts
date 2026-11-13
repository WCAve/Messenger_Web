/**
 * The HTTP API, one route per thing the browser does. Groups of routes, in order: sign-in and session,
 * Signal and WhatsApp status/linking, settings, WhatsApp history and Android backup import, pictures
 * (avatars, stickers), the chat list and messages (send, edit, delete, react, read, flags), files,
 * profiles, stickers and the sticker manager, search. Group management is in groups.ts (groupRoutes).
 *
 * Conventions: `conv(ctx)` loads the chat from :id or 404s; `isWa(c)` picks the network; WhatsApp work
 * goes through `wa(() => …)` (a clear error when WhatsApp isn't connected); every change is pushed to
 * open browsers with emitConversation / broadcast. Sending: the message is stored as `pending` first
 * (queueOutgoing) and delivered in the background, so the browser shows it at once.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fetchAttachment, isSafeId, localPath, newOutgoingId, saveOutgoing } from './attachments.js';
import { TooBig, canConvert, convertForSending, needsConverting, videoConversion } from './convert.js';
import { cancelUpload, receivePiece, startUpload, takeUpload } from './uploads.js';
import { getAvatar, invalidateAvatar, readAvatar } from './avatars.js';
import { getSettings, updateSettings } from './settings.js';
import { getManifest, getStickerImage, isPackId, listPacks, parsePackLink, refreshPacks } from './stickers.js';
import { applyPendingReceipts, humanDuration } from './ingest.js';
import { type Ranges, cleanRanges, toApiMarkup } from './richtext.js';
import { linkPreview } from './linkpreview.js';
import { emojiIn, emojiUsage, recordAlias, recordEmoji } from './emojiusage.js';
import { waha } from './waha-api.js';
import { groupRoutes } from './groups.js';
import { addImages, createPack, deletePack, forgetStickers, localStickers, stickerMime, updatePack } from './stickerpacks.js';
import { importStickersFromFolder, backupDir, backupFileInfo, backupMediaWaiting, cancelBackupImport, receiveBackupUpload, refreshBackupInfo, startBackupImport, startMediaScan } from './wabackup.js';
import {
  createPollWa,
  deleteWa,
  deliverWa,
  editWa,
  getWaState,
  importHistoryNow,
  catchUpWaNow,
  logoutWhatsApp,
  markReadWa,
  noteWaRead,
  markUnreadWa,
  archiveWa,
  browserActive,
  findWaChatExport as findWaChat,
  listStickersWa,
  presenceFor,
  refreshPresenceWa,
  removeStickerWa,
  saveContactWa,
  sendStickerWa,
  updateWaProfile,
  waProfile,
  linkableQuoteId,
  downloadPendingMedia,
  cancelImportWa,
  blockWa,
  refreshGroupInfoWa,
  waAbout,
  reactWa,
  refreshDirectory as refreshWaDirectory,
  restartWhatsApp,
  subscribePresenceWa,
  typingWa,
  voteWa,
  waAvatar,
  waAvatarCached,
  waChatForNumber,
} from './whatsapp.js';
import {
  SESSION_COOKIE,
  clearLoginFailures,
  createSession,
  activeSessionCount,
  destroyAllSessions,
  destroySession,
  isValidSession,
  loginBlocked,
  passwordMatches,
  recordLoginFailure,
} from './auth.js';
import { config } from './config.js';
import { addClient, broadcast, closeAllClients, stallAllClients } from './events.js';
import { type Ctx, HttpError, Router, sendFile, setCookie } from './http.js';
import { getState, recheckSoon, refreshDirectory } from './signal.js';
import { groupRecipientId, sentTimestamp, signalApi } from './signal-api.js';
import {
  type Attachment,
  type ConversationRow,
  type LinkPreview,
  type Poll,
  pinnedCount,
  setPinnedOrder,
  setConversationFlags,
  getOrCreateWaChat,
  listWaContacts,
  type Reaction,
  addressForKey,
  contactByKeyOrId,
  conversationDto,
  conversationInfo,
  conversationMedia,
  getConversation,
  getMessage,
  getSelfProfile,
  setSelfProfile,
  getOrCreateDirect,
  insertMessage,
  listContacts,
  listConversationRows,
  listConversations,
  listGroups,
  listMessages,
  listMessagesAfter,
  listMessagesAround,
  messageNearDate,
  markConversationRead,
  renderBody,
  searchMessages,
  setConversationTimer,
  messageDto,
  messageEdits,
  quoteFor,
  deletedContent,
  messageReceipts,
  recipientFor,
  self,
  unreadMessages,
  updateMessage,
} from './store.js';

export const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.pdf': 'application/pdf',
};

const EDIT_WINDOW_MS = 24 * 3600_000 - 60_000; // Signal's limit is 24 h; keep a minute of margin

function emitConversation(conv: ConversationRow) {
  broadcast({ type: 'conversation', conversation: conversationDto(conv) });
}

/** Run a WhatsApp action, turning its errors into HTTP errors. */
async function wa<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as Error & { httpStatus?: number };
    if (err instanceof HttpError) throw err;
    throw new HttpError(err.httpStatus ?? 502, err.message.replace(/^WhatsApp API .*? failed \(\d+\): /, 'WhatsApp: '));
  }
}

const isWa = (c: ConversationRow) => c.network === 'whatsapp';

/** The Signal account, or (for a WhatsApp chat) a check that WhatsApp is connected. */
function accountFor(c: ConversationRow): string {
  if (isWa(c)) {
    if (getWaState().status !== 'connected') throw new HttpError(503, 'WhatsApp is not connected');
    return '';
  }
  return requireAccount();
}

function requireAccount(): string {
  const st = getState();
  if (st.status !== 'connected' && st.status !== 'connecting') throw new HttpError(503, 'Signal is not connected');
  return self.number!;
}

function conv(ctx: Ctx): ConversationRow {
  const c = getConversation(Number(ctx.params.id));
  if (!c) throw new HttpError(404, 'Conversation not found');
  return c;
}

function message(ctx: Ctx) {
  const m = getMessage(Number(ctx.params.id));
  if (!m) throw new HttpError(404, 'Message not found');
  return m;
}

function emitMessageRow(id: number, fields: Parameters<typeof updateMessage>[1]) {
  const updated = updateMessage(id, fields);
  if (updated) broadcast({ type: 'message', message: messageDto(updated) });
  return updated;
}

/**
 * Message text from the browser: plain text (U+FFFC where a mention goes) with style and mention
 * ranges. Returns what to store and what to hand the Signal API.
 */
function richInput(body: Json): { text: string; ranges: Ranges | null } {
  const raw = String(body?.text ?? '');
  // Trim, moving the ranges along with the text.
  const lead = raw.length - raw.trimStart().length;
  const text = raw.trim();
  const shift = (list: unknown) =>
    Array.isArray(list) ? list.map((r) => (r && typeof r === 'object' ? { ...r, start: (r as { start: number }).start - lead } : r)) : undefined;
  const ranges = cleanRanges(text, { mentions: shift(body?.mentions), styles: shift(body?.styles) });
  if (ranges?.mentions) {
    for (const m of ranges.mentions) {
      if (m.key !== 'self' && !m.key.startsWith('wa:') && !contactByKeyOrId(m.key)) throw new HttpError(400, 'Unknown person in a mention');
    }
  }
  return { text, ranges };
}

/** Fields of a /v2/send call for this text: styled markup and mention positions. */
function apiText(text: string, ranges: Ranges | null) {
  const mentions = ranges?.mentions?.map((m) => ({ start: m.start, length: m.length, author: addressForKey(m.key) }));
  const styled = ranges?.styles?.length ? toApiMarkup(text, ranges.styles) : null;
  return {
    message: styled ? styled.message : text,
    text_mode: styled ? ('styled' as const) : undefined,
    mentions: mentions?.length ? mentions : undefined,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

function sniffImage(file: string): string {
  const b = fs.readFileSync(file).subarray(0, 12);
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return 'application/octet-stream';
}

/** The API wants an https URL that appears in the message, and a title. */
function apiPreview(p: LinkPreview | null | undefined, message: string) {
  if (!p || !p.url.startsWith('https://') || !message.includes(p.url)) return undefined;
  let thumb = '';
  if (p.image && isSafeId(p.image.id)) {
    try {
      thumb = `data:${p.image.contentType};base64,${fs.readFileSync(localPath(p.image.id)).toString('base64')}`;
    } catch {
      /* send without a picture */
    }
  }
  return { url: p.url, title: p.title || new URL(p.url).hostname, description: p.description ?? '', ...(thumb ? { base64_thumbnail: thumb } : {}) };
}

interface Outgoing {
  text: string;
  ranges: Ranges | null;
  attachments: Attachment[];
  base64: string[];
  quote: { sentTs: number; author: string; text?: string | null } | null;
  sticker: { packId: string; stickerId: number } | null;
  preview: LinkPreview | null;
  forwardOf?: string | null; // WhatsApp message id to forward natively
}

/** Store a message as pending, show it everywhere, and send it in the background. */
function queueOutgoing(account: string, c: ConversationRow, o: Outgoing, log: (m: string) => void) {
  const now = Date.now();
  const pending = insertMessage({
    conversationId: c.id,
    sentTs: now,
    author: 'self',
    authorNumber: account,
    outgoing: true,
    kind: o.sticker ? 'sticker' : 'message',
    body: o.text || null,
    ranges: o.ranges,
    attachments: o.attachments,
    quote: o.quote,
    status: 'pending',
    read: true,
    sticker: o.sticker,
    preview: o.preview,
    forwarded: o.forwardOf ? 1 : 0,
    // signal-cli applies the chat's disappearing timer to everything it sends.
    expiresIn: c.expire_timer || 0,
    expiresAt: c.expire_timer ? now + c.expire_timer * 1000 : null,
  });
  if (!pending) throw new HttpError(409, 'Duplicate message, try again');
  const dto = messageDto(pending);
  broadcast({ type: 'message', message: dto });
  emitConversation(getConversation(c.id)!);
  void deliver(account, c, pending.id, o, log);
  return dto;
}

/** Fetch (or reuse) the preview for a link in the message, and keep its picture as a local file. */
async function previewFor(url: unknown, text: string): Promise<LinkPreview | null> {
  if (typeof url !== 'string' || !url.startsWith('https://') || !text.includes(url) || !getSettings().sendLinkPreviews) return null;
  const p = await linkPreview(url);
  if (!p) return null;
  let image: Attachment | null = null;
  if (p.image) {
    const buf = Buffer.from(p.image.data, 'base64');
    image = { id: saveOutgoing(buf, p.image.type, 'preview' + (MIME_EXT[p.image.type] ?? '')), contentType: p.image.type, size: buf.length };
  }
  return { url: p.url, title: p.title, description: p.description, image };
}

const MIME_EXT: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

/** Picture URLs end in .jpg/.webp (so firewalls see them as files); older links don't. */
const noExt = (s: string) => s.replace(/\.(jpg|webp)$/, '');

function readBase64(a: Attachment) {
  return `data:${a.contentType};filename=${(a.filename ?? 'file').replace(/[;,\r\n/\\]/g, '_')};base64,${fs.readFileSync(localPath(a.id)).toString('base64')}`;
}

/**
 * Files the networks can't take as they are (iPhone photos, odd video formats, huge photos, videos too
 * big to send) are converted first (convert.ts), working from the stored file; the stored message then
 * shows the converted file. The message stays "pending" meanwhile. An empty entry in `base64` (LAZY)
 * means "read it from the stored file": big uploads are only turned into text here, after shrinking.
 * Throws TooBig when a file can't be sent at all.
 */
const LAZY = '';
async function makeSendable<P extends { base64: string[] }>(messageId: number, payload: P, log: (m: string) => void, limitMb: number): Promise<P> {
  if (!payload.base64.length) return payload;
  const row = getMessage(messageId);
  const atts: Attachment[] = row?.attachments ? JSON.parse(row.attachments) : [];
  if (atts.length !== payload.base64.length) return payload;
  const limit = limitMb * 1024 * 1024;
  const base64 = [...payload.base64];
  let changed = false;
  for (const [i, a] of atts.entries()) {
    const file = localPath(a.id);
    const size = fs.statSync(file).size;
    if (needsConverting(a.contentType, a.filename ?? '', size, limit)) {
      const out = await convertForSending({ file, type: a.contentType, name: a.filename ?? 'file', size }, log, limit);
      if (out) {
        const id = saveOutgoing(out.buf, out.type, out.name);
        if (size > limit && a.id.startsWith('out-')) fs.rmSync(file, { force: true }); // an upload too big to ever send
        atts[i] = { ...a, id, contentType: out.type, filename: out.name, size: out.buf.length };
        base64[i] = `data:${out.type};filename=${out.name};base64,${out.buf.toString('base64')}`;
        changed = true;
        continue;
      }
    }
    if (size > limit) throw new TooBig(`${a.filename ?? 'This file'} is too big to send (${(size / 1024 / 1024).toFixed(0)} MB; at most ${limitMb} MB)`);
    if (base64[i] === LAZY) base64[i] = readBase64(a);
  }
  if (changed) emitMessageRow(messageId, { attachments: JSON.stringify(atts) });
  return { ...payload, base64 };
}

async function deliver(
  account: string,
  c: ConversationRow,
  messageId: number,
  payload: {
    text: string;
    ranges?: Ranges | null;
    base64: string[];
    quote?: { sentTs: number; author: string; text?: string | null } | null;
    sticker?: { packId: string; stickerId: number } | null;
    preview?: LinkPreview | null;
    forwardOf?: string | null;
  },
  log: (m: string) => void,
) {
  try {
    payload = await makeSendable(messageId, payload, log, isWa(c) ? config.waSendLimitMb : config.sendLimitMb);
  } catch (e) {
    log(`send: ${(e as Error).message}`);
    emitMessageRow(messageId, { status: 'failed', error: e instanceof TooBig ? e.message : `Couldn't prepare the file: ${(e as Error).message}` });
    emitConversation(getConversation(c.id)!);
    return;
  }
  if (isWa(c)) {
    try {
      await deliverWa(c, messageId, payload);
    } catch (e) {
      log(`whatsapp send failed: ${(e as Error).message}`);
      emitMessageRow(messageId, { status: 'failed', error: (e as Error).message.replace(/^WhatsApp API .*? failed \(\d+\): /, '') });
    }
    emitConversation(getConversation(c.id)!);
    return;
  }
  try {
    const text = apiText(payload.text, payload.ranges ?? null);
    const res = await signalApi.send({
      number: account,
      recipients: [recipientFor(c)],
      ...text,
      link_preview: apiPreview(payload.preview, text.message),
      base64_attachments: payload.base64.length ? payload.base64 : undefined,
      quote_timestamp: payload.quote?.sentTs,
      quote_author: payload.quote ? addressForKey(payload.quote.author) : undefined,
      quote_message: payload.quote ? payload.quote.text ?? '' : undefined,
      sticker: payload.sticker ? `${payload.sticker.packId}:${payload.sticker.stickerId}` : undefined,
    });
    const ts = sentTimestamp(res);
    if (!ts) log(`send: no timestamp in Signal API response ${JSON.stringify(res)?.slice(0, 200)}`);
    emitMessageRow(messageId, { status: 'sent', error: null, ...(ts ? { sent_ts: ts, ts_confirmed: 1 } : {}) });
    applyPendingReceipts(messageId); // receipts that arrived while the send was still running
  } catch (e) {
    log(`send failed: ${(e as Error).message}`);
    emitMessageRow(messageId, { status: 'failed', error: (e as Error).message });
  }
  emitConversation(getConversation(c.id)!);
}

function settingsDto() {
  const st = getState();
  return {
    ...getSettings(),
    account: st.account ?? self.number ?? null,
    status: st.status,
    apiVersion: st.apiVersion ?? null,
    deviceName: config.deviceName,
    giphyConfigured: !!config.giphyApiKey,
    sessions: activeSessionCount(),
  };
}

/**
 * Marks a chat read here and returns the job that tells the other side (read receipts, and clearing a
 * "marked unread" on the phone), or null when there's nothing to send.
 */
function markRead(c: ConversationRow): (() => Promise<void>) | null {
  if (isWa(c)) noteWaRead(c.id); // later copies of anything before this count as read
  const unread = unreadMessages(c.id);
  const wasMarked = !!c.marked_unread;
  if (wasMarked) setConversationFlags(c.id, { markedUnread: false });
  if (!unread.length) {
    if (!wasMarked) return null;
    emitConversation(getConversation(c.id)!);
    // Opening a chat you marked as unread on your phone clears the mark there too.
    if (isWa(c) && getSettings().sendReadReceipts && getWaState().status === 'connected') return () => markReadWa(c, []).catch(() => {});
    return null;
  }
  markConversationRead(c.id);
  emitConversation(getConversation(c.id)!);
  if (isWa(c)) {
    if (getSettings().sendReadReceipts && getWaState().status === 'connected') return () => markReadWa(c, unread).catch(() => {});
    return null;
  }
  const account = self.number;
  if (!getSettings().sendReadReceipts || !account || getState().status !== 'connected') return null;
  return async () => {
    for (const m of unread.slice(-30)) {
      if (m.author === 'self') continue;
      try {
        await signalApi.receipt(account, { recipient: addressForKey(m.author), receipt_type: 'read', timestamp: m.sent_ts });
      } catch {
        /* receipts are best effort */
      }
    }
  };
}

export function buildRouter(log: (level: 'info' | 'warn' | 'error', msg: string) => void) {
  const r = new Router({
    bodyLimit: Math.ceil(config.maxUploadMb * 1.4 * 1024 * 1024) + 1024 * 1024, // base64 overhead
    isAuthed: (ctx) => isValidSession(ctx.cookies[SESSION_COOKIE]),
    log,
    trustProxy: true,
  });

  // ---------- session (no auth) ----------

  r.get('/healthz', () => ({ ok: true }), false);

  r.get('/api/session', (ctx) => ({ authenticated: isValidSession(ctx.cookies[SESSION_COOKIE]) }), false);

  r.post(
    '/api/login',
    (ctx) => {
      const wait = loginBlocked(ctx.ip);
      if (wait) throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.`);
      const pw = ctx.body?.password;
      if (typeof pw !== 'string' || !passwordMatches(pw)) {
        recordLoginFailure(ctx.ip);
        log('warn', `failed login from ${ctx.ip}`);
        throw new HttpError(401, 'Wrong password');
      }
      clearLoginFailures(ctx.ip);
      const { token, expires } = createSession();
      setCookie(ctx.res, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Strict', secure: config.secureCookies, expires });
      return { ok: true };
    },
    false,
  );

  r.post(
    '/api/logout',
    (ctx) => {
      destroySession(ctx.cookies[SESSION_COOKIE]);
      setCookie(ctx.res, SESSION_COOKIE, '', { expires: new Date(0), httpOnly: true, sameSite: 'Strict' });
      return { ok: true };
    },
    false,
  );

  // ---------- authenticated ----------

  if (process.env.E2E_HOOKS === '1') r.post('/api/test/stall-events', () => (stallAllClients(), { ok: true }));

  r.get('/api/events', (ctx) => {
    addClient(ctx.req, ctx.res, [
      { type: 'state', state: getState() },
      { type: 'wastate', state: getWaState() },
    ]);
  });

  r.get('/api/state', () => getState());

  // ---------- WhatsApp (WAHA) ----------

  r.get('/api/whatsapp', () => getWaState());
  r.get('/api/whatsapp/qr', async (ctx) => {
    if (getWaState().status !== 'scan_qr') throw new HttpError(409, 'WhatsApp is not waiting for a QR scan');
    const png = await wa(() => waha.qr());
    ctx.res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
    ctx.res.end(png);
  });
  r.post('/api/whatsapp/logout', async () => {
    await wa(() => logoutWhatsApp());
    return getWaState();
  });
  r.post('/api/whatsapp/restart', async () => {
    await wa(() => restartWhatsApp());
    return getWaState();
  });
  r.post('/api/whatsapp/import', async () => wa(async () => importHistoryNow()));
  r.post('/api/whatsapp/catch-up', async () => wa(async () => catchUpWaNow()));
  r.post('/api/whatsapp/import/cancel', () => (cancelImportWa(), { ok: true }));

  // Android backup (msgstore.db.crypt15 + the 64-digit key), then optionally the media folder.
  r.get('/api/whatsapp/backup', () => {
    refreshBackupInfo();
    return { file: backupFileInfo(), folder: backupDir, mediaWaiting: backupMediaWaiting() };
  });
  r.upload('/api/whatsapp/backup/upload', (ctx) => receiveBackupUpload(ctx));
  r.post('/api/whatsapp/backup/import', (ctx) => startBackupImport(typeof ctx.body?.key === 'string' ? ctx.body.key : undefined, ctx.body?.labelsOnly === true));
  r.post('/api/whatsapp/backup/media', () => startMediaScan());
  r.post('/api/whatsapp/backup/cancel', () => (cancelBackupImport(), { ok: true }));
  r.post('/api/whatsapp/refresh', async () => {
    await wa(() => refreshWaDirectory());
    return { ok: true };
  });
  r.get('/api/avatars/wa/:jid', async (ctx) => {
    // Pictures come from WhatsApp Web, which can be busy for a minute (with many groups). Never keep the
    // browser waiting long: it has only a few connections to us, and the rest of the app needs them.
    const jid = noExt(ctx.params.jid);
    const stale = waAvatarCached(jid);
    const lookup = waAvatar(jid);
    const file = stale ?? (await Promise.race([lookup, new Promise<null>((r) => setTimeout(() => r(null), 2500))]));
    if (!file) throw new HttpError(404, 'No picture');
    return sendFile(ctx.res, file, { 'content-type': sniffImage(file), 'cache-control': 'private, max-age=86400' }, ctx.req.method === 'HEAD');
  });

  // ---------- your Signal profile ----------
  const selfAvatarId = () => self.uuid || self.number!;
  const profileDto = () => {
    const p = getSelfProfile();
    return {
      known: !!p,
      givenName: p?.givenName ?? '',
      familyName: p?.familyName ?? '',
      about: p?.about ?? '',
      avatar: p?.hasAvatar ? `/api/avatars/self.jpg?v=${Date.now()}` : null,
    };
  };
  r.get('/api/profile', async () => {
    requireAccount();
    if (!getSelfProfile()) await refreshDirectory().catch(() => {});
    return profileDto();
  });
  r.get('/api/avatars/self', (ctx) => sendAvatar(ctx, 'profile', selfAvatarId()));
  r.get('/api/avatars/self.jpg', (ctx) => sendAvatar(ctx, 'profile', selfAvatarId()));

  // Body: { givenName, about, avatar }. avatar: base64 image = new picture, null = remove, absent = keep.
  r.post('/api/profile', async (ctx) => {
    const account = requireAccount();
    const givenName = String(ctx.body?.givenName ?? '').trim();
    const about = typeof ctx.body?.about === 'string' ? ctx.body.about.trim().slice(0, 140) : undefined;
    if (!givenName) throw new HttpError(400, 'Signal needs at least a first name.');
    if (givenName.length > 26) throw new HttpError(400, 'Signal allows at most 26 characters for a first name.');
    const current = getSelfProfile();
    let base64: string | undefined;
    if (typeof ctx.body?.avatar === 'string') {
      base64 = ctx.body.avatar;
    } else if (ctx.body?.avatar === undefined && current?.hasAvatar) {
      // The Signal API removes the picture unless we send it again, so re-send the current one.
      const buf = await readAvatar(account, 'profile', selfAvatarId());
      if (!buf) throw new HttpError(409, "Couldn't read your current profile picture to keep it. Choose a picture again, or remove it.");
      base64 = buf.toString('base64');
    }
    await signalApi.updateProfile(account, { name: givenName, about, base64_avatar: base64 });
    setSelfProfile({ givenName, familyName: current?.familyName ?? '', about: about ?? current?.about ?? '', hasAvatar: !!base64 });
    invalidateAvatar('profile', selfAvatarId());
    log('info', 'profile updated');
    return profileDto();
  });

  // Change (base64) or remove (null) a group's picture. Signal decides who may (usually admins).
  r.post('/api/conversations/:id/avatar', async (ctx) => {
    const c = conv(ctx);
    if (isWa(c)) throw new HttpError(400, 'Change WhatsApp group pictures on your phone');
    const account = requireAccount();
    if (c.kind !== 'group') throw new HttpError(400, "You can only change a group's picture here");
    const data = ctx.body?.avatar;
    if (typeof data !== 'string' || !data) throw new HttpError(400, 'Choose a picture');
    const gid = groupRecipientId(c.group_id!);
    try {
      await signalApi.updateGroup(account, gid, { base64_avatar: data });
    } catch (e) {
      const msg = (e as Error).message;
      throw new HttpError(400, /permission|not allowed|admin/i.test(msg) ? 'Only group admins can change the picture of this group.' : msg.replace(/^.*?failed \(\d+\): /, ''));
    }
    invalidateAvatar('group', gid);
    emitConversation(c);
    return conversationDto(c);
  });

  r.get('/api/settings', async () => ({ ...settingsDto(), videoConversion: await videoConversion() }));
  r.post('/api/settings', async (ctx) => {
    updateSettings(ctx.body ?? {});
    if (ctx.body?.waHistoryMedia === true) void downloadPendingMedia().catch(() => {});
    return { ...settingsDto(), videoConversion: await videoConversion() };
  });

  // Sign out every browser (all sessions), including this one.
  r.post('/api/logout-all', (ctx) => {
    destroyAllSessions();
    closeAllClients();
    setCookie(ctx.res, SESSION_COOKIE, '', { expires: new Date(0), httpOnly: true, sameSite: 'Strict' });
    log('info', 'all sessions signed out');
    return { ok: true };
  });

  // Settings the UI needs. The Giphy key is meant to be used from the browser (Giphy's terms).
  r.get('/api/config', () => ({ giphyApiKey: config.giphyApiKey, giphyRating: config.giphyRating }));

  r.get('/api/link/qr', async (ctx) => {
    if (getState().status !== 'unlinked') throw new HttpError(409, 'Already linked');
    const png = await signalApi.linkQr(config.deviceName);
    recheckSoon();
    ctx.res.setHeader('content-type', 'image/png');
    ctx.res.setHeader('cache-control', 'no-store');
    return png;
  });

  r.get('/api/conversations', () => listConversations());

  r.get('/api/conversations/:id', (ctx) => conversationDto(conv(ctx)));

  r.get('/api/conversations/:id/info', async (ctx) => {
    let c = conv(ctx);
    // WhatsApp: fetch the group description fresh (it can be missing from the bulk group list).
    if (isWa(c) && c.kind === 'group') {
      await Promise.race([refreshGroupInfoWa(c), new Promise((r) => setTimeout(r, 6000))]);
      c = getConversation(c.id)!;
    }
    const info = conversationInfo(c);
    if (isWa(c) && c.kind === 'direct') info.about = await waAbout(c.wa_id!);
    return info;
  });

  // Can WhatsApp link a reply to this message? (Old ones from a backup: WhatsApp Web may not have them.)
  // Edit history: earlier versions of a message, newest first.
  r.get('/api/messages/:id/edits', (ctx) => {
    const m = getMessage(Number(ctx.params.id));
    if (!m) throw new HttpError(404, 'Message not found');
    return { current: messageDto(m), earlier: messageEdits(m.id) };
  });

  // What a deleted message said: someone else's deletion, or a disappearing message (kept from 10 Nov 2026)
  r.get('/api/messages/:id/deleted', (ctx) => {
    const m = getMessage(Number(ctx.params.id));
    const d = m && deletedContent(m.id);
    if (!d) throw new HttpError(404, 'Not kept');
    return d;
  });

  r.get('/api/messages/:id/replyable', async (ctx) => {
    const m = message(ctx);
    const c = getConversation(m.conversation_id)!;
    if (!isWa(c) || getWaState().status !== 'connected') return { linkable: true };
    return { linkable: !!(await linkableQuoteId(m)) };
  });

  r.get('/api/messages/:id/info', (ctx) => {
    const m = message(ctx);
    if (!m.outgoing) throw new HttpError(400, 'Only your own messages have delivery info');
    return { message: messageDto(m), recipients: messageReceipts(m) };
  });

  // Stickers
  // Signal's packs (when Signal is set up) and the packs made in the sticker manager.
  r.get('/api/stickers', async () => {
    const account = self.number;
    const packs = account && getState().status === 'connected' ? await listPacks(account, (m) => log('warn', m)).catch(() => []) : [];
    return { packs, local: localStickers() };
  });
  r.post('/api/stickers/local', (ctx) => createPack(ctx.body?.title, ctx.body?.ids));
  r.post('/api/stickers/local/:id', (ctx) => updatePack(ctx.params.id, ctx.body ?? {}));
  r.delete('/api/stickers/local/:id', (ctx) => deletePack(ctx.params.id));
  r.post('/api/stickers/forget', (ctx) => forgetStickers(ctx.body?.ids));
  r.post('/api/stickers/images', (ctx) => addImages(ctx.body?.images, typeof ctx.body?.packId === 'string' ? ctx.body.packId : undefined));

  // A sticker from your own packs: a WhatsApp sticker in WhatsApp chats, a picture in Signal chats.
  r.post('/api/conversations/:id/local-sticker', async (ctx) => {
    const c = conv(ctx);
    const id = String(ctx.body?.id ?? '');
    if (!isSafeId(id) || !fs.existsSync(localPath(id))) throw new HttpError(404, 'Sticker not found');
    const quote = quoteFor(c, ctx.body?.quoteId ? getMessage(Number(ctx.body.quoteId)) : undefined);
    if (isWa(c)) return messageDto(await wa(() => sendStickerWa(c, { id }, quote)));
    const account = accountFor(c);
    const att: Attachment = { id, contentType: stickerMime(id), size: fs.statSync(localPath(id)).size };
    return queueOutgoing(account, c, { text: '', ranges: null, attachments: [att], base64: [readBase64(att)], quote, sticker: null, preview: null }, (m) => log('warn', m));
  });

  r.post('/api/stickers/packs', async (ctx) => {
    const account = requireAccount();
    const link = parsePackLink(String(ctx.body?.link ?? ''));
    if (!link) throw new HttpError(400, 'Paste a signal.art/addstickers link (it contains pack_id and pack_key).');
    await signalApi.addStickerPack(account, link.packId, link.packKey);
    await refreshPacks(account, true);
    const m = await getManifest(account, link.packId).catch(() => null);
    if (!m) throw new HttpError(502, 'The pack was added, but its stickers could not be downloaded from Signal yet. Try again in a minute.');
    return { packs: await listPacks(account, (msg) => log('warn', msg)) };
  });

  r.get('/api/stickers/:packId/:stickerId', async (ctx) => {
    const account = self.number;
    const id = Number(noExt(ctx.params.stickerId));
    let found: { file: string; type: string } | null = null;
    try {
      found = account ? await getStickerImage(account, ctx.params.packId, id) : null;
    } catch (e) {
      log('warn', `sticker ${ctx.params.packId}/${id}: ${(e as Error).message}`);
    }
    if (!found) {
      ctx.res.writeHead(404, { 'cache-control': 'private, max-age=300', 'content-type': 'text/plain' });
      return ctx.res.end('Sticker not available');
    }
    sendFile(ctx.res, found.file, { 'content-type': found.type, 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
  });

  // Avatars (proxied from the Signal API and cached on disk)
  const sendAvatar = async (ctx: Ctx, kind: 'profile' | 'group', id: string | null | undefined) => {
    const account = self.number;
    const found = account && id ? await getAvatar(account, kind, id) : null;
    if (!found) {
      ctx.res.writeHead(404, { 'cache-control': 'private, max-age=3600', 'content-type': 'text/plain' });
      return ctx.res.end('No avatar');
    }
    sendFile(ctx.res, found.file, { 'content-type': found.type, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' });
  };
  r.get('/api/avatars/conversation/:id', (ctx) => {
    ctx.params.id = noExt(ctx.params.id);
    const c = conv(ctx);
    if (c.kind === 'group') return sendAvatar(ctx, 'group', groupRecipientId(c.group_id!));
    return sendAvatar(ctx, 'profile', c.peer_uuid || c.peer_number);
  });
  r.get('/api/avatars/contact/:key', (ctx) => {
    const c = contactByKeyOrId(noExt(ctx.params.key));
    return sendAvatar(ctx, 'profile', c?.uuid || c?.number);
  });

  r.post('/api/conversations', async (ctx) => {
    const number = typeof ctx.body?.number === 'string' ? ctx.body.number.replace(/[\s()-]/g, '') : undefined;
    const uuid = typeof ctx.body?.uuid === 'string' ? ctx.body.uuid : undefined;
    if (number && !/^\+[1-9]\d{6,14}$/.test(number)) {
      throw new HttpError(400, 'Enter the number in international format, e.g. +31612345678');
    }
    if (ctx.body?.network === 'whatsapp') {
      const jid = typeof ctx.body?.jid === 'string' ? ctx.body.jid : null;
      if (jid && /^[\w.:-]+@(c\.us|lid|g\.us)$/.test(jid)) return conversationDto(getOrCreateWaChat(jid));
      if (!number) throw new HttpError(400, 'number required');
      return conversationDto(await wa(() => waChatForNumber(number)));
    }
    if (!number && !uuid) throw new HttpError(400, 'number or uuid required');
    return conversationDto(getOrCreateDirect(uuid ?? null, number ?? null));
  });

  r.get('/api/directory', () => ({ contacts: listContacts(), groups: listGroups(), waContacts: listWaContacts() }));

  r.post('/api/directory/refresh', async () => {
    await refreshDirectory();
    return { contacts: listContacts(), groups: listGroups() };
  });

  // Photos and videos of a chat, for ← → in the viewer: ?around=<messageId>&attachment=<id>, or ?offset=&limit=
  r.get('/api/conversations/:id/media', (ctx) => {
    const c = conv(ctx);
    const num = (k: string) => (/^\d+$/.test(ctx.query.get(k) ?? '') ? Number(ctx.query.get(k)) : undefined);
    const around = num('around');
    return conversationMedia(c.id, {
      around: around !== undefined ? { messageId: around, attachmentId: ctx.query.get('attachment') ?? undefined } : undefined,
      offset: num('offset'),
      limit: num('limit'),
    });
  });

  r.get('/api/conversations/:id/date', (ctx) => {
    const ts = ctx.query.get('ts');
    return messageNearDate(conv(ctx).id, ts && /^\d+$/.test(ts) ? Number(ts) : null);
  });

  r.get('/api/conversations/:id/messages', (ctx) => {
    const c = conv(ctx);
    const limit = Math.min(Math.max(Number(ctx.query.get('limit')) || 50, 1), 200);
    const before = ctx.query.get('before') ? Number(ctx.query.get('before')) : undefined;
    const after = ctx.query.get('after');
    const around = ctx.query.get('around');
    if (around) return listMessagesAround(c.id, Number(around), limit);
    if (after) return listMessagesAfter(c.id, Number(after), limit);
    return listMessages(c.id, before, limit);
  });

  // The web app reports a slow chat opening (with where the time went), so it ends up in the log.
  r.post('/api/client-log', (ctx) => {
    log('warn', `browser: ${String(ctx.body?.message ?? '').replace(/[\r\n]+/g, ' ').slice(0, 400)}`);
    return { ok: true };
  });

  r.get('/api/emoji/usage', () => ({ usage: emojiUsage() }));
  r.post('/api/emoji/alias', (ctx) => {
    recordAlias(String(ctx.body?.emoji ?? ''), String(ctx.body?.code ?? '').toLowerCase());
    return { ok: true };
  });

  r.get('/api/search', (ctx) => {
    const q = (ctx.query.get('q') ?? '').trim();
    if (q.length < 2) return { results: [] };
    const cid = ctx.query.get('conversationId');
    return { results: searchMessages(q.slice(0, 100), cid ? Number(cid) : undefined) };
  });

  // Disappearing messages timer for a chat. The API can't switch it off (a 0 gets dropped).
  r.post('/api/conversations/:id/timer', async (ctx) => {
    const c = conv(ctx);
    if (isWa(c)) throw new HttpError(400, 'Set disappearing messages for WhatsApp chats on your phone');
    const account = requireAccount();
    const seconds = Number(ctx.body?.seconds);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 365 * 86400) throw new HttpError(400, 'Choose a timer');
    try {
      if (c.kind === 'group') await signalApi.updateGroup(account, groupRecipientId(c.group_id!), { expiration_time: seconds });
      else await signalApi.updateContact(account, { recipient: recipientFor(c), expiration_in_seconds: seconds });
    } catch (e) {
      const msg = (e as Error).message;
      throw new HttpError(400, /permission|not allowed|admin/i.test(msg) ? 'Only group admins can change the timer in this group.' : msg.replace(/^.*?failed \(\d+\): /, ''));
    }
    setConversationTimer(c.id, seconds);
    const line = insertMessage({
      conversationId: c.id,
      sentTs: Date.now(),
      author: 'self',
      outgoing: true,
      kind: 'system',
      body: `You set disappearing messages to ${humanDuration(seconds)}`,
      read: true,
    });
    if (line) broadcast({ type: 'message', message: messageDto(line) });
    const updated = getConversation(c.id)!;
    emitConversation(updated);
    return conversationDto(updated);
  });

  // Big files are uploaded in pieces first (uploads.ts), then sent as { upload: id }.
  r.get('/api/uploads/limits', async () => ({ sendLimitMb: config.sendLimitMb, waSendLimitMb: config.waSendLimitMb, maxFileMb: config.maxFileMb, oneGoMb: config.maxUploadMb, canShrinkVideo: await canConvert() }));
  r.post('/api/uploads', (ctx) => startUpload(ctx.body));
  r.upload('/api/uploads/:id', (ctx) => receivePiece(ctx));
  r.delete('/api/uploads/:id', (ctx) => (cancelUpload(ctx.params.id), { ok: true }));

  // Send a message. Returns immediately with a "pending" message; delivery status follows over /api/events.
  r.post('/api/conversations/:id/messages', async (ctx) => {
    const c = conv(ctx);
    const account = accountFor(c);
    const { text, ranges } = richInput(ctx.body);
    const files: { name?: string; type?: string; data?: string; upload?: string }[] = Array.isArray(ctx.body?.attachments) ? ctx.body.attachments : [];
    const rawSticker = ctx.body?.sticker;
    const sticker =
      rawSticker && typeof rawSticker.packId === 'string' && isPackId(rawSticker.packId) && Number.isInteger(rawSticker.stickerId)
        ? { packId: rawSticker.packId as string, stickerId: rawSticker.stickerId as number }
        : null;
    if (rawSticker && !sticker) throw new HttpError(400, 'Invalid sticker');
    if (sticker && (text || files.length)) throw new HttpError(400, 'A sticker is sent on its own');
    if (!text && !files.length && !sticker) throw new HttpError(400, 'Empty message');

    const attachments: Attachment[] = [];
    const base64: string[] = [];
    for (const f of files) if (typeof f?.data !== 'string' && typeof f?.upload !== 'string') throw new HttpError(400, 'Bad attachment');
    for (const f of files) {
      const type = String(f.type || 'application/octet-stream').replace(/[^\w.+/-]/g, '');
      const name = String(f.name || 'file').replace(/[;,\r\n/\\]/g, '_').slice(0, 120);
      if (typeof f.upload === 'string') {
        // uploaded in pieces beforehand (uploads.ts): moved into place, read when it's sent
        let id = '';
        const u = takeUpload(f.upload, () => localPath((id = newOutgoingId(type, name))));
        attachments.push({ id, contentType: type, filename: name, size: u.size });
        base64.push(LAZY);
        continue;
      }
      const buf = Buffer.from(f.data!, 'base64');
      const id = saveOutgoing(buf, type, name);
      attachments.push({ id, contentType: type, filename: name, size: buf.length });
      base64.push(`data:${type};filename=${name};base64,${f.data}`);
    }

    const quote = quoteFor(c, ctx.body?.quoteId ? getMessage(Number(ctx.body.quoteId)) : undefined); // also a private reply to a group message

    // A Signal pack sticker in a WhatsApp chat: sent the WhatsApp way (WhatsApp makes a sticker of the image).
    if (sticker && isWa(c)) {
      const img = self.number ? await getStickerImage(self.number, sticker.packId, sticker.stickerId) : null;
      if (!img) throw new HttpError(404, "That sticker isn't available");
      return messageDto(await wa(() => sendStickerWa(c, { path: img.file, mimetype: img.type }, quote)));
    }
    const preview = !sticker && !files.length ? await previewFor(ctx.body?.previewUrl, text) : null;
    recordEmoji(emojiIn(text));
    return queueOutgoing(account, c, { text, ranges, attachments, base64, quote, sticker, preview }, (m) => log('warn', m));
  });

  r.get('/api/link-preview', async (ctx) => {
    if (!getSettings().sendLinkPreviews) return { preview: null };
    const p = await linkPreview(String(ctx.query.get('url') ?? ''));
    return { preview: p ? { url: p.url, title: p.title, description: p.description, image: p.image ? `data:${p.image.type};base64,${p.image.data}` : null } : null };
  });

  // Forward a message (text, files, sticker) to other chats. Quotes are left behind, like Signal.
  r.post('/api/messages/:id/forward', async (ctx) => {
    const m = message(ctx);
    if (m.deleted || m.kind === 'system' || m.kind === 'poll') throw new HttpError(400, "This message can't be forwarded");
    const ids: number[] = Array.isArray(ctx.body?.conversationIds) ? ctx.body.conversationIds.map(Number) : [];
    if (!ids.length || ids.length > 5) throw new HttpError(400, 'Pick up to 5 chats');
    const targets = ids.map((id) => getConversation(id));
    if (targets.some((t) => !t)) throw new HttpError(404, 'Conversation not found');
    if (m.sticker && targets.some((t) => isWa(t!))) throw new HttpError(400, "Signal stickers can't be forwarded to WhatsApp");
    const accounts = targets.map((t) => accountFor(t!));
    const attachments: Attachment[] = m.attachments ? JSON.parse(m.attachments) : [];
    const source = getConversation(m.conversation_id)!;
    // WhatsApp → WhatsApp goes as a real forward (setting); anything else is sent as a copy.
    const native = isWa(source) && !!m.ext_id && !m.ext_id.startsWith('call:') && getSettings().waNativeForward;
    let base64: string[] = [];
    if (!native || targets.some((t) => !isWa(t!))) {
      try {
        // Files from imported history may not be on the server yet.
        for (const a of attachments) if (!(await fetchAttachment(a.id))) throw new Error('missing');
        base64 = attachments.map(readBase64);
      } catch {
        throw new HttpError(409, "An attachment of this message isn't available on the server");
      }
    }
    const ranges: Ranges | null = m.ranges ? JSON.parse(m.ranges) : null;
    const sticker = m.sticker ? JSON.parse(m.sticker) : null;
    const preview: LinkPreview | null = m.preview ? JSON.parse(m.preview) : null;
    const sent = targets.map((t, i) =>
      queueOutgoing(
        accounts[i],
        t!,
        { text: m.body ?? '', ranges, attachments, base64: native && isWa(t!) ? [] : base64, quote: null, sticker, preview, forwardOf: native && isWa(t!) ? m.ext_id : null },
        (msg) => log('warn', msg),
      ),
    );
    return { messages: sent };
  });

  // ---------- polls ----------

  r.post('/api/conversations/:id/polls', async (ctx) => {
    const c = conv(ctx);
    const account = accountFor(c);
    const question = String(ctx.body?.question ?? '').trim();
    const options: string[] = (Array.isArray(ctx.body?.options) ? ctx.body.options : []).map((o: unknown) => String(o ?? '').trim()).filter(Boolean);
    const multiple = !!ctx.body?.multiple;
    if (!question || question.length > 200) throw new HttpError(400, 'Ask a question (up to 200 characters)');
    if (options.length < 2 || options.length > 10) throw new HttpError(400, 'A poll needs 2 to 10 options');
    if (new Set(options).size !== options.length) throw new HttpError(400, 'Options must be different');
    if (isWa(c)) {
      const row = await wa(() => createPollWa(c, question, options, multiple));
      if (!row) throw new HttpError(409, 'Duplicate poll');
      const dto = messageDto(row);
      broadcast({ type: 'message', message: dto });
      emitConversation(getConversation(c.id)!);
      return dto;
    }
    let res: { timestamp?: string | number };
    try {
      res = await signalApi.createPoll(account, { recipient: recipientFor(c), question, answers: options, allow_multiple_selections: multiple });
    } catch (e) {
      throw new HttpError(400, (e as Error).message.replace(/^.*?failed \(\d+\): /, ''));
    }
    const ts = sentTimestamp(res) ?? Date.now();
    const row = insertMessage({
      conversationId: c.id,
      sentTs: ts,
      author: 'self',
      authorNumber: account,
      outgoing: true,
      kind: 'poll',
      body: question,
      status: 'sent',
      read: true,
      poll: { question, options, multiple, votes: {} },
      expiresIn: c.expire_timer || 0,
      expiresAt: c.expire_timer ? ts + c.expire_timer * 1000 : null,
    });
    if (!row) throw new HttpError(409, 'Duplicate poll');
    const dto = messageDto(row);
    broadcast({ type: 'message', message: dto });
    emitConversation(getConversation(c.id)!);
    return dto;
  });

  r.post('/api/messages/:id/vote', async (ctx) => {
    const m = message(ctx);
    const account = accountFor(getConversation(m.conversation_id)!);
    if (!m.poll || m.deleted) throw new HttpError(400, 'Not a poll');
    const poll: Poll = JSON.parse(m.poll);
    if (poll.closed) throw new HttpError(400, 'This poll has ended');
    const picked = [...new Set<number>((Array.isArray(ctx.body?.options) ? ctx.body.options : []).map(Number))].filter(
      (i) => Number.isInteger(i) && i >= 0 && i < poll.options.length,
    );
    if (!picked.length) throw new HttpError(400, 'Pick an option');
    if (!poll.multiple && picked.length > 1) throw new HttpError(400, 'This poll allows one answer');
    const c = getConversation(m.conversation_id)!;
    if (isWa(c)) await wa(() => voteWa(c, m, poll, picked));
    else await signalApi.votePoll(account, {
      recipient: recipientFor(c),
      poll_author: addressForKey(m.author),
      poll_timestamp: String(m.sent_ts),
      selected_answers: picked.map((i) => i + 1), // the REST API counts from 1
    });
    poll.votes.self = { options: picked.sort((a, b) => a - b), count: (poll.votes.self?.count ?? 0) + 1 };
    return messageDto(emitMessageRow(m.id, { poll: JSON.stringify(poll) })!);
  });

  r.delete('/api/messages/:id/poll', async (ctx) => {
    const m = message(ctx);
    if (isWa(getConversation(m.conversation_id)!)) throw new HttpError(400, "WhatsApp polls can't be ended");
    const account = requireAccount();
    if (!m.poll || !m.outgoing) throw new HttpError(400, 'Only the person who made a poll can end it');
    const poll: Poll = JSON.parse(m.poll);
    if (!poll.closed) {
      const c = getConversation(m.conversation_id)!;
      await signalApi.closePoll(account, { recipient: recipientFor(c), poll_timestamp: String(m.sent_ts) });
      poll.closed = true;
    }
    return messageDto(emitMessageRow(m.id, { poll: JSON.stringify(poll) })!);
  });

  // ---------- chat list: pin, archive, mute (Signal Web only; your phone keeps its own) ----------

  r.post('/api/conversations/:id/flags', async (ctx) => {
    const c = conv(ctx);
    const b = ctx.body ?? {};
    if (b.pinned === true && !c.pinned_at && pinnedCount() >= 10) throw new HttpError(400, 'You can pin up to 10 chats');
    // Archiving a WhatsApp chat archives it on your phone too.
    if (isWa(c) && typeof b.archived === 'boolean' && b.archived !== !!c.archived) await wa(() => archiveWa(c, b.archived));
    setConversationFlags(c.id, {
      pinned: typeof b.pinned === 'boolean' ? b.pinned : undefined,
      archived: typeof b.archived === 'boolean' ? b.archived : undefined,
      mutedUntil: typeof b.mutedUntil === 'number' ? b.mutedUntil : undefined,
    });
    const updated = getConversation(c.id)!;
    emitConversation(updated);
    return conversationDto(updated);
  });

  r.post('/api/pinned/order', (ctx) => {
    const ids: number[] = Array.isArray(ctx.body?.ids) ? ctx.body.ids.map(Number).filter(Number.isInteger) : [];
    const order = setPinnedOrder(ids);
    const updated = order.map((id) => getConversation(id)!);
    for (const c of updated) emitConversation(c);
    return { conversations: updated.map(conversationDto) };
  });

  r.post('/api/messages/:id/retry', (ctx) => {
    const m = message(ctx);
    if (!m.outgoing || m.status !== 'failed') throw new HttpError(400, 'Nothing to retry');
    const c = getConversation(m.conversation_id)!;
    const account = accountFor(c);
    const atts: Attachment[] = m.attachments ? JSON.parse(m.attachments) : [];
    if (atts.some((a) => !fs.existsSync(localPath(a.id)))) throw new HttpError(409, "The file isn't on the server any more");
    const base64 = atts.map(() => LAZY); // read when it's sent (after any shrinking)
    const quote = m.quote ? JSON.parse(m.quote) : null;
    const sticker = m.sticker ? JSON.parse(m.sticker) : null;
    const updated = emitMessageRow(m.id, { status: 'pending', error: null })!;
    const payload = { text: m.body ?? '', ranges: m.ranges ? JSON.parse(m.ranges) : null, base64, quote, sticker, preview: m.preview ? JSON.parse(m.preview) : null };
    void deliver(account, c, m.id, payload, (msg) => log('warn', msg));
    return messageDto(updated);
  });

  // Edit one of your own text messages (Signal allows this for 24 hours).
  r.post('/api/messages/:id/edit', async (ctx) => {
    const m = message(ctx);
    const account = accountFor(getConversation(m.conversation_id)!);
    const { text, ranges } = richInput(ctx.body);
    if (!m.outgoing || m.deleted || m.kind !== 'message' || m.attachments) throw new HttpError(400, 'Only your own text messages can be edited');
    if (m.status === 'pending' || m.status === 'failed') throw new HttpError(400, 'This message has not been sent yet');
    if (!m.ts_confirmed) throw new HttpError(400, "This message was sent before editing was supported and can't be edited");
    const waChat = isWa(getConversation(m.conversation_id)!);
    if (Date.now() - m.sent_ts > (waChat ? 15 * 60_000 - 30_000 : EDIT_WINDOW_MS)) {
      throw new HttpError(400, waChat ? 'WhatsApp messages can only be edited for 15 minutes' : 'Messages can only be edited for 24 hours after sending');
    }
    if (!text) throw new HttpError(400, 'A message can’t be empty. Delete it instead.');
    const rangesJson = ranges ? JSON.stringify(ranges) : null;
    if (text === m.body && rangesJson === m.ranges) return messageDto(m);
    const c = getConversation(m.conversation_id)!;
    const quote = m.quote ? (JSON.parse(m.quote) as { sentTs: number; author: string; text?: string | null }) : null;
    if (isWa(c)) await wa(() => editWa(c, m, text, ranges));
    else await signalApi.send({
      number: account,
      recipients: [recipientFor(c)],
      ...apiText(text, ranges),
      edit_timestamp: m.sent_ts, // always the original message's timestamp, also for later edits
      quote_timestamp: quote?.sentTs,
      quote_author: quote ? addressForKey(quote.author) : undefined,
      quote_message: quote ? quote.text ?? '' : undefined,
    });
    const updated = emitMessageRow(m.id, { body: text, ranges: rangesJson, preview: null, edited: 1 })!;
    emitConversation(c);
    return messageDto(updated);
  });

  // React (toggles: sending the same emoji again removes it)
  r.post('/api/messages/:id/reactions', async (ctx) => {
    const m = message(ctx);
    const account = accountFor(getConversation(m.conversation_id)!);
    if (m.deleted) throw new HttpError(400, 'Message was deleted');
    if (m.status === 'pending' || m.status === 'failed') throw new HttpError(400, 'Message has not been sent yet');
    const emoji = String(ctx.body?.emoji ?? '');
    if (!emoji || emoji.length > 16) throw new HttpError(400, 'Invalid emoji');
    const c = getConversation(m.conversation_id)!;
    let reactions: Reaction[] = m.reactions ? JSON.parse(m.reactions) : [];
    const mine = reactions.find((x) => x.author === 'self');
    const removing = mine?.emoji === emoji;
    const body = { recipient: recipientFor(c), reaction: removing ? mine!.emoji : emoji, target_author: addressForKey(m.author), timestamp: m.sent_ts };
    if (isWa(c)) await wa(() => reactWa(m, removing ? '' : emoji));
    else if (removing) await signalApi.unreact(account, body);
    else await signalApi.react(account, body);
    reactions = reactions.filter((x) => x.author !== 'self');
    if (!removing) reactions.push({ emoji, author: 'self' });
    if (!removing) recordEmoji([emoji]);
    return messageDto(emitMessageRow(m.id, { reactions: reactions.length ? JSON.stringify(reactions) : null })!);
  });

  // Delete for everyone
  r.delete('/api/messages/:id', async (ctx) => {
    const m = message(ctx);
    if (!m.outgoing) throw new HttpError(400, 'You can only delete your own messages');
    const c = getConversation(m.conversation_id)!;
    const account = accountFor(c);
    if (m.status !== 'failed' && m.status !== 'pending') {
      if (isWa(c)) await wa(() => deleteWa(c, m));
      else await signalApi.remoteDelete(account, recipientFor(c), m.sent_ts);
    }
    const updated = emitMessageRow(m.id, { deleted: 1, body: null, attachments: null, reactions: null })!;
    emitConversation(c);
    return messageDto(updated);
  });

  // Mark a conversation read (+ send read receipts to the senders)
  r.post('/api/conversations/:id/read', (ctx) => {
    const job = markRead(conv(ctx));
    if (job) void job();
    return { ok: true };
  });

  // Every chat with unread messages (or marked unread) at once. Read receipts go out one chat at a
  // time in the background, so WhatsApp Web isn't flooded.
  r.post('/api/conversations/read-all', () => {
    const jobs: (() => Promise<void>)[] = [];
    let chats = 0;
    for (const c of listConversationRows()) {
      if (!c.marked_unread && !unreadMessages(c.id).length) continue;
      chats++;
      const job = markRead(c);
      if (job) jobs.push(job);
    }
    void (async () => {
      for (const job of jobs) {
        await job().catch(() => {});
        await new Promise((r) => setTimeout(r, 300));
      }
    })();
    return { ok: true, chats };
  });

  // Block / unblock a WhatsApp contact (Signal's API can't block people).
  r.post('/api/conversations/:id/block', async (ctx) => {
    const c = conv(ctx);
    if (!isWa(c) || c.kind !== 'direct') throw new HttpError(400, 'Only WhatsApp contacts can be blocked here');
    await wa(() => blockWa(c, ctx.body?.blocked !== false));
    const updated = getConversation(c.id)!;
    emitConversation(updated);
    return conversationDto(updated);
  });

  // "Mark as unread" (WhatsApp: also on your phone; Signal has no such thing, so it stays here).
  r.post('/api/conversations/:id/unread', async (ctx) => {
    const c = conv(ctx);
    setConversationFlags(c.id, { markedUnread: true });
    if (isWa(c) && getWaState().status === 'connected') await markUnreadWa(c).catch(() => {});
    const updated = getConversation(c.id)!;
    emitConversation(updated);
    return conversationDto(updated);
  });

  // The chat was opened in a browser.
  r.post('/api/conversations/:id/open', (ctx) => {
    const c = conv(ctx);
    if (isWa(c) && getWaState().status === 'connected') {
      void subscribePresenceWa(c);
      void refreshPresenceWa(c).catch(() => {});
    }
    return { ok: true, presence: isWa(c) ? presenceFor(c) : null };
  });

  // A browser with Messenger Web open and in front (for "show me as online").
  r.post('/api/presence', (ctx) => {
    browserActive(ctx.body?.active === true);
    return { ok: true };
  });

  // ---------- WhatsApp: contacts, profile, stickers ----------

  r.post('/api/whatsapp/contacts/:jid', async (ctx) => {
    const jid = ctx.params.jid;
    if (!/^\d{6,20}@c\.us$/.test(jid)) throw new HttpError(400, "Only people with a phone number can be saved as a contact");
    const first = String(ctx.body?.firstName ?? '').trim().slice(0, 100);
    const last = String(ctx.body?.lastName ?? '').trim().slice(0, 100);
    if (!first) throw new HttpError(400, 'Enter a first name');
    await wa(() => saveContactWa(jid, first, last));
    const c = findWaChat(jid);
    if (c) emitConversation(c);
    return { ok: true };
  });

  r.get('/api/whatsapp/profile', async () => wa(() => waProfile()));
  r.post('/api/whatsapp/profile', async (ctx) => {
    const b = ctx.body ?? {};
    const name = typeof b.name === 'string' ? b.name.trim().slice(0, 25) : undefined;
    const about = typeof b.about === 'string' ? b.about.trim().slice(0, 139) : undefined;
    if (name !== undefined && !name) throw new HttpError(400, "Your name can't be empty");
    const picture = b.picture === null ? null : typeof b.picture === 'string' ? b.picture : undefined;
    await wa(() => updateWaProfile({ name, about, picture }));
    return wa(() => waProfile());
  });

  r.get('/api/whatsapp/stickers', () => ({ stickers: listStickersWa() }));
  r.delete('/api/whatsapp/stickers/:id', (ctx) => (removeStickerWa(ctx.params.id), { stickers: listStickersWa() }));
  r.post('/api/whatsapp/stickers/import', () => importStickersFromFolder());
  r.post('/api/conversations/:id/wa-sticker', async (ctx) => {
    const c = conv(ctx);
    if (!isWa(c)) throw new HttpError(400, 'Not a WhatsApp chat');
    const quote = quoteFor(c, ctx.body?.quoteId ? getMessage(Number(ctx.body.quoteId)) : undefined);
    const src = typeof ctx.body?.id === 'string' ? { id: ctx.body.id } : typeof ctx.body?.image === 'string' ? { image: ctx.body.image } : null;
    if (!src) throw new HttpError(400, 'Pick a sticker or an image');
    return messageDto(await wa(() => sendStickerWa(c, src, quote)));
  });

  r.post('/api/conversations/:id/typing', (ctx) => {
    if (!getSettings().sendTypingIndicators) return { ok: true };
    const c = conv(ctx);
    if (isWa(c)) {
      if (getWaState().status === 'connected') typingWa(c, !!ctx.body?.typing).catch(() => {});
      return { ok: true };
    }
    const account = self.number;
    if (account && getState().status === 'connected') {
      signalApi.typing(account, recipientFor(c), !!ctx.body?.typing).catch(() => {});
    }
    return { ok: true };
  });

  // Attachments: served from our own copy, fetched from the Signal API on first use.
  // A WhatsApp file from imported history that isn't here yet: fetch it in the background and say so
  // straight away. Holding the request open (old files can take WhatsApp a minute) would tie up the
  // browser's few connections to this server and make the whole app wait. The chat updates when the
  // file arrives. Downloads (?download=1) do wait.
  r.post('/api/attachments/:id/fetch', (ctx) => {
    const id = ctx.params.id;
    if (!isSafeId(id)) throw new HttpError(400, 'Bad id');
    if (fs.existsSync(localPath(id))) return { ready: true };
    void fetchAttachment(id).catch(() => {});
    return { queued: true };
  });

  r.get('/api/attachments/:id', async (ctx) => {
    const id = ctx.params.id;
    if (!isSafeId(id)) throw new HttpError(400, 'Bad id');
    if (id.startsWith('wa-') && !fs.existsSync(localPath(id)) && !ctx.query.has('download')) {
      void fetchAttachment(id).catch(() => {});
      ctx.res.setHeader('retry-after', '10');
      throw new HttpError(404, 'Not downloaded yet');
    }
    if (!(await fetchAttachment(id))) throw new HttpError(404, 'Attachment not available');
    const file = localPath(id);
    const type = MIME[path.extname(id).toLowerCase()];
    const headers: Record<string, string | number> = {
      'content-type': type ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=31536000, immutable',
    };
    const name = ctx.query.get('name')?.replace(/["\r\n\\]/g, '') || id;
    if (!type || ctx.query.has('download')) {
      headers['content-disposition'] = `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
    }
    sendFile(ctx.res, file, headers, ctx.req.method === 'HEAD');
  });

  groupRoutes(r);
  return r;
}
