import { type CSSProperties, useEffect, useState } from 'react';
import { api, onUnauthorized } from './api';
import { ChatView, Lightbox, type LightboxItem } from './components/Chat';
import { ChatInfoPanel, MessageInfoPanel, SearchPanel } from './components/InfoPanel';
import { hideSpoilers } from './format';
import { ForwardDialog } from './components/Extras';
import { Login } from './components/Login';
import { LinkScreen, StatusScreen } from './components/Setup';
import { Sidebar, SidebarResizer } from './components/Sidebar';
import { applyEvent, getState, setState, upsertConversation, upsertMessages, useStore } from './store';
import { getPrefs, usePrefs } from './prefs';
import type { ServerEvent } from './types';

export function App() {
  const [auth, setAuth] = useState<'unknown' | 'in' | 'out'>('unknown');

  useEffect(() => {
    api.session().then((s) => setAuth(s.authenticated ? 'in' : 'out'), () => setAuth('out'));
    const out = () => setAuth('out');
    onUnauthorized.addEventListener('unauthorized', out);
    return () => onUnauthorized.removeEventListener('unauthorized', out);
  }, []);

  if (auth === 'unknown') return <div className="boot" />;
  if (auth === 'out') return <Login onDone={() => setAuth('in')} />;
  return <Main onLogout={() => api.logout().finally(() => location.reload())} />;
}

function Main({ onLogout }: { onLogout: () => void }) {
  const signal = useStore((s) => s.signal);
  const live = useStore((s) => s.live);
  const activeId = useStore((s) => s.activeId);
  const active = useStore((s) => (s.activeId ? s.conversations[s.activeId] : undefined));
  // Muted chats don't count towards the number in the tab title.
  const totalUnread = useStore((s) => Object.values(s.conversations).reduce((n, c) => n + (c.mutedUntil > Date.now() ? 0 : c.unread), 0));
  const panel = useStore((s) => s.panel);
  const forwarding = useStore((s) => s.forwarding);
  const sidebarWidth = usePrefs().sidebarWidth;
  const [lightbox, setLightbox] = useState<LightboxItem | null>(null);

  // Message info belongs to one chat: close it when switching chats.
  useEffect(() => {
    setState((s) => (s.panel?.kind === 'message' || s.panel?.kind === 'search' ? { panel: null } : {}));
  }, [activeId]);

  useLiveEvents();

  // Unread count in the tab title
  useEffect(() => {
    document.title = totalUnread ? `(${totalUnread}) Signal Web` : 'Signal Web';
  }, [totalUnread]);

  // A chat picked from "new chat" may not be in the list yet
  useEffect(() => {
    if (activeId && !active) api.conversation(activeId).then(upsertConversation).catch(() => setState({ activeId: null }));
  }, [activeId, active]);

  // Browser back button closes the open chat on phones
  useEffect(() => {
    const onPop = () => setState({ activeId: null });
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  useEffect(() => {
    if (activeId && window.matchMedia('(max-width: 760px)').matches) history.pushState({ chat: activeId }, '');
  }, [activeId]);

  if (signal.status === 'unlinked') return <LinkScreen />;
  if (signal.status === 'starting' || signal.status === 'unreachable' || signal.status === 'wrong_mode') {
    return <StatusScreen state={signal} />;
  }

  return (
    <div
      className={`app${activeId ? ' chat-open' : ''}${active && panel ? ' panel-open' : ''}`}
      style={sidebarWidth ? ({ '--side-w': `${sidebarWidth}px` } as CSSProperties) : undefined}
    >
      <SidebarResizer />
      {(!live || signal.status === 'connecting') && (
        <div className="banner" role="status">
          {!live ? 'Reconnecting to Signal Web…' : signal.error ?? 'Connecting to Signal…'}
        </div>
      )}
      <Sidebar onLogout={onLogout} />
      {active ? (
        <ChatView conversation={active} onOpenMedia={setLightbox} />
      ) : (
        <section className="chat chat-placeholder">
          <div>
            <img src="/icon.svg" alt="" width={72} height={72} />
            <h2>Signal Web</h2>
            <p>Pick a chat on the left, or start a new one with the + button. Messages stay end-to-end encrypted between Signal and this server.</p>
          </div>
        </section>
      )}
      {active && panel?.kind === 'chat' && (
        <ChatInfoPanel conversation={active} onOpenMedia={(att, authorName, sentAt) => setLightbox({ att, authorName, sentAt })} />
      )}
      {active && panel?.kind === 'message' && <MessageInfoPanel messageId={panel.messageId} />}
      {active && panel?.kind === 'search' && <SearchPanel conversation={active} />}
      {forwarding && <ForwardDialog message={forwarding} onClose={() => setState({ forwarding: null })} />}
      {lightbox && <Lightbox item={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

/** Subscribe to /api/events; on every (re)connect reload the chat list so nothing is missed. */
function useLiveEvents() {
  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;

    const resync = async () => {
      try {
        const list = await api.conversations();
        setState((s) => ({ conversations: Object.fromEntries(list.map((c) => [c.id, c])), messages: { ...s.messages } }));
        // Refresh the newest page of every chat we have open in memory.
        for (const id of Object.keys(getState().messages).map(Number)) {
          if (getState().hasNewer[id]) continue; // looking at older history; newer ones load on scroll
          api.messages(id).then((msgs) => upsertMessages(id, msgs)).catch(() => {});
        }
      } catch {
        /* handled by banner */
      }
    };

    const open = () => {
      es = new EventSource('/api/events');
      es.onopen = () => {
        setState({ live: true });
        void resync();
      };
      es.onmessage = (ev) => {
        const e = JSON.parse(ev.data) as ServerEvent;
        applyEvent(e);
        if (e.type === 'message') notify(e);
      };
      es.onerror = async () => {
        setState({ live: false });
        if (es?.readyState === EventSource.CLOSED && !closed) {
          // The browser gave up (e.g. a 401). Check the session, then retry.
          const s = await api.session().catch(() => null);
          if (s && !s.authenticated) return location.reload();
          setTimeout(open, 3000);
        }
      };
    };
    open();
    return () => {
      closed = true;
      es?.close();
    };
  }, []);
}

const notified = new Set<number>();

function notify(e: Extract<ServerEvent, { type: 'message' }>) {
  const m = e.message;
  const prefs = getPrefs();
  if (!prefs.notifications) return;
  if (m.outgoing || m.read || m.deleted || m.kind === 'system' || notified.has(m.id)) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const s = getState();
  if (document.visibilityState === 'visible' && document.hasFocus() && s.activeId === m.conversationId) return;
  const conv = s.conversations[m.conversationId];
  // Muted chats stay quiet, except when someone mentions you.
  if (conv && conv.mutedUntil > Date.now() && !m.mentions?.some((x) => x.key === 'self')) return;
  if (Date.now() - m.sentAt > 10 * 60_000) return; // don't notify for a backlog
  notified.add(m.id);
  const c = s.conversations[m.conversationId];
  const title = c?.kind === 'group' ? `${m.authorName} in ${c.title}` : m.authorName;
  const body = !prefs.notificationPreview
    ? 'New message'
    : m.kind === 'sticker'
      ? [m.sticker?.emoji, 'Sticker'].filter(Boolean).join(' ')
      : (m.body ? hideSpoilers(m.body, m.styles) : null) ?? (m.attachments.length ? 'Sent an attachment' : 'New message');
  const n = new Notification(title, { body, tag: `conv-${m.conversationId}`, icon: '/icon.svg' });
  n.onclick = () => {
    window.focus();
    setState({ activeId: m.conversationId });
    n.close();
  };
}
