import type { WaContact, WaState } from './types';
import type { Conversation, ConversationInfo, DirectoryContact, Message, Recipient, SearchResult, SignalState, StickerPack, StyleRange } from './types';

/** Text for sending: U+FFFC where each mention goes, plus style and mention ranges. */
export interface RichText {
  text: string;
  styles?: StyleRange[];
  mentions?: { start: number; length: number; key: string }[];
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/** Fired when the server says our session is gone. */
export const onUnauthorized = new EventTarget();

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && url !== '/api/login') onUnauthorized.dispatchEvent(new Event('unauthorized'));
    throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
  }
  return data as T;
}

export const api = {
  session: () => call<{ authenticated: boolean }>('GET', '/api/session'),
  login: (password: string) => call<{ ok: true }>('POST', '/api/login', { password }),
  logout: () => call<{ ok: true }>('POST', '/api/logout'),
  state: () => call<SignalState>('GET', '/api/state'),
  conversations: () => call<Conversation[]>('GET', '/api/conversations'),
  conversation: (id: number) => call<Conversation>('GET', `/api/conversations/${id}`),
  info: (id: number) => call<ConversationInfo>('GET', `/api/conversations/${id}/info`),
  messageInfo: (id: number) => call<{ message: Message; recipients: Recipient[] }>('GET', `/api/messages/${id}/info`),
  config: () => call<{ giphyApiKey: string | null; giphyRating: string }>('GET', '/api/config'),
  startChat: (b: { number?: string; uuid?: string; network?: 'whatsapp'; jid?: string }) => call<Conversation>('POST', '/api/conversations', b),
  directory: () =>
    call<{ contacts: DirectoryContact[]; groups: { id: number; title: string; network: 'signal' | 'whatsapp' }[]; waContacts: WaContact[] }>('GET', '/api/directory'),
  whatsapp: () => call<WaState>('GET', '/api/whatsapp'),
  whatsappLogout: () => call<WaState>('POST', '/api/whatsapp/logout'),
  whatsappRestart: () => call<WaState>('POST', '/api/whatsapp/restart'),
  whatsappImport: () => call<{ started: true }>('POST', '/api/whatsapp/import'),
  whatsappRefresh: () => call<{ ok: true }>('POST', '/api/whatsapp/refresh'),
  refreshDirectory: () => call<{ contacts: DirectoryContact[]; groups: { id: number; title: string }[] }>('POST', '/api/directory/refresh'),
  messages: (id: number, before?: number, limit = 50) =>
    call<Message[]>('GET', `/api/conversations/${id}/messages?limit=${limit}${before ? `&before=${before}` : ''}`),
  messagesAfter: (id: number, after: number, limit = 50) => call<Message[]>('GET', `/api/conversations/${id}/messages?limit=${limit}&after=${after}`),
  messagesAround: (id: number, ts: number, limit = 60) =>
    call<{ messages: Message[]; hasOlder: boolean; hasNewer: boolean }>('GET', `/api/conversations/${id}/messages?limit=${limit}&around=${ts}`),
  search: (q: string, conversationId?: number) =>
    call<{ results: SearchResult[] }>('GET', `/api/search?q=${encodeURIComponent(q)}${conversationId ? `&conversationId=${conversationId}` : ''}`),
  linkPreview: (url: string) =>
    call<{ preview: { url: string; title: string; description: string | null; image: string | null } | null }>('GET', `/api/link-preview?url=${encodeURIComponent(url)}`),
  forward: (id: number, conversationIds: number[]) => call<{ messages: Message[] }>('POST', `/api/messages/${id}/forward`, { conversationIds }),
  createPoll: (id: number, b: { question: string; options: string[]; multiple: boolean }) => call<Message>('POST', `/api/conversations/${id}/polls`, b),
  vote: (id: number, options: number[]) => call<Message>('POST', `/api/messages/${id}/vote`, { options }),
  closePoll: (id: number) => call<Message>('DELETE', `/api/messages/${id}/poll`),
  pinnedOrder: (ids: number[]) => call<{ conversations: Conversation[] }>('POST', '/api/pinned/order', { ids }),
  setFlags: (id: number, f: { pinned?: boolean; archived?: boolean; mutedUntil?: number }) => call<Conversation>('POST', `/api/conversations/${id}/flags`, f),
  emojiUsage: () => call<{ usage: Record<string, { score: number; alias?: string }> }>('GET', '/api/emoji/usage'),
  emojiAlias: (emoji: string, code: string) => call<{ ok: true }>('POST', '/api/emoji/alias', { emoji, code }),
  setTimer: (id: number, seconds: number) => call<Conversation>('POST', `/api/conversations/${id}/timer`, { seconds }),
  profile: () => call<Profile>('GET', '/api/profile'),
  updateProfile: (b: { givenName: string; about: string; avatar?: string | null }) => call<Profile>('POST', '/api/profile', b),
  setGroupAvatar: (id: number, avatar: string) => call<Conversation>('POST', `/api/conversations/${id}/avatar`, { avatar }),
  settings: () => call<ServerSettings>('GET', '/api/settings'),
  updateSettings: (patch: Partial<Pick<ServerSettings, 'sendReadReceipts' | 'sendTypingIndicators' | 'sendLinkPreviews' | 'waHistoryChats' | 'waHistoryMessages'>>) =>
    call<ServerSettings>('POST', '/api/settings', patch),
  logoutAll: () => call<{ ok: true }>('POST', '/api/logout-all'),
  stickers: () => call<{ packs: StickerPack[] }>('GET', '/api/stickers'),
  addStickerPack: (link: string) => call<{ packs: StickerPack[] }>('POST', '/api/stickers/packs', { link }),
  send: (
    id: number,
    b: RichText & { quoteId?: number; previewUrl?: string; attachments?: { name: string; type: string; data: string }[]; sticker?: { packId: string; stickerId: number } },
  ) =>
    call<Message>('POST', `/api/conversations/${id}/messages`, b),
  edit: (id: number, b: RichText) => call<Message>('POST', `/api/messages/${id}/edit`, b),
  retry: (id: number) => call<Message>('POST', `/api/messages/${id}/retry`),
  react: (id: number, emoji: string) => call<Message>('POST', `/api/messages/${id}/reactions`, { emoji }),
  remove: (id: number) => call<Message>('DELETE', `/api/messages/${id}`),
  opened: (id: number) => call<{ ok: true }>('POST', `/api/conversations/${id}/open`),
  markUnread: (id: number) => call<Conversation>('POST', `/api/conversations/${id}/unread`),
  markRead: (id: number) => call<{ ok: true }>('POST', `/api/conversations/${id}/read`),
  typing: (id: number, typing: boolean) => call<{ ok: true }>('POST', `/api/conversations/${id}/typing`, { typing }),
};

export interface Profile {
  known: boolean;
  givenName: string;
  familyName: string;
  about: string;
  avatar: string | null;
}

export interface ServerSettings {
  sendReadReceipts: boolean;
  sendTypingIndicators: boolean;
  sendLinkPreviews: boolean;
  waHistoryChats: number; // 0 = as many as possible
  waHistoryMessages: number;
  account: string | null;
  status: string;
  apiVersion: string | null;
  deviceName: string;
  giphyConfigured: boolean;
  sessions: number;
}

export function attachmentUrl(id: string, download?: string) {
  return `/api/attachments/${encodeURIComponent(id)}${download ? `?download=1&name=${encodeURIComponent(download)}` : ''}`;
}
