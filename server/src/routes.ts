import fs from 'node:fs';
import path from 'node:path';
import { fetchAttachment, isSafeId, localPath, saveOutgoing } from './attachments.js';
import { getAvatar } from './avatars.js';
import { applyPendingReceipts } from './ingest.js';
import {
  SESSION_COOKIE,
  clearLoginFailures,
  createSession,
  destroySession,
  isValidSession,
  loginBlocked,
  passwordMatches,
  recordLoginFailure,
} from './auth.js';
import { config } from './config.js';
import { addClient, broadcast } from './events.js';
import { type Ctx, HttpError, Router, setCookie } from './http.js';
import { getState, recheckSoon, refreshDirectory } from './signal.js';
import { groupRecipientId, signalApi } from './signal-api.js';
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
  getOrCreateDirect,
  insertMessage,
  listContacts,
  listConversations,
  listGroups,
  listMessages,
  markConversationRead,
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

/** Hand a stored message to signal-cli and record the outcome. */
async function deliver(
  account: string,
  c: ConversationRow,
  messageId: number,
  payload: { text: string; base64: string[]; quote?: { sentTs: number; author: string; text?: string | null } | null },
  log: (m: string) => void,
) {
  try {
    const res = await signalApi.send({
      number: account,
      recipients: [recipientFor(c)],
      message: payload.text,
      base64_attachments: payload.base64.length ? payload.base64 : undefined,
      quote_timestamp: payload.quote?.sentTs,
      quote_author: payload.quote ? addressForKey(payload.quote.author) : undefined,
      quote_message: payload.quote ? payload.quote.text ?? '' : undefined,
    });
    const ts = Number(res?.timestamp);
    emitMessageRow(messageId, { status: 'sent', error: null, ...(ts ? { sent_ts: ts } : {}) });
    applyPendingReceipts(messageId); // receipts that arrived while the send was still running
  } catch (e) {
    log(`send failed: ${(e as Error).message}`);
    emitMessageRow(messageId, { status: 'failed', error: (e as Error).message });
  }
  emitConversation(getConversation(c.id)!);
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

  // Avatars (proxied from the Signal API and cached on disk)
  const sendAvatar = async (ctx: Ctx, kind: 'profile' | 'group', id: string | null | undefined) => {
    const account = self.number;
    const found = account && id ? await getAvatar(account, kind, id) : null;
    if (!found) {
      ctx.res.writeHead(404, { 'cache-control': 'private, max-age=3600', 'content-type': 'text/plain' });
      return ctx.res.end('No avatar');
    }
    ctx.res.writeHead(200, { 'content-type': found.type, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' });
    fs.createReadStream(found.file).pipe(ctx.res);
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
    return listMessages(c.id, before, limit);
  });

  // Send a message. Returns immediately with a "pending" message; delivery status follows over /api/events.
  r.post('/api/conversations/:id/messages', (ctx) => {
    const account = requireAccount();
    const c = conv(ctx);
    const text = String(ctx.body?.text ?? '').trim();
    const files: { name?: string; type?: string; data: string }[] = Array.isArray(ctx.body?.attachments) ? ctx.body.attachments : [];
    if (!text && !files.length) throw new HttpError(400, 'Empty message');

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
        ? { sentTs: quoted.sent_ts, author: quoted.author, text: quoted.body ?? '' }
        : null;

    const pending = insertMessage({
      conversationId: c.id,
      sentTs: Date.now(),
      author: 'self',
      authorNumber: account,
      outgoing: true,
      body: text || null,
      attachments,
      quote,
      status: 'pending',
      read: true,
    });
    if (!pending) throw new HttpError(409, 'Duplicate message, try again');
    const dto = messageDto(pending);
    broadcast({ type: 'message', message: dto });
    emitConversation(getConversation(c.id)!);
    void deliver(account, c, pending.id, { text, base64, quote }, (m) => log('warn', m));
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
    const updated = emitMessageRow(m.id, { status: 'pending', error: null })!;
    void deliver(account, c, m.id, { text: m.body ?? '', base64, quote }, (msg) => log('warn', msg));
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
    if (config.sendReadReceipts && account && getState().status === 'connected') {
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
    if (!config.sendTypingIndicators) return { ok: true };
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
    const stat = fs.statSync(file);
    const headers: Record<string, string | number> = {
      'content-type': type ?? 'application/octet-stream',
      'content-length': stat.size,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=31536000, immutable',
    };
    const name = ctx.query.get('name')?.replace(/["\r\n\\]/g, '') || id;
    if (!type || ctx.query.has('download')) {
      headers['content-disposition'] = `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
    }
    ctx.res.writeHead(200, headers);
    if (ctx.req.method === 'HEAD') return ctx.res.end();
    fs.createReadStream(file).pipe(ctx.res);
  });

  return r;
}
