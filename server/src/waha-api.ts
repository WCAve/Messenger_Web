/** Thin client for WAHA (WhatsApp HTTP API, https://waha.devlike.pro). Same API on every engine. */
import { config } from './config.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = any;

const enc = encodeURIComponent;

function headers(extra?: Record<string, string>) {
  return { ...(config.wahaApiKey ? { 'x-api-key': config.wahaApiKey } : {}), ...extra };
}

async function call<T>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
  const res = await fetch(config.wahaUrl + path, {
    method,
    headers: headers(body !== undefined ? { 'content-type': 'application/json' } : undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      const j = JSON.parse(text);
      msg = j.message ?? j.error ?? text;
      if (Array.isArray(msg)) msg = msg.join(', ');
    } catch {
      /* not json */
    }
    throw Object.assign(new Error(`WhatsApp API ${method} ${path.split('?')[0]} failed (${res.status}): ${String(msg).slice(0, 300)}`), { status: res.status });
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

const S = () => config.wahaSession;

export interface WaFile {
  mimetype: string;
  filename?: string;
  data: string; // base64
}

export const waha = {
  version: () => call<{ version: string; engine: string; tier?: string }>('GET', '/api/server/version', undefined, 10_000),
  session: () => call<{ name: string; status: string; me?: { id: string; pushName?: string; lid?: string } | null; engine?: { engine?: string } }>(
    'GET',
    `/api/sessions/${enc(S())}`,
    undefined,
    10_000,
  ),
  // NOWEB only keeps chats and messages (needed for the history import) with its store switched on.
  createSession: () => call<Json>('POST', '/api/sessions', { name: S(), start: true, config: { noweb: { store: { enabled: true, fullSync: false } } } }),
  startSession: () => call<Json>('POST', `/api/sessions/${enc(S())}/start`),
  logout: () => call<Json>('POST', `/api/sessions/${enc(S())}/logout`),
  async qr(): Promise<Buffer> {
    const res = await fetch(`${config.wahaUrl}/api/${enc(S())}/auth/qr?format=image`, {
      headers: headers({ accept: 'image/png' }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`QR code not available (${res.status})`);
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('json')) {
      const j = (await res.json()) as Json; // {mimetype, data} when the server ignores the Accept header
      return Buffer.from(j.data ?? '', 'base64');
    }
    return Buffer.from(await res.arrayBuffer());
  },

  chats: (limit: number) => call<Json[]>('GET', `/api/${enc(S())}/chats?limit=${limit}&offset=0&sortBy=conversationTimestamp&sortOrder=desc`, undefined, 60_000),
  chatsOverview: (limit: number) => call<Json[]>('GET', `/api/${enc(S())}/chats/overview?limit=${limit}&offset=0`),
  // Large limits make WEBJS page back through the phone's history, which takes a while.
  messages: (chatId: string, limit: number, downloadMedia: boolean) =>
    call<Json[]>('GET', `/api/${enc(S())}/chats/${enc(chatId)}/messages?limit=${limit}&downloadMedia=${downloadMedia}&sortBy=timestamp&sortOrder=desc`, undefined, limit > 200 ? 30 * 60_000 : 120_000),
  message: (chatId: string, id: string) => call<Json>('GET', `/api/${enc(S())}/chats/${enc(chatId)}/messages/${enc(id)}?downloadMedia=true`),
  contacts: () => call<Json[]>('GET', `/api/contacts/all?session=${enc(S())}`, undefined, 60_000),
  groups: () => call<Json>('GET', `/api/${enc(S())}/groups`, undefined, 60_000),
  group: (groupId: string) => call<Json>('GET', `/api/${enc(S())}/groups/${enc(groupId)}`, undefined, 20_000),
  participants: (groupId: string) => call<Json[]>('GET', `/api/${enc(S())}/groups/${enc(groupId)}/participants/v2`),
  chatPicture: (chatId: string) => call<{ url?: string | null }>('GET', `/api/${enc(S())}/chats/${enc(chatId)}/picture`, undefined, 20_000),
  subscribePresence: (chatId: string) => call<Json>('POST', `/api/${enc(S())}/presence/${enc(chatId)}/subscribe`, undefined, 15_000),
  markUnread: (chatId: string) => call<Json>('POST', `/api/${enc(S())}/chats/${enc(chatId)}/unread`, undefined, 15_000),
  about: (contactId: string) => call<{ about?: string | null } | null>('GET', `/api/contacts/about?session=${enc(S())}&contactId=${enc(contactId)}`, undefined, 10_000),
  lidToPhone: (lid: string) => call<{ lid: string; pn?: string | null }>('GET', `/api/${enc(S())}/lids/${enc(lid)}`, undefined, 10_000),

  sendText: (chatId: string, text: string, opts: { reply_to?: string; mentions?: string[]; linkPreview?: boolean }) =>
    call<Json>('POST', '/api/sendText', { session: S(), chatId, text, ...opts }),
  sendMedia: (kind: 'sendImage' | 'sendVideo' | 'sendFile' | 'sendVoice', chatId: string, file: WaFile, opts: { caption?: string; reply_to?: string; mentions?: string[] }) =>
    call<Json>('POST', `/api/${kind}`, { session: S(), chatId, file, ...(kind === 'sendVoice' ? { convert: true } : {}), ...opts }, 180_000),
  linkPreview: (chatId: string, text: string, preview: { url: string; title: string; description?: string; image?: { mimetype: string; data: string } }, reply_to?: string) =>
    call<Json>('POST', '/api/send/link-custom-preview', { session: S(), chatId, text, preview, reply_to }),
  react: (messageId: string, reaction: string) => call<Json>('PUT', '/api/reaction', { session: S(), messageId, reaction }),
  seen: (chatId: string, messageIds?: string[]) => call<Json>('POST', '/api/sendSeen', { session: S(), chatId, ...(messageIds?.length ? { messageIds } : {}) }),
  typing: (chatId: string, on: boolean) => call<Json>('POST', on ? '/api/startTyping' : '/api/stopTyping', { session: S(), chatId }, 10_000),
  edit: (chatId: string, messageId: string, text: string, mentions?: string[]) =>
    call<Json>('PUT', `/api/${enc(S())}/chats/${enc(chatId)}/messages/${enc(messageId)}`, { text, ...(mentions?.length ? { mentions } : {}), linkPreview: false }),
  remove: (chatId: string, messageId: string) => call<Json>('DELETE', `/api/${enc(S())}/chats/${enc(chatId)}/messages/${enc(messageId)}`),
  sendPoll: (chatId: string, name: string, options: string[], multipleAnswers: boolean) =>
    call<Json>('POST', '/api/sendPoll', { session: S(), chatId, poll: { name, options, multipleAnswers } }),
  vote: (chatId: string, pollMessageId: string, votes: string[]) => call<Json>('POST', '/api/sendPollVote', { session: S(), chatId, pollMessageId, votes }),

  /** Media files WAHA stored for a message. The URL WAHA reports may use its own hostname; we only keep the path. */
  async file(url: string): Promise<Response> {
    let path = url;
    try {
      const u = new URL(url);
      path = u.pathname + u.search;
    } catch {
      /* already a path */
    }
    if (!path.startsWith('/api/files/')) throw new Error('unexpected media url');
    return fetch(config.wahaUrl + path, { headers: headers(), signal: AbortSignal.timeout(120_000) });
  },

  wsUrl(): string {
    const events = ['session.status', 'message.any', 'message.reaction', 'message.ack', 'message.ack.group', 'message.revoked', 'message.edited', 'presence.update', 'poll.vote', 'group.v2.update', 'group.v2.participants', 'call.received', 'call.accepted', 'call.rejected', 'engine.event'];
    const q = new URLSearchParams({ session: S(), events: events.join(',') });
    if (config.wahaApiKey) q.set('x-api-key', config.wahaApiKey);
    return config.wahaUrl.replace(/^http/, 'ws') + '/ws?' + q.toString();
  },
};
