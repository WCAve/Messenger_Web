/** App state in one small external store (useSyncExternalStore), fed by the API and the event stream. */
import { useSyncExternalStore } from 'react';
import type { Conversation, Message, ServerEvent, SignalState, WaState } from './types';

export interface Typing {
  author: string;
  authorName: string;
  until: number;
  recording?: boolean; // recording a voice message
}

export interface Draft {
  text: string;
  mentions: { name: string; key: string }[];
}

const DRAFTS_KEY = 'sw-drafts';
function loadDrafts(): Record<number, Draft> {
  try {
    return JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

export interface State {
  signal: SignalState;
  whatsapp: WaState;
  live: boolean; // event stream connected
  conversations: Record<number, Conversation>;
  messages: Record<number, Message[]>; // by conversation, sorted by sentAt
  hasMore: Record<number, boolean>;
  /** True while a chat shows an older stretch of history (after jumping to a search result). */
  hasNewer: Record<number, boolean>;
  /** Scroll to and highlight this message once it's in the list. */
  focus: { conversationId: number; sentAt: number; nonce: number } | null;
  typing: Record<number, Typing[]>;
  /** WhatsApp: someone online, or when they were last seen (by conversation). */
  presence: Record<number, { online: boolean; lastSeen: number | null }>;
  activeId: number | null;
  /** Right-hand panel: info about the open chat, or delivery info for one of your messages. */
  panel: { kind: 'chat' } | { kind: 'search'; date?: boolean } | { kind: 'message'; messageId: number } | null;
  /** Unsent text per chat (this browser only). */
  drafts: Record<number, Draft>;
  /** The message being forwarded (the forward dialog is open). */
  forwarding: Message | null;
  /** Bumped when per-recipient receipts change, so an open message-info panel refreshes. */
  receiptTick: number;
  groupTick: Record<number, number>; // bumped when a group's details change
  /** The sticker manager is open (in the chat list column). */
  stickerManager: boolean;
}

let state: State = {
  signal: { status: 'starting' },
  whatsapp: { status: 'disabled' },
  live: false,
  conversations: {},
  messages: {},
  hasMore: {},
  hasNewer: {},
  focus: null,
  typing: {},
  presence: {},
  activeId: null,
  panel: null,
  receiptTick: 0,
  groupTick: {},
  stickerManager: false,
  drafts: loadDrafts(),
  forwarding: null,
};

let draftTimer: ReturnType<typeof setTimeout> | undefined;
export function setDraft(conversationId: number, d: Draft | null) {
  const cur = state.drafts[conversationId];
  if (!d?.text.trim()) {
    if (!cur) return;
    const { [conversationId]: _gone, ...rest } = state.drafts;
    setState({ drafts: rest });
  } else {
    if (cur && cur.text === d.text) return;
    setState((s) => ({ drafts: { ...s.drafts, [conversationId]: d } }));
  }
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try {
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(state.drafts));
    } catch {
      /* private mode: drafts live until the tab closes */
    }
  }, 300);
}

const listeners = new Set<() => void>();
export function getState() {
  return state;
}
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  listeners.forEach((l) => l());
}
export function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

function sortMessages(list: Message[]) {
  return list.sort((a, b) => a.sentAt - b.sentAt || a.id - b.id);
}

export function upsertMessages(conversationId: number, incoming: Message[], opts: { prepend?: boolean; hasMore?: boolean } = {}) {
  setState((s) => {
    const byId = new Map((s.messages[conversationId] ?? []).map((m) => [m.id, m]));
    for (const m of incoming) {
      const prev = byId.get(m.id);
      if (!prev || m.rev >= prev.rev) byId.set(m.id, m);
    }
    return {
      messages: { ...s.messages, [conversationId]: sortMessages([...byId.values()]) },
      hasMore: opts.hasMore !== undefined ? { ...s.hasMore, [conversationId]: opts.hasMore } : s.hasMore,
    };
  });
}

/** Replace a chat's loaded messages, e.g. with the stretch around a search result. */
export function replaceMessages(conversationId: number, list: Message[], opts: { hasMore: boolean; hasNewer: boolean }) {
  setState((s) => ({
    messages: { ...s.messages, [conversationId]: sortMessages([...list]) },
    hasMore: { ...s.hasMore, [conversationId]: opts.hasMore },
    hasNewer: { ...s.hasNewer, [conversationId]: opts.hasNewer },
  }));
}

export function setHasNewer(conversationId: number, v: boolean) {
  setState((s) => ({ hasNewer: { ...s.hasNewer, [conversationId]: v } }));
}

function removeMessage(conversationId: number, messageId: number) {
  const list = state.messages[conversationId];
  if (!list?.some((m) => m.id === messageId)) return;
  setState((s) => ({ messages: { ...s.messages, [conversationId]: list.filter((m) => m.id !== messageId) } }));
}

export function upsertConversation(c: Conversation) {
  setState((s) => ({ conversations: { ...s.conversations, [c.id]: c } }));
}

export function applyEvent(e: ServerEvent) {
  switch (e.type) {
    case 'state':
      setState({ signal: e.state });
      break;
    case 'wastate':
      setState({ whatsapp: e.state });
      break;
    case 'conversation':
      upsertConversation(e.conversation);
      break;
    case 'message':
      // Only keep messages for conversations we've loaded; others are fetched when opened. While a chat
      // shows an older stretch of history, new messages arrive when scrolling down instead.
      if (state.messages[e.message.conversationId]) {
        const list = state.messages[e.message.conversationId];
        const known = list.some((m) => m.id === e.message.id);
        const last = list[list.length - 1];
        if (known || !state.hasNewer[e.message.conversationId] || (last && e.message.sentAt < last.sentAt)) {
          upsertMessages(e.message.conversationId, [e.message]);
        }
      }
      if (e.message.outgoing) setState((s) => ({ receiptTick: s.receiptTick + 1 }));
      if (!e.message.outgoing) clearTyping(e.message.conversationId, e.message.author);
      break;
    case 'remove':
      removeMessage(e.conversationId, e.messageId);
      break;
    case 'group':
      setState((s) => ({ groupTick: { ...s.groupTick, [e.conversationId]: (s.groupTick[e.conversationId] ?? 0) + 1 } }));
      break;
    case 'receipt':
      setState((s) => ({ receiptTick: s.receiptTick + 1 }));
      break;
    case 'presence':
      setState((s) => ({ presence: { ...s.presence, [e.conversationId]: { online: e.online, lastSeen: e.lastSeen } } }));
      break;
    case 'typing': {
      if (!e.started) return clearTyping(e.conversationId, e.author);
      setState((s) => {
        const list = (s.typing[e.conversationId] ?? []).filter((t) => t.author !== e.author);
        list.push({ author: e.author, authorName: e.authorName, until: Date.now() + 15_000, ...(e.recording ? { recording: true } : {}) });
        return { typing: { ...s.typing, [e.conversationId]: list } };
      });
      break;
    }
  }
}

function clearTyping(conversationId: number, author: string) {
  const list = state.typing[conversationId];
  if (!list?.some((t) => t.author === author)) return;
  setState((s) => ({ typing: { ...s.typing, [conversationId]: list.filter((t) => t.author !== author) } }));
}

// Typing indicators expire if we never get the "stopped" event. Disappearing messages are removed by
// the server; this only catches one whose removal we missed while disconnected.
setInterval(() => {
  const now = Date.now();
  for (const [id, list] of Object.entries(state.messages)) {
    if (list.some((m) => m.expiresAt && m.expiresAt < now - 5000)) {
      setState((s) => ({ messages: { ...s.messages, [id]: list.filter((m) => !m.expiresAt || m.expiresAt >= now - 5000) } }));
    }
  }
  let changed = false;
  const typing: State['typing'] = {};
  for (const [id, list] of Object.entries(state.typing)) {
    const kept = list.filter((t) => t.until > now);
    if (kept.length !== list.length) changed = true;
    typing[Number(id)] = kept;
  }
  if (changed) setState({ typing });
}, 2000);
