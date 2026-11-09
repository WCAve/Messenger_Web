/**
 * The open chat: header (name, online/typing, menu), the message list and the composer.
 *
 *   ChatView      header + list + composer; also the "you left / only admins can send / blocked" bars
 *   MessageList   paging (older on scroll up, newer when you jumped back in time), day dividers, the
 *                 unread divider, keeping the scroll position, hover toolbar (react, reply, …)
 *   RichBody      text with mentions, styles, links and big-emoji; LinkPreviewCard, polls (Extras.tsx)
 *   AttachmentView / PendingImage / PendingPlayable / MissingMedia
 *                 files; WhatsApp history files that aren't downloaded yet ask the server and show a
 *                 placeholder instead of holding a request open (browsers allow only ~6 per site)
 *   Lightbox      full-screen photos/videos
 *   Composer      text box (formatting, :shortcodes:, @mentions, drafts), files, voice messages,
 *                 stickers/emoji/GIFs (Picker.tsx), replies, edits, typing indicator
 *
 * What each network can do comes from capsFor (networks.ts); the server decides how to send.
 */
import { type ClipboardEvent, type DragEvent, Fragment, type KeyboardEvent, type ReactNode, memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, attachmentUrl } from '../api';
import { emojiForCode, replaceShortcodes, searchEmoji } from '../emoji';
import { Emojified } from '../emoji/render';
import { refreshUsageSoon, rememberAlias } from '../emoji/usage';
import { type ComposerMention, composerToRich, messageToComposer, pieces } from '../format';
import { jumpToMessage, loadLatest } from '../jump';
import { getPrefs, usePrefs } from '../prefs';
import { getState, setDraft, setHasNewer, setState, upsertConversation, upsertMessages, useStore } from '../store';
import type { Attachment, Conversation, LinkPreview, Message, Network } from '../types';
import { NETWORK_LABEL, capsFor, useNetworkReady } from '../networks';
import { durationLabel, fileToBase64, formatDay, formatSize, formatTime, hueFor, isJumbomoji, safeHref, sameDay, untilLabel } from '../util';
import { type PickedGif, type PickedSticker, Picker, type PickerTab } from './Picker';
import { PollDialog, PollView } from './Extras';
import { ChatRowMenu } from './Sidebar';
import { Avatar, Icon, StatusMark, useMenu } from './ui';

const QUICK_REACTIONS = ['❤️', '👍', '👎', '😂', '😮', '😢', '🙏'];
const PAGE = 50;
const NO_TYPING: never[] = []; // stable reference: store selectors must not allocate
const reducedMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export interface LightboxItem {
  att: Attachment;
  authorName: string;
  sentAt: number;
}

const EDIT_WINDOW_MS = 24 * 3600_000 - 60_000; // Signal allows edits for 24 hours

/** Your own sent text message, less than 24 hours old (Signal's edit rules). */
export function canEdit(m: Message, network: Network = 'signal') {
  return (
    m.outgoing &&
    m.kind === 'message' &&
    !m.deleted &&
    !!m.body &&
    !m.attachments.length &&
    (m.status === 'sent' || m.status === 'delivered' || m.status === 'read') &&
    Date.now() - m.sentAt < (network === 'whatsapp' ? capsFor({ network }).editWindowMs : EDIT_WINDOW_MS)
  );
}

/** Media that loops silently: animated GIF images and Signal's GIF-style videos. */
function isLoopingMedia(a: Attachment) {
  return a.contentType === 'image/gif' || (a.contentType.startsWith('video/') && a.gif === true);
}

export function ChatView({ conversation, onOpenMedia }: { conversation: Conversation; onOpenMedia: (item: LightboxItem) => void }) {
  const id = conversation.id;
  const messages = useStore((s) => s.messages[id]);
  const hasMore = useStore((s) => s.hasMore[id] ?? true);
  const typing = useStore((s) => s.typing[id] ?? NO_TYPING);
  const connected = useNetworkReady(conversation.network);
  const multiNetwork = useStore((s) => s.whatsapp.status !== 'disabled' && s.signal.status !== 'disabled');
  const panel = useStore((s) => s.panel?.kind ?? null);
  const [chatMenu, setChatMenu, chatMenuRef] = useMenu();
  const hasNewer = useStore((s) => s.hasNewer[id] ?? false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [reactTo, setReactTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dropped, setDropped] = useState<File[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Initial load
  useEffect(() => {
    setReplyTo(null);
    setReactTo(null);
    setEditing(null);
    setLoadError(null);
    if (getState().messages[id]) return;
    api
      .messages(id, undefined, PAGE)
      .then((list) => upsertMessages(id, list, { hasMore: list.length === PAGE }))
      .catch((e) => setLoadError(e.message));
  }, [id]);

  // Tell the server (WhatsApp then starts sending "typing…" for this chat).
  useEffect(() => {
    api
      .opened(id)
      .then((r) => r.presence && setState((s) => ({ presence: { ...s.presence, [id]: r.presence! } })))
      .catch(() => {});
  }, [id]);
  const presence = useStore((s) => s.presence[id]);
  const showPresence = usePrefs().showPresence;

  // Mark read while the chat is open and the window is visible.
  useEffect(() => {
    if (!conversation.unread && !conversation.markedUnread) return;
    const mark = () => {
      if (document.visibilityState === 'visible' && document.hasFocus()) api.markRead(id).catch(() => {});
    };
    mark();
    window.addEventListener('focus', mark);
    document.addEventListener('visibilitychange', mark);
    return () => {
      window.removeEventListener('focus', mark);
      document.removeEventListener('visibilitychange', mark);
    };
  }, [id, conversation.unread, conversation.markedUnread]);

  let subtitle: string;
  if (typing.length > 0) {
    const who = conversation.kind === 'group' ? typing.map((t) => t.authorName.split(' ')[0]).join(', ') + ' ' : '';
    subtitle = who + (typing.every((t) => t.recording) ? 'recording audio…' : 'typing…');
  } else if (conversation.kind === 'group') {
    // WhatsApp-style: known names alphabetically, "You" last, unknown people counted.
    const all = conversation.members ?? [];
    const named = all.filter((m) => m.key !== 'self' && m.name !== 'Unknown').map((m) => m.name).sort((a, b) => a.localeCompare(b));
    const unknown = all.filter((m) => m.name === 'Unknown').length;
    subtitle = [...named, ...(all.some((m) => m.key === 'self') ? ['You'] : []), ...(unknown ? [`${unknown} other${unknown > 1 ? 's' : ''}`] : [])].join(', ');
  } else if (showPresence && conversation.network === 'whatsapp' && presence && (presence.online || presence.lastSeen)) {
    subtitle = presence.online ? 'online' : `last seen ${lastSeenLabel(presence.lastSeen!)}`;
  } else {
    subtitle = conversation.number ?? (conversation.username ? '@' + conversation.username : '');
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) setDropped(Array.from(e.dataTransfer.files));
  }

  const openInfo = () => setState((s) => ({ panel: s.panel?.kind === 'chat' ? null : { kind: 'chat' } }));

  return (
    <section
      className="chat"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={onDrop}
    >
      <header className="chat-head">
        <button className="icon-btn back-btn" onClick={() => setState({ activeId: null, panel: null })} aria-label="Back to chats">
          <Icon name="back" />
        </button>
        <button className="chat-head-main" onClick={openInfo} title={conversation.kind === 'group' ? 'Group info' : 'Contact info'}>
          <Avatar
            name={conversation.title}
            seed={String(conversation.number ?? conversation.title)}
            group={conversation.kind === 'group'}
            size={40}
            src={conversation.avatar}
            network={multiNetwork ? conversation.network : undefined}
          />
          <span className="chat-head-text">
            <h2>
              <Emojified text={conversation.title} />
              {conversation.expireTimer > 0 && (
                <span className="timer-badge" title={`Disappearing messages: ${durationLabel(conversation.expireTimer)}`}>
                  <Icon name="timer" size={14} />
                  {durationLabel(conversation.expireTimer, true)}
                </span>
              )}
            </h2>
            <p className={typing.length ? 'typing-text' : undefined}>{subtitle}</p>
          </span>
        </button>
        <button
          className={`icon-btn${panel === 'search' ? ' on' : ''}`}
          onClick={() => setState((s) => ({ panel: s.panel?.kind === 'search' ? null : { kind: 'search' } }))}
          aria-label="Search in this chat"
          title="Search in this chat"
        >
          <Icon name="search" />
        </button>
        <div className="menu-wrap" ref={chatMenuRef}>
          <button className={`icon-btn${chatMenu ? ' on' : ''}`} onClick={() => setChatMenu((v) => !v)} aria-label="Chat options" aria-expanded={chatMenu} title="Pin, mute or archive">
            <Icon name="more" />
          </button>
          {chatMenu && <ChatRowMenu c={conversation} onClose={() => setChatMenu(false)} className="head-menu" />}
        </div>
      </header>

      {loadError ? (
        <div className="chat-empty">
          <p className="form-error">{loadError}</p>
        </div>
      ) : (
        <MessageList
          conversation={conversation}
          messages={messages}
          hasMore={hasMore}
          hasNewer={hasNewer}
          onReply={(m) => (setEditing(null), setReplyTo(m))}
          onEdit={(m) => (setReplyTo(null), setEditing(m))}
          onMoreReactions={setReactTo}
          onOpenImage={(att, msg) => onOpenMedia({ att, authorName: msg.authorName, sentAt: msg.sentAt })}
        />
      )}

      {conversation.blocked ? (
        <BlockedBar conversation={conversation} />
      ) : conversation.left ? (
        <div className="blocked-bar">
          <span>You're no longer in this group.</span>
        </div>
      ) : conversation.sendAdminsOnly && !conversation.admin ? (
        <div className="blocked-bar">
          <span>Only admins can send messages.</span>
          <button className="link-btn" onClick={() => setState({ panel: { kind: 'chat' } })}>
            Group info
          </button>
        </div>
      ) : (
      <Composer
        key={id}
        conversation={conversation}
        replyTo={replyTo}
        clearReply={() => setReplyTo(null)}
        reactTo={reactTo}
        clearReact={() => setReactTo(null)}
        editing={editing}
        setEditing={setEditing}
        dropped={dropped}
        clearDropped={() => setDropped([])}
        disabled={!connected}
      />
      )}

      {dragging && <div className="drop-overlay">Drop files to send to {conversation.title}</div>}
    </section>
  );
}

// ---------------------------------------------------------------------------

function MessageList({
  conversation,
  messages,
  hasMore,
  hasNewer,
  onReply,
  onEdit,
  onMoreReactions,
  onOpenImage,
}: {
  conversation: Conversation;
  messages: Message[] | undefined;
  hasMore: boolean;
  hasNewer: boolean;
  onReply: (m: Message) => void;
  onEdit: (m: Message) => void;
  onMoreReactions: (m: Message) => void;
  onOpenImage: (a: Attachment, m: Message) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // keep pinned to the bottom while the user is there
  const prevHeight = useRef(0);
  const loadingOlder = useRef(false);
  const loadingNewer = useRef(false);
  const prevLastId = useRef<number | undefined>(undefined);
  const [selected, setSelected] = useState<number | null>(null);
  const [away, setAway] = useState(false); // scrolled up from the newest messages
  const focus = useStore((s) => s.focus);
  const id = conversation.id;
  const last = messages?.[messages.length - 1];
  // Unread count when this chat was opened (it drops to 0 right after, once it's marked read).
  const openInfo = useRef<{ id: number; unread: number; dividerId?: number | null; scrolled?: boolean }>({ id, unread: conversation.unread });
  if (openInfo.current.id !== id) openInfo.current = { id, unread: conversation.unread };

  useLayoutEffect(() => {
    stick.current = true;
    setAway(false);
  }, [id]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const newLast = last?.id !== prevLastId.current;
    prevLastId.current = last?.id;
    if (loadingOlder.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current; // keep position after prepending
      loadingOlder.current = false;
    } else if (loadingNewer.current) {
      loadingNewer.current = false; // appended below: nothing moves
    } else if (!hasNewer && (stick.current || (newLast && last?.outgoing))) {
      el.scrollTop = el.scrollHeight;
    }
    // On opening a chat with more unread messages than fit, start at the "unread" divider.
    if (!openInfo.current.scrolled && openInfo.current.dividerId !== undefined && messages?.length) {
      openInfo.current.scrolled = true;
      const divider = el.querySelector<HTMLElement>('.unread-divider');
      if (divider && divider.offsetTop < el.scrollTop) {
        el.scrollTop = Math.max(0, divider.offsetTop - 12);
        stick.current = false;
      }
    }
    prevHeight.current = el.scrollHeight;
  }, [messages, last?.id, last?.outgoing, hasNewer]);

  // Jump to a message (search result, quote): scroll it into view and flash it.
  useEffect(() => {
    if (!focus || focus.conversationId !== id || !messages) return;
    const el = ref.current?.querySelector<HTMLElement>(`[data-ts="${focus.sentAt}"]`);
    if (!el) return;
    stick.current = false;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1600);
    setState({ focus: null });
  }, [focus, id, messages]);

  // The list gets shorter when the composer grows (reply/edit bar, pickers): stay pinned to the bottom.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [messages === undefined]);

  // Images/GIFs finish loading after layout: stay pinned to the bottom when they do.
  const onMediaLoad = useCallback(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, []);

  const loadOlder = useCallback(async () => {
    if (loadingOlder.current || !hasMore || !messages?.length) return;
    loadingOlder.current = true;
    prevHeight.current = ref.current?.scrollHeight ?? 0;
    try {
      const older = await api.messages(id, messages[0].sentAt, PAGE);
      if (!older.length) loadingOlder.current = false;
      upsertMessages(id, older, { hasMore: older.length === PAGE });
    } catch {
      loadingOlder.current = false;
    }
  }, [id, hasMore, messages]);

  const loadNewer = useCallback(async () => {
    if (loadingNewer.current || !hasNewer || !messages?.length) return;
    loadingNewer.current = true;
    try {
      const newer = await api.messagesAfter(id, messages[messages.length - 1].sentAt, PAGE);
      if (!newer.length) loadingNewer.current = false;
      upsertMessages(id, newer);
      setHasNewer(id, newer.length === PAGE);
    } catch {
      loadingNewer.current = false;
    }
  }, [id, hasNewer, messages]);

  function onScroll() {
    const el = ref.current!;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stick.current = !hasNewer && fromBottom < 80;
    setAway(hasNewer || fromBottom > 400);
    if (el.scrollTop < 200) void loadOlder();
    if (hasNewer && fromBottom < 300) void loadNewer();
  }

  async function toLatest() {
    if (hasNewer) await loadLatest(id).catch(() => {});
    stick.current = true;
    setAway(false);
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  const jumpTo = (sentAt: number) => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-ts="${sentAt}"]`);
    if (!el) {
      void jumpToMessage(id, sentAt).catch(() => {}); // not loaded: fetch the messages around it
      return;
    }
    el.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1400);
  };

  if (!messages) return <div className="messages" />;

  // "N unread messages": decided once when the chat opens, from its unread count at that moment.
  if (openInfo.current.dividerId === undefined && messages.length) {
    const n = openInfo.current.unread;
    const incoming = messages.filter((m) => !m.outgoing && m.kind !== 'system');
    openInfo.current.dividerId = n > 0 && incoming.length ? incoming[Math.max(0, incoming.length - n)].id : null;
  }
  const dividerId = openInfo.current.dividerId;

  const items: ReactNode[] = [];
  const labels = new Map((conversation.members ?? []).filter((x) => x.label).map((x) => [x.key, x.label!]));
  messages.forEach((m, i) => {
    const prev = messages[i - 1];
    if (!prev || !sameDay(prev.sentAt, m.sentAt)) {
      items.push(
        <div className="day" key={`d${m.sentAt}`}>
          <span>{formatDay(m.sentAt)}</span>
        </div>,
      );
    }
    if (m.id === dividerId) {
      const n = openInfo.current.unread;
      items.push(
        <div className="unread-divider" key="unread">
          <span>
            {n} unread message{n === 1 ? '' : 's'}
          </span>
        </div>,
      );
    }
    const continued = !!prev && prev.author === m.author && sameDay(prev.sentAt, m.sentAt) && m.sentAt - prev.sentAt < 5 * 60_000 && prev.kind !== 'system';
    items.push(
      <MessageItem
        key={m.id}
        m={m}
        group={conversation.kind === 'group'}
        label={labels.get(m.author)}
        network={conversation.network}
        continued={continued}
        selected={selected === m.id}
        onSelect={() => setSelected((s) => (s === m.id ? null : m.id))}
        onReply={onReply}
        onEdit={onEdit}
        onMoreReactions={onMoreReactions}
        onOpenImage={onOpenImage}
        onJump={jumpTo}
        onMediaLoad={onMediaLoad}
      />,
    );
  });

  return (
    <div className="messages-wrap">
      <div className="messages" ref={ref} onScroll={onScroll} role="log" aria-live={hasNewer ? 'off' : 'polite'}>
        <div className="messages-inner">
          {!hasMore && (
            <p className="history-start">
              {messages.length ? 'Start of the history on Messenger Web. Earlier messages are on your phone.' : 'No messages yet. Say hi.'}
            </p>
          )}
          {items}
        </div>
      </div>
      {(away || hasNewer) && (
        <button className="to-latest" onClick={() => void toLatest()} aria-label="Jump to the newest messages" title="Jump to the newest messages">
          <Icon name="down" size={24} />
          {conversation.unread > 0 && <span className="badge">{conversation.unread > 99 ? '99+' : conversation.unread}</span>}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Message text with bold/italic/… styles, highlighted mentions, links and click-to-reveal spoilers. */
function RichBody({ m }: { m: Message }) {
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set());
  const list = pieces(m.body ?? '', m.styles, m.mentions);
  return (
    <>
      {list.map((p, i) => {
        let node: ReactNode = <Emojified text={p.text} />;
        if (p.styles.has('MONOSPACE')) node = <code>{node}</code>;
        if (p.styles.has('BOLD')) node = <strong>{node}</strong>;
        if (p.styles.has('ITALIC')) node = <em>{node}</em>;
        if (p.styles.has('STRIKETHROUGH')) node = <s>{node}</s>;
        if (p.mention) {
          node = (
            <span className={`mention${p.mention.key === 'self' ? ' mention-me' : ''}`} style={{ ['--hue' as string]: hueFor(p.mention.key) }}>
              {node}
            </span>
          );
        }
        if (p.link) {
          node = (
            <a href={safeHref(p.link)} target="_blank" rel="noopener noreferrer">
              {node}
            </a>
          );
        }
        if (p.spoilerId !== undefined && !revealed.has(p.spoilerId)) {
          const sid = p.spoilerId;
          const reveal = (e: { preventDefault(): void; stopPropagation(): void }) => {
            e.preventDefault();
            e.stopPropagation();
            setRevealed((r) => new Set(r).add(sid));
          };
          node = (
            <span
              className="spoiler"
              role="button"
              tabIndex={0}
              aria-label="Spoiler, click to reveal"
              title="Click to reveal"
              onClick={reveal}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && reveal(e)}
            >
              {node}
            </span>
          );
        }
        return <Fragment key={i}>{node}</Fragment>;
      })}
    </>
  );
}

function LinkPreviewCard({ p, onLoad }: { p: LinkPreview; onLoad: () => void }) {
  let host = p.url;
  try {
    host = new URL(p.url).hostname.replace(/^www\./, '');
  } catch {
    /* keep the raw url */
  }
  return (
    <a className={`link-preview${p.image ? ' with-image' : ''}`} href={safeHref(p.url)} target="_blank" rel="noopener noreferrer">
      {p.image && <img src={attachmentUrl(p.image.id)} alt="" loading="lazy" onLoad={onLoad} onError={(e) => (e.currentTarget.style.display = 'none')} />}
      <span className="link-preview-text">
        <strong>{p.title || host}</strong>
        {p.description && <span className="link-preview-desc">{p.description}</span>}
        <small>{host}</small>
      </span>
    </a>
  );
}

function GifVideo({ a, onLoad }: { a: Attachment; onLoad?: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  return (
    <video
      ref={ref}
      className="gif-video"
      src={attachmentUrl(a.id)}
      autoPlay={!reducedMotion}
      loop
      muted
      playsInline
      disablePictureInPicture
      onLoadedData={onLoad}
      onClick={() => {
        // With reduced motion GIFs start paused; a click plays/pauses them.
        const v = ref.current;
        if (v) void (v.paused ? v.play() : v.pause());
      }}
      style={a.width && a.height ? { aspectRatio: `${a.width} / ${a.height}` } : undefined}
      aria-label="GIF"
    />
  );
}

const MessageItem = memo(function MessageItem({
  m,
  group,
  label,
  network,
  continued,
  selected,
  onSelect,
  onReply,
  onEdit,
  onMoreReactions,
  onOpenImage,
  onJump,
  onMediaLoad,
}: {
  m: Message;
  group: boolean;
  label?: string;
  network: Network;
  continued: boolean;
  selected: boolean;
  onSelect: () => void;
  onReply: (m: Message) => void;
  onEdit: (m: Message) => void;
  onMoreReactions: (m: Message) => void;
  onOpenImage: (a: Attachment, m: Message) => void;
  onJump: (sentAt: number) => void;
  onMediaLoad: () => void;
}) {
  const [picker, setPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (m.kind === 'system') {
    return (
      <div className="system-line" data-ts={m.sentAt}>
        <span>
          <Emojified text={m.body} />
        </span>
      </div>
    );
  }

  // A WhatsApp sticker is an attachment marked as one (Signal's come from sticker packs).
  const waSticker = !m.deleted && m.kind === 'sticker' && !m.sticker ? m.attachments.find((a) => a.sticker) ?? null : null;
  const visual = waSticker ? [] : m.attachments.filter((a) => a.contentType.startsWith('image/') || isLoopingMedia(a));
  const others = waSticker ? [] : m.attachments.filter((a) => !visual.includes(a));
  const jumbo = !m.deleted && !m.attachments.length && !m.quote && isJumbomoji(m.body);
  const sticker = !m.deleted && m.kind === 'sticker' ? m.sticker : null;
  const canAct = !m.deleted && m.status !== 'pending' && m.status !== 'failed';

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      refreshUsageSoon();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const grouped = m.reactions.reduce<Record<string, string[]>>((acc, r) => ((acc[r.emoji] ??= []).push(r.authorName), acc), {});
  const myReaction = m.reactions.find((r) => r.author === 'self')?.emoji;

  return (
    <div
      className={`msg ${m.outgoing ? 'out' : 'in'}${continued ? ' cont' : ''}${selected ? ' selected' : ''}${m.reactions.length ? ' has-reactions' : ''}`}
      data-ts={m.sentAt}
      onMouseLeave={() => setPicker(false)}
    >
      <div
        className={`bubble${jumbo ? ' jumbo' : ''}${sticker || waSticker ? ' sticker' : ''}${m.deleted ? ' deleted' : ''}${visual.length && !m.body && !m.quote ? ' media-only' : ''}`}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('a,button,video,audio,img')) return;
          onSelect();
        }}
      >
        {group && !m.outgoing && !continued && (
          <div className="author" style={{ ['--hue' as string]: hueFor(m.author) }}>
            <Emojified text={m.authorName} />
            {label && <span className="author-label">{label}</span>}
          </div>
        )}
        {!!m.forwarded && !m.deleted && (
          <div className="forwarded">
            <Icon name="forward" size={14} /> {m.forwarded > 1 ? 'Forwarded many times' : 'Forwarded'}
          </div>
        )}
        {m.quote && (
          <button className="quote" onClick={() => onJump(m.quote!.sentAt)} style={{ ['--hue' as string]: m.quote.author === 'self' ? 'var(--self-hue)' : hueFor(m.quote.author) }}>
            <strong>
              {m.quote.author === 'self' ? 'You' : m.quote.authorName}
              {m.quote.unlinked && <span className="quote-note" title="WhatsApp no longer had this message, so the reply was sent with the quoted text"> · quoted as text</span>}
            </strong>
            <span>
              <Emojified text={m.quote.text || m.quote.media?.label || 'Attachment'} />
            </span>
            {m.quote.media?.thumb && <img className={`quote-thumb${m.quote.media.kind === 'sticker' ? ' sticker' : ''}`} src={m.quote.media.thumb} alt="" loading="lazy" />}
          </button>
        )}
        {visual.length > 0 && (
          <div className={`images n${Math.min(visual.length, 4)}`}>
            {visual.slice(0, 4).map((a, i) =>
              a.missing ? (
                <MissingMedia key={a.id} a={a} />
              ) : a.pending ? (
                <PendingImage key={a.id} a={a} />
              ) : a.contentType.startsWith('video/') ? (
                <div key={a.id} className="img-btn">
                  <GifVideo a={a} onLoad={onMediaLoad} />
                </div>
              ) : (
                <button key={a.id} className="img-btn" onClick={() => onOpenImage(a, m)} aria-label={`Open image ${a.filename ?? ''}`}>
                  <img
                    src={attachmentUrl(a.id)}
                    alt={a.caption ?? a.filename ?? 'Image'}
                    loading="lazy"
                    onLoad={onMediaLoad}
                    onError={(e) => a.id.startsWith('wa-') && e.currentTarget.parentElement?.classList.add('failed')}
                    style={visual.length === 1 && a.width && a.height ? { aspectRatio: `${a.width} / ${a.height}` } : undefined}
                  />
                  {i === 3 && visual.length > 4 && <span className="more-images">+{visual.length - 4}</span>}
                  {isLoopingMedia(a) && <span className="gif-tag">GIF</span>}
                </button>
              ),
            )}
          </div>
        )}
        {others.map((a) => (
          <AttachmentView key={a.id} a={a} />
        ))}
        {!m.deleted && m.preview && <LinkPreviewCard p={m.preview} onLoad={onMediaLoad} />}
        {m.deleted ? (
          <p className="body">
            <em>{m.outgoing ? 'You deleted this message' : 'This message was deleted'}</em>
          </p>
        ) : waSticker ? (
          waSticker.missing ? (
            <MissingMedia a={waSticker} />
          ) : waSticker.pending ? (
            <PendingImage a={waSticker} />
          ) : (
            <img className="sticker-img" src={attachmentUrl(waSticker.id)} alt="Sticker" width={180} height={180} onLoad={onMediaLoad} />
          )
        ) : sticker ? (
          <StickerImage sticker={sticker} onLoad={onMediaLoad} />
        ) : m.kind === 'sticker' ? (
          <p className="body">
            <em>Sticker</em>
          </p>
        ) : m.kind === 'poll' && m.poll ? (
          <PollView m={m} canEnd={capsFor({ network }).endPoll} />
        ) : (
          m.body && (
            <p className="body">
              <RichBody m={m} />
            </p>
          )
        )}
        <span className="meta">
          {!!m.expiresIn && (
            <span className="expiry" title={m.expiresAt ? `Disappears in ${untilLabel(m.expiresAt)}` : `Disappears ${durationLabel(m.expiresIn)} after you read it`}>
              <Icon name="timer" size={12} />
            </span>
          )}
          {m.edited && <span>edited</span>}
          <time dateTime={new Date(m.sentAt).toISOString()}>{formatTime(m.sentAt)}</time>
          {m.outgoing && <StatusMark status={m.status} />}
        </span>
      </div>

      {Object.keys(grouped).length > 0 && (
        <div className="reactions">
          {Object.entries(grouped).map(([emoji, names]) => (
            <button
              key={emoji}
              className={`reaction${emoji === myReaction ? ' mine' : ''}`}
              title={names.join(', ')}
              onClick={() => canAct && act(() => api.react(m.id, emoji))}
            >
              <Emojified text={emoji} />
              {names.length > 1 && <span>{names.length}</span>}
            </button>
          ))}
        </div>
      )}

      {m.status === 'failed' && (
        <div className="failed-note">
          Not sent{m.error ? `: ${m.error.replace(/^.*?failed \(\d+\): /, '')}` : ''}.{' '}
          <button className="link-btn" onClick={() => act(() => api.retry(m.id))}>
            Try again
          </button>
        </div>
      )}
      {error && <div className="failed-note">{error}</div>}

      {!m.deleted && (
        <div className="actions">
          {canAct && (
            <button className="icon-btn sm" onClick={() => setPicker((p) => !p)} aria-label="React" title="React">
              <Icon name="smile" size={18} />
            </button>
          )}
          {canAct && (
            <button className="icon-btn sm" onClick={() => onReply(m)} aria-label="Reply" title="Reply">
              <Icon name="reply" size={18} />
            </button>
          )}
          {canEdit(m, network) && (
            <button className="icon-btn sm" onClick={() => onEdit(m)} aria-label="Edit" title="Edit (↑ in an empty message box edits your last message)">
              <Icon name="pencil" size={17} />
            </button>
          )}
          {canAct && m.kind !== 'poll' && (
            <button className="icon-btn sm" onClick={() => setState({ forwarding: m })} aria-label="Forward" title="Forward">
              <Icon name="forward" size={18} />
            </button>
          )}
          {m.body && m.kind !== 'poll' && (
            <button className="icon-btn sm" onClick={() => navigator.clipboard?.writeText(m.body ?? '')} aria-label="Copy text" title="Copy text">
              <Icon name="copy" size={17} />
            </button>
          )}
          {m.outgoing && (
            <button className="icon-btn sm" onClick={() => setState({ panel: { kind: 'message', messageId: m.id } })} aria-label="Message info" title="Message info">
              <Icon name="info" size={18} />
            </button>
          )}
          {m.outgoing && (
            <button
              className="icon-btn sm"
              onClick={() => confirm('Delete this message for everyone?') && act(() => api.remove(m.id))}
              aria-label="Delete for everyone"
              title="Delete for everyone"
            >
              <Icon name="trash" size={17} />
            </button>
          )}
          {picker && (
            <div className="quick-react" role="menu">
              {QUICK_REACTIONS.map((e) => (
                <button key={e} className={e === myReaction ? 'mine' : undefined} onClick={() => (setPicker(false), act(() => api.react(m.id, e)))}>
                  <Emojified text={e} />
                </button>
              ))}
              <button className="more" onClick={() => (setPicker(false), onMoreReactions(m))} aria-label="More reactions" title="More reactions">
                <Icon name="plus" size={20} />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

function StickerImage({ sticker, onLoad }: { sticker: NonNullable<Message['sticker']>; onLoad: () => void }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <p className="body">
        <em>{[sticker.emoji, 'Sticker'].filter(Boolean).join(' ')}</em>
      </p>
    );
  }
  return (
    <img
      className="sticker-img"
      src={sticker.url}
      alt={sticker.emoji ? `Sticker ${sticker.emoji}` : 'Sticker'}
      width={180}
      height={180}
      onLoad={onLoad}
      onError={() => setFailed(true)}
    />
  );
}

/** A WhatsApp file from imported history that WhatsApp can't provide any more. */
function MissingMedia({ a }: { a: Attachment }) {
  const what = a.contentType.startsWith('image/') ? 'Photo' : a.contentType.startsWith('video/') ? 'Video' : a.voiceNote ? 'Voice message' : a.contentType.startsWith('audio/') ? 'Audio' : a.filename || 'File';
  return (
    <div className="file missing" title="WhatsApp no longer has this file. It may still be on your phone.">
      <Icon name="file" size={26} />
      <span>
        <strong>{what}</strong>
        <small>Not available any more · open it on your phone</small>
      </span>
    </div>
  );
}

const askedFor = new Set<string>(); // files we've asked the server to fetch this session

/**
 * A photo from imported WhatsApp history that isn't on the server yet. Once it's on screen, the server
 * is asked to fetch it (in the background); the message updates when it's there, or says it's gone.
 */
function PendingImage({ a }: { a: Attachment }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || askedFor.has(a.id)) return;
    const go = () => {
      if (askedFor.has(a.id)) return;
      askedFor.add(a.id);
      api.fetchAttachment(a.id).catch(() => askedFor.delete(a.id));
    };
    if (typeof IntersectionObserver === 'undefined') return go();
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) {
        io.disconnect();
        go();
      }
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [a.id]);
  return (
    <div ref={ref} className="img-btn pending" title="Getting it from WhatsApp…" style={a.width && a.height ? { aspectRatio: `${a.width} / ${a.height}` } : undefined}>
      <span className="pending-label">{a.contentType.startsWith('video/') ? 'GIF' : 'Photo'} · getting it from WhatsApp…</span>
    </div>
  );
}

/** Video or audio from imported WhatsApp history: fetched when you press play, not when the chat opens. */
function PendingPlayable({ a }: { a: Attachment }) {
  const [asked, setAsked] = useState(askedFor.has(a.id));
  const video = a.contentType.startsWith('video/');
  return (
    <button
      className="file pending-media"
      disabled={asked}
      onClick={() => {
        askedFor.add(a.id);
        setAsked(true);
        api.fetchAttachment(a.id).catch(() => (askedFor.delete(a.id), setAsked(false)));
      }}
    >
      {asked ? <span className="spinner small" /> : <Icon name="play" size={26} />}
      <span>
        <strong>{video ? 'Video' : a.voiceNote ? 'Voice message' : 'Audio'}</strong>
        <small>{asked ? 'Getting it from WhatsApp… this can take a minute' : [formatSize(a.size), 'tap to load from WhatsApp'].filter(Boolean).join(' · ')}</small>
      </span>
    </button>
  );
}

function AttachmentView({ a }: { a: Attachment }) {
  const url = attachmentUrl(a.id);
  if (a.missing) return <MissingMedia a={a} />;
  const playable = a.contentType.startsWith('video/') || a.contentType.startsWith('audio/') || a.voiceNote;
  if (a.pending && playable) return <PendingPlayable a={a} />;
  if (a.contentType.startsWith('video/')) return <video className="video" src={url} controls preload="metadata" />;
  if (a.contentType.startsWith('audio/') || a.voiceNote) return <audio className="audio" src={url} controls preload="metadata" />;
  return (
    <a className="file" href={attachmentUrl(a.id, a.filename ?? a.id)}>
      <Icon name="file" size={26} />
      <span>
        <strong>{a.filename ?? 'File'}</strong>
        <small>{formatSize(a.size)}</small>
      </span>
      <Icon name="download" size={20} />
    </a>
  );
}

/** "Sticker", "Photo", "Video" … for a message without text (the bar above the box while replying). */
function mediaLabel(m: Message): string {
  if (m.sticker) return 'Sticker';
  const a = m.attachments[0];
  if (!a) return '';
  if (a.sticker) return 'Sticker';
  if (a.gif) return 'GIF';
  if (a.contentType.startsWith('image/')) return m.attachments.length > 1 ? `${m.attachments.length} photos` : 'Photo';
  if (a.contentType.startsWith('video/')) return 'Video';
  if (a.contentType.startsWith('audio/')) return a.voiceNote ? 'Voice message' : 'Audio';
  return a.filename || 'File';
}
function mediaThumb(m: Message): string | null {
  if (m.sticker) return m.sticker.url;
  const a = m.attachments[0];
  return a && !a.missing && !a.gif && a.contentType.startsWith('image/') ? attachmentUrl(a.id) : null;
}

export function Lightbox({ item, onClose }: { item: LightboxItem; onClose: () => void }) {
  const { att } = item;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const video = att.contentType.startsWith('video/');
  return (
    <div className="lightbox" role="dialog" aria-label={video ? 'Video' : 'Image'} onClick={onClose}>
      <header onClick={(e) => e.stopPropagation()}>
        <span>
          <strong>{item.authorName}</strong> {formatDay(item.sentAt)}, {formatTime(item.sentAt)}
        </span>
        <a className="icon-btn" href={attachmentUrl(att.id, att.filename ?? att.id)} aria-label="Download">
          <Icon name="download" />
        </a>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="close" />
        </button>
      </header>
      {video ? (
        att.gif ? (
          <video src={attachmentUrl(att.id)} autoPlay loop muted playsInline onClick={(e) => e.stopPropagation()} />
        ) : (
          <video src={attachmentUrl(att.id)} controls autoPlay onClick={(e) => e.stopPropagation()} />
        )
      ) : (
        <img src={attachmentUrl(att.id)} alt={att.caption ?? att.filename ?? 'Image'} onClick={(e) => e.stopPropagation()} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface Pending {
  file: File;
  preview?: string;
}

/** The "@name" being typed right before the caret, if any (group chats). */
function mentionAtCaret(text: string, caret: number): { start: number; term: string } | null {
  const m = /(^|[\s(])@([^\s@]{0,30})$/u.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[2].length - 1, term: m[2] };
}

/** Wrap the selection in a formatting marker (Ctrl+B and friends). */
function wrapSelection(el: HTMLTextAreaElement, text: string, mark: string): { value: string; caret: number; end: number } {
  const start = el.selectionStart ?? text.length;
  const end = el.selectionEnd ?? start;
  const sel = text.slice(start, end);
  if (sel.startsWith(mark) && sel.endsWith(mark) && sel.length >= mark.length * 2) {
    const inner = sel.slice(mark.length, sel.length - mark.length); // toggle off
    return { value: text.slice(0, start) + inner + text.slice(end), caret: start, end: start + inner.length };
  }
  const value = text.slice(0, start) + mark + sel + mark + text.slice(end);
  return sel ? { value, caret: start, end: end + mark.length * 2 } : { value, caret: start + mark.length, end: start + mark.length };
}

const SHORTCUTS: Record<string, string> = { b: '*', i: '_', x: '~', m: '`' }; // x and m with Shift

/** The ":shortcode" being typed right before the caret, if any. */
function shortcodeAtCaret(text: string, caret: number): { start: number; term: string } | null {
  const m = /(^|[\s(])(:[a-z0-9_+-]{2,40})$/i.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[2].length, term: m[2].slice(1) };
}

/** "today at 14:03", "yesterday at 09:12", "3 Nov at 18:40". */
function lastSeenLabel(ts: number) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  if (ts >= day.getTime()) return `today at ${time}`;
  if (ts >= day.getTime() - 86400_000) return `yesterday at ${time}`;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })} at ${time}`;
}

/** In place of the message box, like WhatsApp: you can't message someone you blocked. */
function BlockedBar({ conversation }: { conversation: Conversation }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="blocked-bar">
      <span>You blocked this contact.</span>
      <button
        className="link-btn"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            upsertConversation(await api.block(conversation.id, false));
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        Tap to unblock
      </button>
      {error && <span className="form-error">{error}</span>}
    </div>
  );
}

function Composer({
  conversation,
  replyTo,
  clearReply,
  reactTo,
  clearReact,
  editing,
  setEditing,
  dropped,
  clearDropped,
  disabled,
}: {
  conversation: Conversation;
  replyTo: Message | null;
  clearReply: () => void;
  reactTo: Message | null;
  clearReact: () => void;
  editing: Message | null;
  setEditing: (m: Message | null) => void;
  dropped: File[];
  clearDropped: () => void;
  disabled: boolean;
}) {
  const [text, setText] = useState(() => getState().drafts[conversation.id]?.text ?? '');
  const [files, setFiles] = useState<Pending[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [panel, setPanel] = useState<PickerTab | null>(null);
  const [suggest, setSuggest] = useState<{ start: number; term: string; items: ReturnType<typeof searchEmoji>; index: number } | null>(null);
  const [mentionSuggest, setMentionSuggest] = useState<{ start: number; items: { key: string; name: string }[]; index: number } | null>(null);
  // WhatsApp only links a reply when WhatsApp Web still has the message; say so before sending.
  const [unlinkable, setUnlinkable] = useState<number | null>(null);
  useEffect(() => {
    setUnlinkable(null);
    if (!replyTo || conversation.network !== 'whatsapp') return;
    let cancelled = false;
    api
      .replyable(replyTo.id)
      .then((r) => !cancelled && !r.linkable && setUnlinkable(replyTo.id))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [replyTo?.id, conversation.network]);
  const mentions = useRef<ComposerMention[]>(getState().drafts[conversation.id]?.mentions ?? []); // people picked from the @ suggestions
  const [pollOpen, setPollOpen] = useState(false);
  const [linkCard, setLinkCard] = useState<{ url: string; title: string; description: string | null; image: string | null } | null>(null);
  const dismissedLinks = useRef(new Set<string>());
  const pendingSelection = useRef<number | null>(null);
  const editOriginal = useRef('');
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const typingSent = useRef(0);
  const typingStop = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pendingCaret = useRef<number | null>(null);
  const id = conversation.id;

  useEffect(() => {
    area.current?.focus();
  }, [replyTo]);

  // Put the caret back right after React commits the new text, before any further keystroke.
  useLayoutEffect(() => {
    const el = area.current;
    if (el && pendingCaret.current !== null) {
      el.focus();
      el.setSelectionRange(pendingCaret.current, pendingSelection.current ?? pendingCaret.current);
      pendingCaret.current = null;
      pendingSelection.current = null;
    }
  }, [text]);

  useEffect(() => {
    if (reactTo) setPanel('emoji');
  }, [reactTo]);

  // Entering edit mode puts the message text in the box; leaving it clears the box again.
  const draftBeforeEdit = useRef('');
  useEffect(() => {
    if (editing) {
      draftBeforeEdit.current = text;
      setPanel(null);
      const c = messageToComposer(editing);
      mentions.current = c.mentions;
      editOriginal.current = c.text;
      setTextAndCaret(c.text, c.text.length);
    }
  }, [editing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function stopEditing() {
    setEditing(null);
    setTextAndCaret(draftBeforeEdit.current, draftBeforeEdit.current.length);
    draftBeforeEdit.current = '';
  }

  useEffect(() => {
    if (dropped.length) {
      addFiles(dropped);
      clearDropped();
    }
  }, [dropped]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview)), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep what you typed per chat, so switching chats doesn't lose it.
  useEffect(() => {
    if (!editing) setDraft(id, { text, mentions: mentions.current });
  }, [text, editing, id]);

  // Link preview for the first https link in the message, like Signal Desktop.
  const firstLink = !editing && !files.length ? /https:\/\/[^\s<]+[^\s<.,:;"')\]!?]/.exec(text)?.[0] ?? null : null;
  useEffect(() => {
    if (!firstLink || dismissedLinks.current.has(firstLink)) return setLinkCard(null);
    if (linkCard?.url === firstLink) return;
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .linkPreview(firstLink)
        .then((r) => !cancelled && setLinkCard(r.preview && r.preview.url === firstLink ? r.preview : null))
        .catch(() => !cancelled && setLinkCard(null));
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [firstLink]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-grow the textarea
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  }, [text]);

  function addFiles(list: File[]) {
    setFiles((prev) => [...prev, ...list.map((file) => ({ file, preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined }))]);
  }

  function stopTyping() {
    clearTimeout(typingStop.current);
    if (typingSent.current) {
      typingSent.current = 0;
      api.typing(id, false).catch(() => {});
    }
  }

  function updateSuggest(value: string, caret: number) {
    const mc = conversation.kind === 'group' ? mentionAtCaret(value, caret) : null;
    if (mc) {
      const term = mc.term.toLowerCase();
      const items = (conversation.members ?? [])
        .filter((m) => m.key !== 'self' && m.name !== 'Unknown')
        .filter((m) => !term || m.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(term)) || m.name.toLowerCase().startsWith(term))
        .slice(0, 8);
      setMentionSuggest(items.length ? { start: mc.start, items, index: 0 } : null);
      return setSuggest(null);
    }
    setMentionSuggest(null);
    const sc = shortcodeAtCaret(value, caret);
    if (!sc) return setSuggest(null);
    const items = searchEmoji(sc.term, 8);
    setSuggest(items.length ? { ...sc, items, index: 0 } : null);
  }

  function setTextAndCaret(value: string, caret: number) {
    pendingCaret.current = caret;
    setText(value);
  }

  function onChange(v: string, caret: number) {
    // Typing the closing colon of a known :shortcode: turns it into the emoji right away.
    const done = /:([a-z0-9_+-]{1,40}):$/i.exec(v.slice(0, caret));
    const e = done && emojiForCode(done[1]);
    if (done && e) {
      rememberAlias(e, done[1].toLowerCase());
      const start = caret - done[0].length;
      v = v.slice(0, start) + e + v.slice(caret);
      caret = start + e.length;
      setTextAndCaret(v, caret);
      setSuggest(null);
    } else {
      setText(v);
      updateSuggest(v, caret);
    }
    if (!v) return stopTyping();
    const now = Date.now();
    if (now - typingSent.current > 8000) {
      typingSent.current = now;
      api.typing(id, true).catch(() => {});
    }
    clearTimeout(typingStop.current);
    typingStop.current = setTimeout(stopTyping, 4000);
  }

  function chooseSuggestion(i: number) {
    if (!suggest) return;
    const caret = area.current?.selectionStart ?? text.length;
    const e = suggest.items[i].entry.e;
    rememberAlias(e, suggest.items[i].code);
    const after = text.slice(caret);
    const insert = e + (after.startsWith(' ') ? '' : ' ');
    setTextAndCaret(text.slice(0, suggest.start) + insert + after, suggest.start + insert.length);
    setSuggest(null);
  }

  function chooseMention(i: number) {
    if (!mentionSuggest) return;
    const caret = area.current?.selectionStart ?? text.length;
    const person = mentionSuggest.items[i];
    const after = text.slice(caret);
    const insert = '@' + person.name + (after.startsWith(' ') ? '' : ' ');
    mentions.current = [...mentions.current.filter((m) => m.key !== person.key), { name: person.name, key: person.key }];
    setTextAndCaret(text.slice(0, mentionSuggest.start) + insert + after, mentionSuggest.start + insert.length);
    setMentionSuggest(null);
  }

  function insertAtCaret(s: string) {
    const el = area.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    setTextAndCaret(text.slice(0, start) + s + text.slice(end), start + s.length);
  }

  async function send() {
    const body = replaceShortcodes(text.trim());
    const rich = composerToRich(body, mentions.current);
    if (editing) {
      if (!body || sending) return;
      setSending(true);
      setError(null);
      setSuggest(null);
      try {
        const updated = await api.edit(editing.id, rich);
        upsertMessages(id, [updated]);
        setEditing(null);
        setText(draftBeforeEdit.current);
        draftBeforeEdit.current = '';
        mentions.current = [];
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setSending(false);
        area.current?.focus();
      }
      return;
    }
    if ((!body && !files.length) || sending) return;
    setSending(true);
    setError(null);
    setSuggest(null);
    stopTyping();
    try {
      const attachments = await Promise.all(
        files.map(async (p) => ({ name: p.file.name || 'file', type: p.file.type || 'application/octet-stream', data: await fileToBase64(p.file) })),
      );
      const previewUrl = linkCard && linkCard.url === firstLink && rich.text.includes(linkCard.url) ? linkCard.url : undefined;
      const msg = await api.send(id, { ...rich, quoteId: replyTo?.id, attachments: attachments.length ? attachments : undefined, previewUrl });
      setLinkCard(null);
      dismissedLinks.current.clear();
      if (getState().hasNewer[id]) await loadLatest(id).catch(() => {}); // back to the bottom to see it
      upsertMessages(id, [msg]);
      refreshUsageSoon();
      files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
      mentions.current = [];
      setText('');
      setFiles([]);
      clearReply();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
      area.current?.focus();
    }
  }

  async function sendGif(g: PickedGif) {
    setPanel(null);
    setSending(true);
    setError(null);
    try {
      const res = await fetch(g.url, { referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new Error(`Couldn't download the GIF (${res.status})`);
      const blob = await res.blob();
      const data = await fileToBase64(blob);
      const name = (g.title || 'giphy').replace(/[^\w -]+/g, '').trim().slice(0, 40).replace(/\s+/g, '-') || 'giphy';
      const msg = await api.send(id, { text: '', quoteId: replyTo?.id, attachments: [{ name: `${name}.gif`, type: 'image/gif', data }] });
      upsertMessages(id, [msg]);
      refreshUsageSoon();
      clearReply();
    } catch (e) {
      setError((e as Error).message === 'Failed to fetch' ? "Couldn't download the GIF from Giphy." : (e as Error).message);
    } finally {
      setSending(false);
      area.current?.focus();
    }
  }

  async function sendWaSticker(s: { id?: string; file?: File }) {
    setPanel(null);
    setError(null);
    try {
      const image = s.file ? `data:${s.file.type};base64,${await fileToBase64(s.file)}` : undefined;
      const msg = await api.sendWaSticker(id, { id: s.id, image, quoteId: replyTo?.id });
      upsertMessages(id, [msg]);
      clearReply();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      area.current?.focus();
    }
  }

  async function sendSticker(s: PickedSticker) {
    setPanel(null);
    setError(null);
    try {
      // Your own stickers: a WhatsApp sticker in WhatsApp chats, a picture in Signal chats (server decides).
      const msg = 'localId' in s ? await api.sendLocalSticker(id, s.localId, replyTo?.id) : await api.send(id, { text: '', quoteId: replyTo?.id, sticker: s });
      upsertMessages(id, [msg]);
      refreshUsageSoon();
      clearReply();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      area.current?.focus();
    }
  }

  async function react(e: string) {
    const target = reactTo;
    clearReact();
    setPanel(null);
    if (!target) return;
    try {
      await api.react(target.id, e);
      refreshUsageSoon();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionSuggest) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = mentionSuggest.items.length;
        setMentionSuggest({ ...mentionSuggest, index: (mentionSuggest.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n });
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        chooseMention(mentionSuggest.index);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionSuggest(null);
        return;
      }
    }
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && !e.altKey && SHORTCUTS[key] && (key === 'b' || key === 'i' ? !e.shiftKey : e.shiftKey)) {
      e.preventDefault();
      const r = wrapSelection(e.currentTarget, text, SHORTCUTS[key]);
      pendingSelection.current = r.end;
      setTextAndCaret(r.value, r.caret);
      return;
    }
    if (suggest) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = suggest.items.length;
        setSuggest({ ...suggest, index: (suggest.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n });
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        chooseSuggestion(suggest.index);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSuggest(null);
        return;
      }
    }
    if (e.key === 'ArrowUp' && !text && !files.length && !editing && !e.shiftKey && !e.altKey) {
      // Like Signal Desktop/Slack: ↑ in an empty box edits your last message.
      const list = getState().messages[id] ?? [];
      const last = [...list].reverse().find((m) => m.outgoing && !m.deleted && m.kind !== 'system');
      if (last && canEdit(last, conversation.network)) {
        e.preventDefault();
        clearReply();
        setEditing(last);
      }
      return;
    }
    if (e.key === 'Escape' && editing) {
      e.preventDefault();
      stopEditing();
      return;
    }
    const enterSends = getPrefs().enterToSend;
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && (enterSends || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
    } else if (e.key === 'Escape' && replyTo) {
      clearReply();
    }
  }

  function onPaste(e: ClipboardEvent) {
    const pasted = Array.from(e.clipboardData.files);
    if (pasted.length) {
      e.preventDefault();
      addFiles(pasted);
    }
  }

  const closePanel = () => {
    setPanel(null);
    clearReact();
  };

  return (
    <footer className="composer">
      {panel && (
        <Picker
          tab={reactTo ? 'emoji' : panel}
          onTab={setPanel}
          allowGif={!reactTo}
          stickerNetwork={conversation.network}
          onStickerImage={conversation.network === 'whatsapp' ? (f) => void sendWaSticker({ file: f }) : undefined}
          title={reactTo ? 'React' : undefined}
          onEmoji={(e) => (reactTo ? void react(e) : insertAtCaret(e))}
          onGif={sendGif}
          onSticker={sendSticker}
          onClose={closePanel}
        />
      )}
      {editing && (
        <div className="reply-preview editing" style={{ ['--hue' as string]: 'var(--self-hue)' }}>
          <Icon name="pencil" size={18} />
          <div>
            <strong>Editing message</strong>
            <span>
              <Emojified text={editing.body} />
            </span>
          </div>
          <button className="icon-btn sm" onClick={stopEditing} aria-label="Cancel editing" title="Cancel (Esc)">
            <Icon name="close" size={18} />
          </button>
        </div>
      )}
      {replyTo && !editing && (
        <div className="reply-preview" style={{ ['--hue' as string]: replyTo.author === 'self' ? 'var(--self-hue)' : hueFor(replyTo.author) }}>
          <div>
            <strong>Replying to {replyTo.author === 'self' ? 'yourself' : replyTo.authorName}</strong>
            <span>
              <Emojified text={replyTo.body || mediaLabel(replyTo)} />
            </span>
            {unlinkable === replyTo.id && <small className="reply-note">Too old to link on WhatsApp: it will be sent with the quoted text</small>}
          </div>
          {mediaThumb(replyTo) && <img className={`quote-thumb${replyTo.sticker || replyTo.attachments[0]?.sticker ? ' sticker' : ''}`} src={mediaThumb(replyTo)!} alt="" />}
          <button className="icon-btn sm" onClick={clearReply} aria-label="Cancel reply">
            <Icon name="close" size={18} />
          </button>
        </div>
      )}
      {linkCard && !editing && (
        <div className="compose-preview">
          {linkCard.image && <img src={linkCard.image} alt="" />}
          <div>
            <strong>{linkCard.title}</strong>
            {linkCard.description && <span>{linkCard.description}</span>}
            <small>{linkCard.url.replace(/^https:\/\/(www\.)?/, '').split('/')[0]}</small>
          </div>
          <button
            className="icon-btn sm"
            onClick={() => (dismissedLinks.current.add(linkCard.url), setLinkCard(null), area.current?.focus())}
            aria-label="Send without link preview"
            title="Send without preview"
          >
            <Icon name="close" size={18} />
          </button>
        </div>
      )}
      {pollOpen && <PollDialog conversationId={id} onClose={() => (setPollOpen(false), area.current?.focus())} />}
      {files.length > 0 && (
        <div className="pending-files">
          {files.map((p, i) => (
            <div key={i} className="pending-file">
              {p.preview ? <img src={p.preview} alt="" /> : <Icon name="file" size={28} />}
              <span>{p.file.name}</span>
              <button className="remove" onClick={() => setFiles((f) => f.filter((_, j) => j !== i))} aria-label={`Remove ${p.file.name}`}>
                <Icon name="close" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="composer-row">
        {mentionSuggest && (
          <ul className="emoji-suggest mention-suggest" role="listbox" aria-label="Mention someone">
            {mentionSuggest.items.map((p, i) => (
              <li
                key={p.key}
                role="option"
                aria-selected={i === mentionSuggest.index}
                className={i === mentionSuggest.index ? 'on' : undefined}
                onMouseDown={(e) => {
                  e.preventDefault();
                  chooseMention(i);
                }}
                onMouseEnter={() => setMentionSuggest({ ...mentionSuggest, index: i })}
              >
                <Avatar name={p.name} seed={p.key} size={28} src={null} />
                <span className="code">{p.name}</span>
              </li>
            ))}
          </ul>
        )}
        {suggest && (
          <ul className="emoji-suggest" role="listbox" aria-label="Emoji suggestions">
            {suggest.items.map((s, i) => (
              <li
                key={s.entry.e}
                role="option"
                aria-selected={i === suggest.index}
                className={i === suggest.index ? 'on' : undefined}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep focus in the textarea
                  chooseSuggestion(i);
                }}
                onMouseEnter={() => setSuggest({ ...suggest, index: i })}
              >
                <span className="emoji">
                  <Emojified text={s.entry.e} />
                </span>
                <span className="code">:{s.code}:</span>
              </li>
            ))}
          </ul>
        )}
        <button
          className={`icon-btn${panel === 'emoji' ? ' on' : ''}`}
          onClick={() => (panel === 'emoji' ? closePanel() : setPanel('emoji'))}
          aria-label="Emoji"
          title="Emoji"
          aria-expanded={panel === 'emoji'}
        >
          <Icon name="smile" />
        </button>
        <button
          className={`icon-btn${panel === 'gif' ? ' on' : ''}`}
          onClick={() => (panel === 'gif' ? closePanel() : (clearReact(), setPanel('gif')))}
          aria-label="GIF"
          title="GIF"
          aria-expanded={panel === 'gif'}
          disabled={disabled || !!editing}
        >
          <Icon name="gif" size={26} />
        </button>
        <button className="icon-btn" onClick={() => setPollOpen(true)} aria-label="New poll" title="New poll" disabled={disabled || !!editing}>
          <Icon name="poll" />
        </button>
        <button className="icon-btn" onClick={() => fileInput.current?.click()} aria-label="Attach files" title="Attach files" disabled={disabled || !!editing}>
          <Icon name="attach" />
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        <textarea
          ref={area}
          rows={1}
          value={text}
          placeholder={disabled ? `Waiting for ${NETWORK_LABEL[conversation.network]}…` : 'Message'}
          title="*bold*  _italic_  ~strike~  `code`  ||spoiler||"
          spellCheck
          onChange={(e) => onChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
              updateSuggest(text, e.currentTarget.selectionStart ?? text.length);
            }
          }}
          onClick={(e) => updateSuggest(text, e.currentTarget.selectionStart ?? text.length)}
          onPaste={onPaste}
          onBlur={() => {
            stopTyping();
            setTimeout(() => (setSuggest(null), setMentionSuggest(null)), 150);
          }}
          aria-label={`Message ${conversation.title}`}
          aria-autocomplete="list"
        />
        <button
          className="send-btn"
          onClick={send}
          disabled={disabled || sending || (!text.trim() && !files.length) || (!!editing && text.trim() === editOriginal.current.trim())}
          aria-label={editing ? 'Save edit' : 'Send'}
          title={editing ? 'Save edit' : undefined}
        >
          <Icon name={editing ? 'check' : 'send'} />
        </button>
      </div>
    </footer>
  );
}
