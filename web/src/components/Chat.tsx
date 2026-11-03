import { type ClipboardEvent, type DragEvent, Fragment, type KeyboardEvent, type ReactNode, memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, attachmentUrl } from '../api';
import { emojiForCode, replaceShortcodes, searchEmoji } from '../emoji';
import { type ComposerMention, composerToRich, messageToComposer, pieces } from '../format';
import { jumpToMessage, loadLatest } from '../jump';
import { getPrefs } from '../prefs';
import { getState, setHasNewer, setState, upsertMessages, useStore } from '../store';
import type { Attachment, Conversation, LinkPreview, Message } from '../types';
import { durationLabel, fileToBase64, formatDay, formatSize, formatTime, hueFor, isJumbomoji, sameDay, untilLabel } from '../util';
import { type PickedGif, type PickedSticker, Picker, type PickerTab } from './Picker';
import { Avatar, Icon, StatusMark } from './ui';

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
export function canEdit(m: Message) {
  return (
    m.outgoing &&
    m.kind === 'message' &&
    !m.deleted &&
    !!m.body &&
    !m.attachments.length &&
    (m.status === 'sent' || m.status === 'delivered' || m.status === 'read') &&
    Date.now() - m.sentAt < EDIT_WINDOW_MS
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
  const connected = useStore((s) => s.signal.status === 'connected');
  const panel = useStore((s) => s.panel?.kind ?? null);
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

  // Mark read while the chat is open and the window is visible.
  useEffect(() => {
    if (!conversation.unread) return;
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
  }, [id, conversation.unread]);

  let subtitle: string;
  if (typing.length > 0) {
    subtitle = `${conversation.kind === 'group' ? typing.map((t) => t.authorName.split(' ')[0]).join(', ') + ' ' : ''}typing…`;
  } else if (conversation.kind === 'group') {
    // WhatsApp-style: known names alphabetically, "You" last, unknown people counted.
    const all = conversation.members ?? [];
    const named = all.filter((m) => m.key !== 'self' && m.name !== 'Unknown').map((m) => m.name).sort((a, b) => a.localeCompare(b));
    const unknown = all.filter((m) => m.name === 'Unknown').length;
    subtitle = [...named, ...(all.some((m) => m.key === 'self') ? ['You'] : []), ...(unknown ? [`${unknown} other${unknown > 1 ? 's' : ''}`] : [])].join(', ');
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
          <Avatar name={conversation.title} seed={String(conversation.number ?? conversation.title)} group={conversation.kind === 'group'} size={40} src={conversation.avatar} />
          <span className="chat-head-text">
            <h2>
              {conversation.title}
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

  const items: ReactNode[] = [];
  messages.forEach((m, i) => {
    const prev = messages[i - 1];
    if (!prev || !sameDay(prev.sentAt, m.sentAt)) {
      items.push(
        <div className="day" key={`d${m.sentAt}`}>
          <span>{formatDay(m.sentAt)}</span>
        </div>,
      );
    }
    const continued = !!prev && prev.author === m.author && sameDay(prev.sentAt, m.sentAt) && m.sentAt - prev.sentAt < 5 * 60_000 && prev.kind !== 'system';
    items.push(
      <MessageItem
        key={m.id}
        m={m}
        group={conversation.kind === 'group'}
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
              {messages.length ? 'Start of the history on Signal Web. Earlier messages are on your phone.' : 'No messages yet. Say hi.'}
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
        let node: ReactNode = p.text;
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
            <a href={p.link} target="_blank" rel="noopener noreferrer">
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
    <a className={`link-preview${p.image ? ' with-image' : ''}`} href={p.url} target="_blank" rel="noopener noreferrer">
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
        <span>{m.body}</span>
      </div>
    );
  }

  const visual = m.attachments.filter((a) => a.contentType.startsWith('image/') || isLoopingMedia(a));
  const others = m.attachments.filter((a) => !visual.includes(a));
  const jumbo = !m.deleted && !m.attachments.length && !m.quote && isJumbomoji(m.body);
  const sticker = !m.deleted && m.kind === 'sticker' ? m.sticker : null;
  const canAct = !m.deleted && m.status !== 'pending' && m.status !== 'failed';

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
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
        className={`bubble${jumbo ? ' jumbo' : ''}${sticker ? ' sticker' : ''}${m.deleted ? ' deleted' : ''}${visual.length && !m.body && !m.quote ? ' media-only' : ''}`}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('a,button,video,audio,img')) return;
          onSelect();
        }}
      >
        {group && !m.outgoing && !continued && (
          <div className="author" style={{ ['--hue' as string]: hueFor(m.author) }}>
            {m.authorName}
          </div>
        )}
        {m.quote && (
          <button className="quote" onClick={() => onJump(m.quote!.sentAt)} style={{ ['--hue' as string]: m.quote.author === 'self' ? 'var(--self-hue)' : hueFor(m.quote.author) }}>
            <strong>{m.quote.author === 'self' ? 'You' : m.quote.authorName}</strong>
            <span>{m.quote.text || 'Attachment'}</span>
          </button>
        )}
        {visual.length > 0 && (
          <div className={`images n${Math.min(visual.length, 4)}`}>
            {visual.slice(0, 4).map((a, i) =>
              a.contentType.startsWith('video/') ? (
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
        ) : sticker ? (
          <StickerImage sticker={sticker} onLoad={onMediaLoad} />
        ) : m.kind === 'sticker' ? (
          <p className="body">
            <em>Sticker</em>
          </p>
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
              {emoji}
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
          {canEdit(m) && (
            <button className="icon-btn sm" onClick={() => onEdit(m)} aria-label="Edit" title="Edit (↑ in an empty message box edits your last message)">
              <Icon name="pencil" size={17} />
            </button>
          )}
          {m.body && (
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
                  {e}
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

function AttachmentView({ a }: { a: Attachment }) {
  const url = attachmentUrl(a.id);
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
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Pending[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [panel, setPanel] = useState<PickerTab | null>(null);
  const [suggest, setSuggest] = useState<{ start: number; term: string; items: ReturnType<typeof searchEmoji>; index: number } | null>(null);
  const [mentionSuggest, setMentionSuggest] = useState<{ start: number; items: { key: string; name: string }[]; index: number } | null>(null);
  const mentions = useRef<ComposerMention[]>([]); // people picked from the @ suggestions
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
      const msg = await api.send(id, { ...rich, quoteId: replyTo?.id, attachments: attachments.length ? attachments : undefined });
      if (getState().hasNewer[id]) await loadLatest(id).catch(() => {}); // back to the bottom to see it
      upsertMessages(id, [msg]);
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
      clearReply();
    } catch (e) {
      setError((e as Error).message === 'Failed to fetch' ? "Couldn't download the GIF from Giphy." : (e as Error).message);
    } finally {
      setSending(false);
      area.current?.focus();
    }
  }

  async function sendSticker(s: PickedSticker) {
    setPanel(null);
    setError(null);
    try {
      const msg = await api.send(id, { text: '', quoteId: replyTo?.id, sticker: s });
      upsertMessages(id, [msg]);
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
      if (last && canEdit(last)) {
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
            <span>{editing.body}</span>
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
            <span>{replyTo.body || (replyTo.attachments.length ? 'Attachment' : '')}</span>
          </div>
          <button className="icon-btn sm" onClick={clearReply} aria-label="Cancel reply">
            <Icon name="close" size={18} />
          </button>
        </div>
      )}
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
                <span className="emoji">{s.entry.e}</span>
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
          placeholder={disabled ? 'Waiting for Signal…' : 'Message'}
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
