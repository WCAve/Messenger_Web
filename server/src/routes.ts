import fs from 'node:fs';
import path from 'node:path';
import { fetchAttachment, isSafeId, localPath, saveOutgoing } from './attachments.js';
import { getAvatar, invalidateAvatar, readAvatar } from './avatars.js';
import { getSettings, updateSettings } from './settings.js';
import { getManifest, getStickerImage, isPackId, listPacks, parsePackLink, refreshPacks } from './stickers.js';
import { applyPendingReceipts, humanDuration } from './ingest.js';
import { type Ranges, cleanRanges, toApiMarkup } from './richtext.js';
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
import { addClient, broadcast, closeAllClients } from './events.js';
import { type Ctx, HttpError, Router, sendFile, setCookie } from './http.js';
import { getState, recheckSoon, refreshDirectory } from './signal.js';
import { groupRecipientId, sentTimestamp, signalApi } from './signal-api.js';
import {
  type Attachment,
  type ConversationRow,
  type Reaction,
  addressForKey,
  contactByKeyOrId,
  conversationDto,
  conversationInfo,
  getConversation,
  getMessage,
  getSelfProfile,
  setSelfProfile,
  getOrCreateDirect,
  insertMessage,
  listContacts,
  listConversations,
  listGroups,
  listMessages,
  listMessagesAfter,
  listMessagesAround,
  markConversationRead,
  renderBody,
  searchMessages,
  setConversationTimer,
  messageDto,
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
      if (m.key !== 'self' && !contactByKeyOrId(m.key)) throw new HttpError(400, 'Unknown person in a mention');
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

/** Hand a stored message to signal-cli and record the outcome. */
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
  },
  log: (m: string) => void,
) {
  try {
    const res = await signalApi.send({
      number: account,
      recipients: [recipientFor(c)],
      ...apiText(payload.text, payload.ranges ?? null),
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

  r.get('/api/events', (ctx) => {
    addClient(ctx.req, ctx.res, [{ type: 'state', state: getState() }]);
  });

  r.get('/api/state', () => getState());

  // ---------- your Signal profile ----------
  const selfAvatarId = () => self.uuid || self.number!;
  const profileDto = () => {
    const p = getSelfProfile();
    return {
      known: !!p,
      givenName: p?.givenName ?? '',
      familyName: p?.familyName ?? '',
      about: p?.about ?? '',
      avatar: p?.hasAvatar ? `/api/avatars/self?v=${Date.now()}` : null,
    };
  };
  r.get('/api/profile', async () => {
    requireAccount();
    if (!getSelfProfile()) await refreshDirectory().catch(() => {});
    return profileDto();
  });
  r.get('/api/avatars/self', (ctx) => sendAvatar(ctx, 'profile', selfAvatarId()));

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
    const account = requireAccount();
    const c = conv(ctx);
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

  r.get('/api/settings', () => settingsDto());
  r.post('/api/settings', (ctx) => {
    updateSettings(ctx.body ?? {});
    return settingsDto();
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

  r.get('/api/conversations/:id/info', (ctx) => conversationInfo(conv(ctx)));

  r.get('/api/messages/:id/info', (ctx) => {
    const m = message(ctx);
    if (!m.outgoing) throw new HttpError(400, 'Only your own messages have delivery info');
    return { message: messageDto(m), recipients: messageReceipts(m) };
  });

  // Stickers
  r.get('/api/stickers', async () => {
    const account = requireAccount();
    return { packs: await listPacks(account, (m) => log('warn', m)) };
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
    const id = Number(ctx.params.stickerId);
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
    const c = conv(ctx);
    if (c.kind === 'group') return sendAvatar(ctx, 'group', groupRecipientId(c.group_id!));
    return sendAvatar(ctx, 'profile', c.peer_uuid || c.peer_number);
  });
  r.get('/api/avatars/contact/:key', (ctx) => {
    const c = contactByKeyOrId(ctx.params.key);
    return sendAvatar(ctx, 'profile', c?.uuid || c?.number);
  });

  r.post('/api/conversations', (ctx) => {
    const number = typeof ctx.body?.number === 'string' ? ctx.body.number.replace(/[\s()-]/g, '') : undefined;
    const uuid = typeof ctx.body?.uuid === 'string' ? ctx.body.uuid : undefined;
    if (number && !/^\+[1-9]\d{6,14}$/.test(number)) {
      throw new HttpError(400, 'Enter the number in international format, e.g. +31612345678');
    }
    if (!number && !uuid) throw new HttpError(400, 'number or uuid required');
    return conversationDto(getOrCreateDirect(uuid ?? null, number ?? null));
  });

  r.get('/api/directory', () => ({ contacts: listContacts(), groups: listGroups() }));

  r.post('/api/directory/refresh', async () => {
    await refreshDirectory();
    return { contacts: listContacts(), groups: listGroups() };
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

  r.get('/api/search', (ctx) => {
    const q = (ctx.query.get('q') ?? '').trim();
    if (q.length < 2) return { results: [] };
    const cid = ctx.query.get('conversationId');
    return { results: searchMessages(q.slice(0, 100), cid ? Number(cid) : undefined) };
  });

  // Disappearing messages timer for a chat. The API can't switch it off (a 0 gets dropped).
  r.post('/api/conversations/:id/timer', async (ctx) => {
    const account = requireAccount();
    const c = conv(ctx);
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

  // Send a message. Returns immediately with a "pending" message; delivery status follows over /api/events.
  r.post('/api/conversations/:id/messages', (ctx) => {
    const account = requireAccount();
    const c = conv(ctx);
    const { text, ranges } = richInput(ctx.body);
    const files: { name?: string; type?: string; data: string }[] = Array.isArray(ctx.body?.attachments) ? ctx.body.attachments : [];
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
    for (const f of files) {
      if (typeof f?.data !== 'string') throw new HttpError(400, 'Bad attachment');
      const type = String(f.type || 'application/octet-stream').replace(/[^\w.+/-]/g, '');
      const name = String(f.name || 'file').replace(/[;,\r\n/\\]/g, '_').slice(0, 120);
      const buf = Buffer.from(f.data, 'base64');
      const id = saveOutgoing(buf, type, name);
      attachments.push({ id, contentType: type, filename: name, size: buf.length });
      base64.push(`data:${type};filename=${name};base64,${f.data}`);
    }

    const quoted = ctx.body?.quoteId ? getMessage(Number(ctx.body.quoteId)) : undefined;
    const quote =
      quoted && quoted.conversation_id === c.id && !quoted.deleted
        ? { sentTs: quoted.sent_ts, author: quoted.author, text: renderBody(quoted.body, quoted.ranges)?.text ?? '' }
        : null;

    const now = Date.now();
    const pending = insertMessage({
      conversationId: c.id,
      sentTs: now,
      author: 'self',
      authorNumber: account,
      outgoing: true,
      kind: sticker ? 'sticker' : 'message',
      body: text || null,
      ranges,
      attachments,
      quote,
      status: 'pending',
      read: true,
      sticker,
      // signal-cli applies the chat's disappearing timer to everything it sends.
      expiresIn: c.expire_timer || 0,
      expiresAt: c.expire_timer ? now + c.expire_timer * 1000 : null,
    });
    if (!pending) throw new HttpError(409, 'Duplicate message, try again');
    const dto = messageDto(pending);
    broadcast({ type: 'message', message: dto });
    emitConversation(getConversation(c.id)!);
    void deliver(account, c, pending.id, { text, ranges, base64, quote, sticker }, (m) => log('warn', m));
    return dto;
  });

  r.post('/api/messages/:id/retry', (ctx) => {
    const account = requireAccount();
    const m = message(ctx);
    if (!m.outgoing || m.status !== 'failed') throw new HttpError(400, 'Nothing to retry');
    const c = getConversation(m.conversation_id)!;
    const atts: Attachment[] = m.attachments ? JSON.parse(m.attachments) : [];
    const base64 = atts.map(
      (a) => `data:${a.contentType};filename=${a.filename ?? 'file'};base64,${fs.readFileSync(localPath(a.id)).toString('base64')}`,
    );
    const quote = m.quote ? JSON.parse(m.quote) : null;
    const sticker = m.sticker ? JSON.parse(m.sticker) : null;
    const updated = emitMessageRow(m.id, { status: 'pending', error: null })!;
    void deliver(account, c, m.id, { text: m.body ?? '', base64, quote, sticker }, (msg) => log('warn', msg));
    return messageDto(updated);
  });

  // Edit one of your own text messages (Signal allows this for 24 hours).
  r.post('/api/messages/:id/edit', async (ctx) => {
    const account = requireAccount();
    const m = message(ctx);
    const { text, ranges } = richInput(ctx.body);
    if (!m.outgoing || m.deleted || m.kind !== 'message' || m.attachments) throw new HttpError(400, 'Only your own text messages can be edited');
    if (m.status === 'pending' || m.status === 'failed') throw new HttpError(400, 'This message has not been sent yet');
    if (!m.ts_confirmed) throw new HttpError(400, "This message was sent before editing was supported and can't be edited");
    if (Date.now() - m.sent_ts > EDIT_WINDOW_MS) throw new HttpError(400, 'Messages can only be edited for 24 hours after sending');
    if (!text) throw new HttpError(400, 'A message can’t be empty. Delete it instead.');
    const rangesJson = ranges ? JSON.stringify(ranges) : null;
    if (text === m.body && rangesJson === m.ranges) return messageDto(m);
    const c = getConversation(m.conversation_id)!;
    const quote = m.quote ? (JSON.parse(m.quote) as { sentTs: number; author: string; text?: string | null }) : null;
    await signalApi.send({
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
    const account = requireAccount();
    const m = message(ctx);
    if (m.deleted) throw new HttpError(400, 'Message was deleted');
    if (m.status === 'pending' || m.status === 'failed') throw new HttpError(400, 'Message has not been sent yet');
    const emoji = String(ctx.body?.emoji ?? '');
    if (!emoji || emoji.length > 16) throw new HttpError(400, 'Invalid emoji');
    const c = getConversation(m.conversation_id)!;
    let reactions: Reaction[] = m.reactions ? JSON.parse(m.reactions) : [];
    const mine = reactions.find((x) => x.author === 'self');
    const removing = mine?.emoji === emoji;
    const body = { recipient: recipientFor(c), reaction: removing ? mine!.emoji : emoji, target_author: addressForKey(m.author), timestamp: m.sent_ts };
    if (removing) await signalApi.unreact(account, body);
    else await signalApi.react(account, body);
    reactions = reactions.filter((x) => x.author !== 'self');
    if (!removing) reactions.push({ emoji, author: 'self' });
    return messageDto(emitMessageRow(m.id, { reactions: reactions.length ? JSON.stringify(reactions) : null })!);
  });

  // Delete for everyone
  r.delete('/api/messages/:id', async (ctx) => {
    const account = requireAccount();
    const m = message(ctx);
    if (!m.outgoing) throw new HttpError(400, 'You can only delete your own messages');
    const c = getConversation(m.conversation_id)!;
    if (m.status !== 'failed' && m.status !== 'pending') await signalApi.remoteDelete(account, recipientFor(c), m.sent_ts);
    const updated = emitMessageRow(m.id, { deleted: 1, body: null, attachments: null, reactions: null })!;
    emitConversation(c);
    return messageDto(updated);
  });

  // Mark a conversation read (+ send read receipts to the senders)
  r.post('/api/conversations/:id/read', (ctx) => {
    const c = conv(ctx);
    const unread = unreadMessages(c.id);
    if (!unread.length) return { ok: true };
    markConversationRead(c.id);
    emitConversation(c);
    const account = self.number;
    if (getSettings().sendReadReceipts && account && getState().status === 'connected') {
      void (async () => {
        for (const m of unread.slice(-30)) {
          if (m.author === 'self') continue;
          try {
            await signalApi.receipt(account, { recipient: addressForKey(m.author), receipt_type: 'read', timestamp: m.sent_ts });
          } catch {
            /* receipts are best effort */
          }
        }
      })();
    }
    return { ok: true };
  });

  r.post('/api/conversations/:id/typing', (ctx) => {
    if (!getSettings().sendTypingIndicators) return { ok: true };
    const c = conv(ctx);
    const account = self.number;
    if (account && getState().status === 'connected') {
      signalApi.typing(account, recipientFor(c), !!ctx.body?.typing).catch(() => {});
    }
    return { ok: true };
  });

  // Attachments: served from our own copy, fetched from the Signal API on first use.
  r.get('/api/attachments/:id', async (ctx) => {
    const id = ctx.params.id;
    if (!isSafeId(id)) throw new HttpError(400, 'Bad id');
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

  return r;
}
