import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { setState, upsertConversation, useStore } from '../store';
import type { Conversation, DirectoryContact } from '../types';
import { formatListTime } from '../util';
import { Avatar, Icon, StatusMark } from './ui';

export function Sidebar({ onLogout }: { onLogout: () => void }) {
  const conversations = useStore((s) => s.conversations);
  const activeId = useStore((s) => s.activeId);
  const typing = useStore((s) => s.typing);
  const account = useStore((s) => s.signal.account);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'list' | 'new'>('list');
  const [menu, setMenu] = useState(false);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(conversations)
      .filter((c) => c.lastMessageAt)
      .filter((c) => !q || c.title.toLowerCase().includes(q) || c.number?.includes(q))
      .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
  }, [conversations, query]);

  if (mode === 'new') return <NewChat onClose={() => setMode('list')} />;

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
              {'Notification' in window && Notification.permission === 'default' && (
                <button role="menuitem" onClick={() => (Notification.requestPermission(), setMenu(false))}>
                  <Icon name="bell" size={18} /> Turn on notifications
                </button>
              )}
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
      <div className="search">
        <Icon name="search" size={18} />
        <input placeholder="Search chats" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search chats" />
      </div>
      <nav className="chat-list" aria-label="Chats">
        {list.map((c) => (
          <ChatRow key={c.id} c={c} active={c.id === activeId} typing={(typing[c.id] ?? []).length > 0} />
        ))}
        {!list.length && (
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

function ChatRow({ c, active, typing }: { c: Conversation; active: boolean; typing: boolean }) {
  const lm = c.lastMessage;
  return (
    <button className={`chat-row${active ? ' active' : ''}${c.unread ? ' unread' : ''}`} onClick={() => setState({ activeId: c.id })} aria-current={active}>
      <Avatar name={c.title} seed={String(c.number ?? c.title)} group={c.kind === 'group'} />
      <span className="chat-row-main">
        <span className="chat-row-top">
          <span className="chat-title">{c.title}</span>
          {c.lastMessageAt && <time>{formatListTime(c.lastMessageAt)}</time>}
        </span>
        <span className="chat-row-bottom">
          <span className="preview">
            {typing ? (
              <em className="typing-text">typing…</em>
            ) : lm ? (
              <>
                {lm.outgoing && <StatusMark status={lm.status} />}
                {lm.authorName && <span className="preview-author">{lm.authorName}: </span>}
                {lm.text}
              </>
            ) : null}
          </span>
          {c.unread > 0 && <span className="badge" aria-label={`${c.unread} unread`}>{c.unread > 99 ? '99+' : c.unread}</span>}
        </span>
      </span>
    </button>
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
