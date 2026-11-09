/**
 * The left column. Modes: the chat list, archived chats, New chat (search, start by number, New group,
 * join a WhatsApp group by link), New group (GroupManage.tsx), Settings (Settings.tsx), and the sticker
 * manager when `stickerManager` is set in the store. The chat list: pinned chats first (drag to
 * reorder), search across chats, the ⋮ menu (New group, Mark all as read, Settings, Sticker manager,
 * refresh, sign out), per-row menus (pin, mute, archive, mark unread), the notifications banner, and the
 * resizer on its right edge.
 */
import { type FormEvent, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { getState, setState, upsertConversation, useStore } from '../store';
import type { Conversation, SearchResult } from '../types';
import { jumpToMessage } from '../jump';
import { Highlight } from './InfoPanel';
import { formatListTime } from '../util';
import { type NotifyState, notifyState, requestNotifications } from '../notifications';
import { setPrefs, usePrefs } from '../prefs';
import { type SettingsPage, SettingsView } from './Settings';
import { StickerManager } from './StickerManager';
import { JoinByLink, NewGroup } from './GroupManage';
import { Avatar, Icon, StatusMark, useMenu } from './ui';
import { Emojified } from '../emoji/render';

type TypingKind = 'typing' | 'recording' | null;
function typingKind(list: { recording?: boolean }[] | undefined): TypingKind {
  if (!list?.length) return null;
  return list.every((t) => t.recording) ? 'recording' : 'typing';
}

export function Sidebar({ onLogout }: { onLogout: () => void }) {
  const conversations = useStore((s) => s.conversations);
  const activeId = useStore((s) => s.activeId);
  const stickerManager = useStore((s) => s.stickerManager);
  const anyUnread = Object.values(conversations).some((c) => c.unread > 0 || c.markedUnread);
  const typing = useStore((s) => s.typing);
  const account = useStore((s) => [s.signal.account, s.whatsapp.me].filter(Boolean).join(" · "));
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'list' | 'new' | 'group' | 'settings' | 'archived'>('list');
  const [settingsPage, setSettingsPage] = useState<SettingsPage | null>(null);
  const drafts = useStore((s) => s.drafts);
  const [menu, setMenu, menuRef] = useMenu();
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
    return { list: shown, archivedCount: archived.length, archivedUnread: archived.filter((c) => (c.unread || c.markedUnread) && !(c.mutedUntil > Date.now())).length };
  }, [conversations, query, archivedMode]);

  useEffect(() => {
    if (archivedMode && !archivedCount) setMode('list');
  }, [archivedMode, archivedCount]);

  // Dragging a pinned chat onto another pinned chat moves it there.
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<{ id: number; after: boolean } | null>(null);
  const drag: PinDrag = {
    dragging,
    over,
    start: (id) => setDragging(id),
    hover: (id, after) => dragging !== null && (over?.id !== id || over.after !== after) && setOver({ id, after }),
    end: () => (setDragging(null), setOver(null)),
    drop: () => {
      if (dragging !== null && over && over.id !== dragging) {
        const ids = pinnedInOrder(conversations).map((x) => x.id).filter((id) => id !== dragging);
        const at = ids.indexOf(over.id) + (over.after ? 1 : 0);
        ids.splice(at, 0, dragging);
        void savePinnedOrder(ids);
      }
      setDragging(null);
      setOver(null);
    },
  };

  if (mode === 'new') return <NewChat onClose={() => setMode('list')} onNewGroup={() => setMode('group')} />;
  if (mode === 'group') return <NewGroup onClose={() => setMode('list')} />;
  if (stickerManager) return <StickerManager />;
  if (mode === 'settings') return <SettingsView onClose={() => (setMode('list'), setSettingsPage(null))} onLogout={onLogout} initialPage={settingsPage} />;

  if (archivedMode) {
    return (
      <aside className="sidebar">
        <header className="side-head">
          <button className="icon-btn" onClick={() => setMode('list')} aria-label="Back to chats">
            <Icon name="back" />
          </button>
          <h2>Archived</h2>
        </header>
        <p className="muted archived-note">Archived chats come back when a new message arrives, unless they're muted. Archiving only applies to Messenger Web.</p>
        <nav className="chat-list" aria-label="Archived chats">
          {list.map((c) => (
            <ChatRow key={c.id} c={c} active={c.id === activeId} typing={typingKind(typing[c.id])} draft={c.id !== activeId ? drafts[c.id]?.text : undefined} />
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
            <strong>Messenger Web</strong>
            <span>{account}</span>
          </div>
        </div>
        <button className="icon-btn" onClick={() => setMode('new')} title="New chat" aria-label="New chat">
          <Icon name="plus" />
        </button>
        <div className="menu-wrap" ref={menuRef}>
          <button className="icon-btn" onClick={() => setMenu((m) => !m)} aria-label="Menu" aria-expanded={menu}>
            <Icon name="more" />
          </button>
          {menu && (
            <div className="menu" role="menu">
              <button role="menuitem" onClick={() => (setMode('group'), setMenu(false))}>
                <Icon name="group" size={18} /> New group
              </button>
              <button role="menuitem" disabled={!anyUnread} onClick={() => (setMenu(false), void api.markAllRead().catch(() => {}))}>
                <Icon name="read" size={18} /> Mark all as read
              </button>
              <button role="menuitem" onClick={() => (setMode('settings'), setMenu(false))}>
                <Icon name="gear" size={18} /> Settings
              </button>
              <button role="menuitem" onClick={() => (setState({ stickerManager: true }), setMenu(false))}>
                <Icon name="sticker" size={18} /> Sticker manager
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
      <NotifyBanner onOpenSettings={() => (setSettingsPage('notifications'), setMode('settings'))} />
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
          <ChatRow
            key={c.id}
            c={c}
            active={c.id === activeId}
            typing={typingKind(typing[c.id])}
            draft={c.id !== activeId ? drafts[c.id]?.text : undefined}
            drag={!query && c.pinnedAt ? drag : undefined}
          />
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

/** Pinned chats in their order, top first. */
function pinnedInOrder(conversations: Record<number, Conversation>): Conversation[] {
  return Object.values(conversations)
    .filter((c) => c.pinnedAt && !c.archived)
    .sort((a, b) => a.pinnedAt! - b.pinnedAt!);
}

/** Save a new order of pinned chats; the list updates right away. */
async function savePinnedOrder(ids: number[]) {
  const before = getState().conversations;
  setState((s) => {
    const conversations = { ...s.conversations };
    ids.forEach((id, i) => conversations[id] && (conversations[id] = { ...conversations[id], pinnedAt: i + 1 }));
    return { conversations };
  });
  try {
    for (const c of (await api.pinnedOrder(ids)).conversations) upsertConversation(c);
  } catch {
    setState({ conversations: before });
  }
}

const MUTE_OPTIONS: [string, number][] = [
  ['For 8 hours', 8 * 3600_000],
  ['For 1 week', 7 * 86400_000],
  ['Always', 0],
];
const FOREVER = 8.64e15; // the largest date JS can show

const NO_PINS: Conversation[] = [];

export function ChatRowMenu({ c, onClose, className = 'row-menu' }: { c: Conversation; onClose: () => void; className?: string }) {
  const [error, setError] = useState<string | null>(null);
  const [muteOpen, setMuteOpen] = useState(false);
  const muted = c.mutedUntil > Date.now();
  const conversations = useStore((s) => s.conversations);
  const pinned = useMemo(() => (c.pinnedAt ? pinnedInOrder(conversations) : NO_PINS), [c.pinnedAt, conversations]);
  const at = pinned.findIndex((x) => x.id === c.id);
  function move(by: number) {
    const ids = pinned.map((x) => x.id);
    ids.splice(at, 1);
    ids.splice(at + by, 0, c.id);
    void savePinnedOrder(ids);
    onClose();
  }
  async function set(f: Parameters<typeof api.setFlags>[1]) {
    try {
      upsertConversation(await api.setFlags(c.id, f));
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function markUnread() {
    try {
      // Close the chat first, or having it open would mark it read straight away.
      if (getState().activeId === c.id) setState({ activeId: null });
      upsertConversation(await api.markUnread(c.id));
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function markRead() {
    try {
      await api.markRead(c.id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className={`menu ${className}`} role="menu">
      {!c.archived && (
        <button role="menuitem" onClick={() => void set({ pinned: !c.pinnedAt })}>
          <Icon name="pin" size={18} /> {c.pinnedAt ? 'Unpin chat' : 'Pin chat'}
        </button>
      )}
      {at > 0 && (
        <button role="menuitem" onClick={() => move(-1)}>
          <Icon name="up" size={18} /> Move up
        </button>
      )}
      {at >= 0 && at < pinned.length - 1 && (
        <button role="menuitem" onClick={() => move(1)}>
          <Icon name="down" size={18} /> Move down
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
      <button role="menuitem" onClick={() => (setState({ activeId: c.id, panel: { kind: 'search', date: true } }), onClose())}>
        <Icon name="calendar" size={18} /> Go to date…
      </button>
      {c.unread || c.markedUnread ? (
        <button role="menuitem" onClick={() => void markRead()}>
          <Icon name="read" size={18} /> Mark as read
        </button>
      ) : (
        <button role="menuitem" onClick={() => void markUnread()}>
          <Icon name="unread" size={18} /> Mark as unread
        </button>
      )}
      <button role="menuitem" onClick={() => void set({ archived: !c.archived })}>
        <Icon name={c.archived ? 'unarchive' : 'archive'} size={18} /> {c.archived ? 'Unarchive' : 'Archive chat'}
      </button>
      {error && <p className="form-error pad">{error}</p>}
    </div>
  );
}

interface PinDrag {
  dragging: number | null;
  over: { id: number; after: boolean } | null;
  start: (id: number) => void;
  hover: (id: number, after: boolean) => void;
  end: () => void;
  drop: () => void;
}

function ChatRow({ c, active, typing, draft, drag }: { c: Conversation; active: boolean; typing: TypingKind; draft?: string; drag?: PinDrag }) {
  const multi = useStore((s) => s.whatsapp.status !== 'disabled' && s.signal.status !== 'disabled');
  const lm = c.lastMessage;
  const [menu, setMenu, menuRef] = useMenu<HTMLSpanElement>();
  const muted = c.mutedUntil > Date.now();
  return (
    <div
      className={`chat-row-wrap${menu ? ' menu-open' : ''}${active ? ' active' : ''}${drag?.dragging === c.id ? ' dragging' : ''}${
        drag?.over?.id === c.id && drag.dragging !== c.id ? (drag.over.after ? ' drop-after' : ' drop-before') : ''
      }`}
      draggable={!!drag}
      onDragStart={
        drag
          ? (e) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', c.title);
              drag.start(c.id);
            }
          : undefined
      }
      onDragOver={
        drag
          ? (e) => {
              if (drag.dragging === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              const r = e.currentTarget.getBoundingClientRect();
              drag.hover(c.id, e.clientY > r.top + r.height / 2);
            }
          : undefined
      }
      onDrop={drag ? (e) => (e.preventDefault(), drag.drop()) : undefined}
      onDragEnd={drag ? () => drag.end() : undefined}
      title={drag ? 'Drag to reorder pinned chats' : undefined}
    >
    <button className={`chat-row${active ? ' active' : ''}${c.unread || c.markedUnread ? ' unread' : ''}${muted ? ' muted' : ''}`} onClick={() => setState({ activeId: c.id })} aria-current={active}>
      <Avatar name={c.title} seed={String(c.number ?? c.title)} group={c.kind === 'group'} src={c.avatar} network={multi ? c.network : undefined} />
      <span className="chat-row-main">
        <span className="chat-row-top">
          <span className="chat-title">
            <Emojified text={c.title} />
          </span>
          {c.lastMessageAt && <time>{formatListTime(c.lastMessageAt)}</time>}
        </span>
        <span className="chat-row-bottom">
          <span className="preview">
            {typing ? (
              <em className="typing-text">{typing === 'recording' ? 'recording audio…' : 'typing…'}</em>
            ) : draft ? (
              <>
                <span className="draft-label">Draft: </span>
                <Emojified text={draft} />
              </>
            ) : lm ? (
              <>
                {lm.outgoing && <StatusMark status={lm.status} />}
                {lm.authorName && <span className="preview-author">{lm.authorName}: </span>}
                <Emojified text={lm.text} />
              </>
            ) : null}
          </span>
          <span className="row-icons">
            {muted && <Icon name="mute" size={16} title="Muted" />}
            {c.pinnedAt && <Icon name="pin" size={16} title="Pinned" />}
          </span>
          {c.unread > 0 ? (
            <span className="badge" aria-label={`${c.unread} unread`}>{c.unread > 99 ? '99+' : c.unread}</span>
          ) : (
            c.markedUnread && <span className="badge badge-dot" aria-label="Marked as unread" />
          )}
        </span>
      </span>
    </button>
      <span className="row-menu-anchor" ref={menuRef}>
        <button className="icon-btn sm row-menu-btn" onClick={() => setMenu((m) => !m)} aria-label={`Options for ${c.title}`} aria-expanded={menu} title="Chat options">
          <Icon name="chevron" size={20} />
        </button>
        {menu && <ChatRowMenu c={c} onClose={() => setMenu(false)} />}
      </span>
    </div>
  );
}

function NewChat({ onClose, onNewGroup }: { onClose: () => void; onNewGroup: () => void }) {
  const [joining, setJoining] = useState(false);
  const [dir, setDir] = useState<Awaited<ReturnType<typeof api.directory>> | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const signalOn = useStore((s) => s.signal.status !== 'disabled');
  const waOn = useStore((s) => s.whatsapp.status !== 'disabled');
  const multi = signalOn && waOn;

  useEffect(() => {
    api.directory().then(setDir).catch((e) => setError(e.message));
    input.current?.focus();
  }, []);

  async function open(b: Parameters<typeof api.startChat>[0]) {
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
  const typed = q.trim().startsWith('+') ? q.trim() : '+' + q.trim();
  const digits = query.replace(/[\s()+-]/g, '');
  const matches = (name: string, number: string | null) => !query || name.toLowerCase().includes(query) || (!!digits && !!number?.replace(/\D/g, '').includes(digits));
  const contacts = signalOn ? (dir?.contacts ?? []).filter((c) => matches(c.name, c.number)) : [];
  const waContacts = waOn ? (dir?.waContacts ?? []).filter((c) => matches(c.name, c.number)) : [];
  const groups = (dir?.groups ?? []).filter((g) => !query || g.title.toLowerCase().includes(query));

  function submit(e: FormEvent) {
    e.preventDefault();
    if (looksLikeNumber) open(signalOn ? { number: typed } : { number: typed, network: 'whatsapp' });
    else if (contacts[0]) open({ uuid: contacts[0].uuid ?? undefined, number: contacts[0].number ?? undefined });
    else if (waContacts[0]) open({ network: 'whatsapp', jid: waContacts[0].jid });
  }

  const empty = dir && !contacts.length && !waContacts.length && !groups.length && !looksLikeNumber;

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
        {!query && (
          <>
            <button className="chat-row action-row" onClick={onNewGroup}>
              <span className="round-icon">
                <Icon name="group" size={22} />
              </span>
              <span className="chat-row-main">
                <span className="chat-title">New group</span>
              </span>
            </button>
            {waOn && (
              <button className="chat-row action-row" onClick={() => setJoining((j) => !j)} aria-expanded={joining}>
                <span className="round-icon">
                  <Icon name="link" size={22} />
                </span>
                <span className="chat-row-main">
                  <span className="chat-title">Join a WhatsApp group with a link</span>
                </span>
              </button>
            )}
            {joining && <JoinByLink onJoined={onClose} />}
          </>
        )}
        {looksLikeNumber && signalOn && (
          <button className="chat-row" onClick={() => open({ number: typed })}>
            <Avatar name="#" seed={q} network={multi ? 'signal' : undefined} />
            <span className="chat-row-main">
              <span className="chat-title">Message {typed}{multi ? ' on Signal' : ''}</span>
            </span>
          </button>
        )}
        {looksLikeNumber && waOn && (
          <button className="chat-row" onClick={() => open({ number: typed, network: 'whatsapp' })}>
            <Avatar name="#" seed={q + 'wa'} network={multi ? 'whatsapp' : undefined} />
            <span className="chat-row-main">
              <span className="chat-title">Message {typed}{multi ? ' on WhatsApp' : ''}</span>
            </span>
          </button>
        )}
        {groups.length > 0 && <h3 className="list-heading">Groups</h3>}
        {groups.map((g) => (
          <button key={g.id} className="chat-row" onClick={() => (setState({ activeId: g.id }), onClose())}>
            <Avatar name={g.title} seed={g.title} group network={multi ? g.network : undefined} />
            <span className="chat-row-main">
              <span className="chat-title">{g.title}</span>
            </span>
          </button>
        ))}
        {contacts.length > 0 && <h3 className="list-heading">{multi ? 'Signal contacts' : 'Contacts'}</h3>}
        {contacts.map((c) => (
          <button key={c.key} className="chat-row" onClick={() => open({ uuid: c.uuid ?? undefined, number: c.number ?? undefined })}>
            <Avatar name={c.name} seed={String(c.number ?? c.name)} network={multi ? 'signal' : undefined} />
            <span className="chat-row-main">
              <span className="chat-title">{c.name}</span>
              <span className="preview">{c.number ?? (c.username ? '@' + c.username : '')}</span>
            </span>
          </button>
        ))}
        {waContacts.length > 0 && <h3 className="list-heading">{multi ? 'WhatsApp contacts' : 'Contacts'}</h3>}
        {waContacts.map((c) => (
          <button key={c.jid} className="chat-row" onClick={() => open({ network: 'whatsapp', jid: c.jid })}>
            <Avatar name={c.name} seed={String(c.number ?? c.name)} network={multi ? 'whatsapp' : undefined} src={`/api/avatars/wa/${encodeURIComponent(c.jid)}.jpg`} />
            <span className="chat-row-main">
              <span className="chat-title">{c.name}</span>
              <span className="preview">{c.number ?? ''}</span>
            </span>
          </button>
        ))}
        {empty && (
          <div className="empty-list">
            <p>{query ? 'No contacts match. Type a full phone number to message someone new.' : 'Contacts appear here once your phone has synced them. This can take a few minutes after linking.'}</p>
          </div>
        )}
      </nav>
    </aside>
  );
}
