import { type FormEvent, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { setState, upsertConversation, useStore } from '../store';
import type { Conversation, DirectoryContact, SearchResult } from '../types';
import { jumpToMessage } from '../jump';
import { Highlight } from './InfoPanel';
import { formatListTime } from '../util';
import { type NotifyState, notifyState, requestNotifications } from '../notifications';
import { setPrefs, usePrefs } from '../prefs';
import { SettingsView } from './Settings';
import { Avatar, Icon, StatusMark } from './ui';

export function Sidebar({ onLogout }: { onLogout: () => void }) {
  const conversations = useStore((s) => s.conversations);
  const activeId = useStore((s) => s.activeId);
  const typing = useStore((s) => s.typing);
  const account = useStore((s) => s.signal.account);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'list' | 'new' | 'settings' | 'archived'>('list');
  const drafts = useStore((s) => s.drafts);
  const [menu, setMenu] = useState(false);
  const [found, setFound] = useState<SearchResult[] | null>(null);

  // Message search across all chats, below the matching chats.
  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) return setFound(null);
    let cancelled = false;
    const t = setTimeout(() => {
      api.search(term).then((r) => !cancelled && setFound(r.results), () => !cancelled && setFound([]));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  const archivedMode = mode === 'archived';
  const { list, archivedCount, archivedUnread } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = Object.values(conversations).filter((c) => c.lastMessageAt);
    const archived = all.filter((c) => c.archived);
    const shown = all
      // Searching covers archived chats too; otherwise they live in their own list.
      .filter((c) => (q ? true : archivedMode ? c.archived : !c.archived))
      .filter((c) => !q || c.title.toLowerCase().includes(q) || c.number?.includes(q))
      .sort((a, b) => {
        // Pinned chats first, in the order they were pinned; then newest first.
        if (!archivedMode && (a.pinnedAt || b.pinnedAt)) {
          if (a.pinnedAt && b.pinnedAt) return a.pinnedAt - b.pinnedAt;
          return a.pinnedAt ? -1 : 1;
        }
        return (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0);
      });
    return { list: shown, archivedCount: archived.length, archivedUnread: archived.filter((c) => c.unread && !(c.mutedUntil > Date.now())).length };
  }, [conversations, query, archivedMode]);

  useEffect(() => {
    if (archivedMode && !archivedCount) setMode('list');
  }, [archivedMode, archivedCount]);

  if (mode === 'new') return <NewChat onClose={() => setMode('list')} />;
  if (mode === 'settings') return <SettingsView onClose={() => setMode('list')} onLogout={onLogout} />;

  if (archivedMode) {
    return (
      <aside className="sidebar">
        <header className="side-head">
          <button className="icon-btn" onClick={() => setMode('list')} aria-label="Back to chats">
            <Icon name="back" />
          </button>
          <h2>Archived</h2>
        </header>
        <p className="muted archived-note">Archived chats come back when a new message arrives, unless they're muted. Archiving only applies to Signal Web.</p>
        <nav className="chat-list" aria-label="Archived chats">
          {list.map((c) => (
            <ChatRow key={c.id} c={c} active={c.id === activeId} typing={(typing[c.id] ?? []).length > 0} draft={c.id !== activeId ? drafts[c.id]?.text : undefined} />
          ))}
        </nav>
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      <header className="side-head">
        <div className="me">
          <img src="/icon.svg" alt="" width={30} height={30} />
          <div>
            <strong>Signal Web</strong>
            <span>{account}</span>
          </div>
        </div>
        <button className="icon-btn" onClick={() => setMode('new')} title="New chat" aria-label="New chat">
          <Icon name="plus" />
        </button>
        <div className="menu-wrap">
          <button className="icon-btn" onClick={() => setMenu((m) => !m)} aria-label="Menu" aria-expanded={menu}>
            <Icon name="more" />
          </button>
          {menu && (
            <div className="menu" role="menu" onMouseLeave={() => setMenu(false)}>
              <button role="menuitem" onClick={() => (setMode('settings'), setMenu(false))}>
                <Icon name="gear" size={18} /> Settings
              </button>
              <button role="menuitem" onClick={() => (api.refreshDirectory().catch(() => {}), setMenu(false))}>
                <Icon name="refresh" size={18} /> Refresh contacts and groups
              </button>
              <button role="menuitem" onClick={onLogout}>
                <Icon name="logout" size={18} /> Sign out
              </button>
            </div>
          )}
        </div>
      </header>
      <NotifyBanner onOpenSettings={() => setMode('settings')} />
      <div className="search">
        <Icon name="search" size={18} />
        <input
          placeholder="Search chats and messages"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
          aria-label="Search chats and messages"
        />
        {query && (
          <button className="icon-btn sm" onClick={() => setQuery('')} aria-label="Clear search">
            <Icon name="close" size={16} />
          </button>
        )}
      </div>
      <nav className="chat-list" aria-label="Chats">
        {!query && archivedCount > 0 && (
          <button className="chat-row archived-row" onClick={() => setMode('archived')}>
            <span className="archived-icon">
              <Icon name="archive" size={20} />
            </span>
            <span className="chat-row-main">
              <span className="chat-title">Archived</span>
            </span>
            <span className="archived-count">{archivedUnread || archivedCount}</span>
          </button>
        )}
        {query && found && list.length > 0 && <h3 className="list-heading">Chats</h3>}
        {list.map((c) => (
          <ChatRow key={c.id} c={c} active={c.id === activeId} typing={(typing[c.id] ?? []).length > 0} draft={c.id !== activeId ? drafts[c.id]?.text : undefined} />
        ))}
        {found && found.length > 0 && (
          <>
            <h3 className="list-heading">Messages</h3>
            {found.map((r) => (
              <button key={r.id} className="chat-row search-hit" onClick={() => void jumpToMessage(r.conversationId, r.sentAt).catch(() => {})}>
                <span className="chat-row-main">
                  <span className="chat-row-top">
                    <span className="chat-title">{r.conversationTitle}</span>
                    <time>{formatListTime(r.sentAt)}</time>
                  </span>
                  <span className="chat-row-bottom">
                    <span className="preview">
                      {(r.group || r.outgoing) && <span className="preview-author">{r.outgoing ? 'You' : r.authorName}: </span>}
                      <Highlight text={r.snippet} term={query.trim()} />
                    </span>
                  </span>
                </span>
              </button>
            ))}
          </>
        )}
        {query && found && !found.length && !list.length && <div className="empty-list"><p>No chats or messages match “{query}”.</p></div>}
        {!list.length && !(query && found) && (
          <div className="empty-list">
            {query ? (
              <p>No chats match “{query}”.</p>
            ) : (
              <>
                <p>No messages yet. New messages arrive here as soon as they're sent to your number.</p>
                <button className="btn" onClick={() => setMode('new')}>
                  Start a chat
                </button>
              </>
            )}
          </div>
        )}
      </nav>
    </aside>
  );
}

/**
 * The divider between the chat list and the chat: drag it, use ←/→ when focused, or double-click to
 * reset. The width is remembered per browser.
 */
/** Like WhatsApp Web: a nudge to turn on notifications, which browsers only allow after a click. */
function NotifyBanner({ onOpenSettings }: { onOpenSettings: () => void }) {
  const prefs = usePrefs();
  const [state, setState] = useState<NotifyState>(notifyState);
  if (prefs.notifyBannerDismissed || !prefs.notifications || state === 'granted' || state === 'denied' || state === 'unsupported') return null;
  const dismiss = () => setPrefs({ notifyBannerDismissed: true });
  return (
    <div className="notify-banner" role="status">
      <Icon name="bell" size={22} />
      {state === 'insecure' ? (
        <span>
          <strong>Notifications need HTTPS</strong>
          <button className="link-btn" onClick={onOpenSettings}>
            How to turn them on
          </button>
        </span>
      ) : (
        <span>
          <strong>Get notified of new messages</strong>
          <button className="link-btn" onClick={async () => setState(await requestNotifications())}>
            Turn on desktop notifications
          </button>
        </span>
      )}
      <button className="icon-btn sm" onClick={dismiss} aria-label="Dismiss" title="Dismiss">
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}

export function SidebarResizer() {
  const width = usePrefs().sidebarWidth;
  const MIN = 260;
  const max = () => Math.min(720, window.innerWidth - 380);
  const clamp = (w: number) => Math.round(Math.max(MIN, Math.min(max(), w)));
  const current = () => (document.querySelector('.sidebar') as HTMLElement | null)?.getBoundingClientRect().width ?? 360;

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    const app = document.querySelector('.app') as HTMLElement | null;
    const left = app?.getBoundingClientRect().left ?? 0;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    let w = current();
    const move = (ev: PointerEvent) => {
      w = clamp(ev.clientX - left);
      app?.style.setProperty('--side-w', `${w}px`); // live, without re-rendering React
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing');
      setPrefs({ sidebarWidth: w });
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  return (
    <div
      className="side-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize chat list"
      aria-valuenow={Math.round(width ?? current())}
      aria-valuemin={MIN}
      aria-valuemax={max()}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={onPointerDown}
      onDoubleClick={() => {
        (document.querySelector('.app') as HTMLElement | null)?.style.removeProperty('--side-w');
        setPrefs({ sidebarWidth: null });
      }}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        setPrefs({ sidebarWidth: clamp(current() + (e.key === 'ArrowRight' ? 24 : -24)) });
      }}
    />
  );
}

const MUTE_OPTIONS: [string, number][] = [
  ['For 8 hours', 8 * 3600_000],
  ['For 1 week', 7 * 86400_000],
  ['Always', 0],
];
const FOREVER = 8.64e15; // the largest date JS can show

function ChatRowMenu({ c, onClose }: { c: Conversation; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [muteOpen, setMuteOpen] = useState(false);
  const muted = c.mutedUntil > Date.now();
  async function set(f: Parameters<typeof api.setFlags>[1]) {
    try {
      upsertConversation(await api.setFlags(c.id, f));
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="menu row-menu" role="menu" onMouseLeave={onClose}>
      {!c.archived && (
        <button role="menuitem" onClick={() => void set({ pinned: !c.pinnedAt })}>
          <Icon name="pin" size={18} /> {c.pinnedAt ? 'Unpin chat' : 'Pin chat'}
        </button>
      )}
      {muted ? (
        <button role="menuitem" onClick={() => void set({ mutedUntil: 0 })}>
          <Icon name="bell" size={18} /> Unmute
        </button>
      ) : muteOpen ? (
        MUTE_OPTIONS.map(([label, ms]) => (
          <button key={label} role="menuitem" className="sub" onClick={() => void set({ mutedUntil: ms ? Date.now() + ms : FOREVER })}>
            {label}
          </button>
        ))
      ) : (
        <button role="menuitem" onClick={() => setMuteOpen(true)}>
          <Icon name="mute" size={18} /> Mute notifications…
        </button>
      )}
      <button role="menuitem" onClick={() => void set({ archived: !c.archived })}>
        <Icon name={c.archived ? 'unarchive' : 'archive'} size={18} /> {c.archived ? 'Unarchive' : 'Archive chat'}
      </button>
      {error && <p className="form-error pad">{error}</p>}
    </div>
  );
}

function ChatRow({ c, active, typing, draft }: { c: Conversation; active: boolean; typing: boolean; draft?: string }) {
  const lm = c.lastMessage;
  const [menu, setMenu] = useState(false);
  const muted = c.mutedUntil > Date.now();
  return (
    <div
      className={`chat-row-wrap${menu ? ' menu-open' : ''}`}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu(true);
      }}
    >
    <button className={`chat-row${active ? ' active' : ''}${c.unread ? ' unread' : ''}${muted ? ' muted' : ''}`} onClick={() => setState({ activeId: c.id })} aria-current={active}>
      <Avatar name={c.title} seed={String(c.number ?? c.title)} group={c.kind === 'group'} src={c.avatar} />
      <span className="chat-row-main">
        <span className="chat-row-top">
          <span className="chat-title">{c.title}</span>
          {c.lastMessageAt && <time>{formatListTime(c.lastMessageAt)}</time>}
        </span>
        <span className="chat-row-bottom">
          <span className="preview">
            {typing ? (
              <em className="typing-text">typing…</em>
            ) : draft ? (
              <>
                <span className="draft-label">Draft: </span>
                {draft}
              </>
            ) : lm ? (
              <>
                {lm.outgoing && <StatusMark status={lm.status} />}
                {lm.authorName && <span className="preview-author">{lm.authorName}: </span>}
                {lm.text}
              </>
            ) : null}
          </span>
          <span className="row-icons">
            {muted && <Icon name="mute" size={16} title="Muted" />}
            {c.pinnedAt && <Icon name="pin" size={16} title="Pinned" />}
          </span>
          {c.unread > 0 && <span className="badge" aria-label={`${c.unread} unread`}>{c.unread > 99 ? '99+' : c.unread}</span>}
        </span>
      </span>
    </button>
      <button className="icon-btn sm row-menu-btn" onClick={() => setMenu((m) => !m)} aria-label={`Options for ${c.title}`} aria-expanded={menu} title="Chat options">
        <Icon name="chevron" size={20} />
      </button>
      {menu && <ChatRowMenu c={c} onClose={() => setMenu(false)} />}
    </div>
  );
}

function NewChat({ onClose }: { onClose: () => void }) {
  const [dir, setDir] = useState<{ contacts: DirectoryContact[]; groups: { id: number; title: string }[] } | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.directory().then(setDir).catch((e) => setError(e.message));
    input.current?.focus();
  }, []);

  async function open(b: { number?: string; uuid?: string }) {
    try {
      const c = await api.startChat(b);
      upsertConversation(c);
      setState({ activeId: c.id });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const query = q.trim().toLowerCase();
  const looksLikeNumber = /^\+?[\d\s()-]{7,}$/.test(q.trim());
  const contacts = (dir?.contacts ?? []).filter((c) => !query || c.name.toLowerCase().includes(query) || c.number?.includes(query.replace(/\s/g, '')));
  const groups = (dir?.groups ?? []).filter((g) => !query || g.title.toLowerCase().includes(query));

  function submit(e: FormEvent) {
    e.preventDefault();
    if (looksLikeNumber) open({ number: q.trim().startsWith('+') ? q.trim() : '+' + q.trim() });
    else if (contacts[0]) open({ uuid: contacts[0].uuid ?? undefined, number: contacts[0].number ?? undefined });
  }

  return (
    <aside className="sidebar">
      <header className="side-head">
        <button className="icon-btn" onClick={onClose} aria-label="Back to chats">
          <Icon name="back" />
        </button>
        <h2>New chat</h2>
      </header>
      <form className="search" onSubmit={submit}>
        <Icon name="search" size={18} />
        <input ref={input} placeholder="Name or phone number (+31…)" value={q} onChange={(e) => (setQ(e.target.value), setError(null))} aria-label="Name or phone number" />
      </form>
      {error && <p className="form-error pad">{error}</p>}
      <nav className="chat-list">
        {looksLikeNumber && (
          <button className="chat-row" onClick={submit}>
            <Avatar name="#" seed={q} />
            <span className="chat-row-main">
              <span className="chat-title">Message {q.trim()}</span>
            </span>
          </button>
        )}
        {groups.length > 0 && <h3 className="list-heading">Groups</h3>}
        {groups.map((g) => (
          <button key={g.id} className="chat-row" onClick={() => (setState({ activeId: g.id }), onClose())}>
            <Avatar name={g.title} seed={g.title} group />
            <span className="chat-row-main">
              <span className="chat-title">{g.title}</span>
            </span>
          </button>
        ))}
        {contacts.length > 0 && <h3 className="list-heading">Contacts</h3>}
        {contacts.map((c) => (
          <button key={c.key} className="chat-row" onClick={() => open({ uuid: c.uuid ?? undefined, number: c.number ?? undefined })}>
            <Avatar name={c.name} seed={String(c.number ?? c.name)} />
            <span className="chat-row-main">
              <span className="chat-title">{c.name}</span>
              <span className="preview">{c.number ?? (c.username ? '@' + c.username : '')}</span>
            </span>
          </button>
        ))}
        {dir && !contacts.length && !groups.length && !looksLikeNumber && (
          <div className="empty-list">
            <p>{query ? 'No contacts match. Type a full phone number to message someone new.' : 'Contacts appear here once your phone has synced them. This can take a few minutes after linking.'}</p>
          </div>
        )}
      </nav>
    </aside>
  );
}
