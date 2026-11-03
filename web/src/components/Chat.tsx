import { type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode, memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, attachmentUrl } from '../api';
import { getState, setState, upsertMessages, useStore } from '../store';
import type { Attachment, Conversation, Message } from '../types';
import { fileToBase64, formatDay, formatSize, formatTime, hueFor, isJumbomoji, sameDay } from '../util';
import { Avatar, Icon, StatusMark } from './ui';

const QUICK_REACTIONS = ['❤️', '👍', '👎', '😂', '😮', '😢', '🙏', '🔥'];
const PAGE = 50;
const NO_TYPING: never[] = []; // stable reference: store selectors must not allocate

export function ChatView({ conversation }: { conversation: Conversation }) {
  const id = conversation.id;
  const messages = useStore((s) => s.messages[id]);
  const hasMore = useStore((s) => s.hasMore[id] ?? true);
  const typing = useStore((s) => s.typing[id] ?? NO_TYPING);
  const connected = useStore((s) => s.signal.status === 'connected');
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [lightbox, setLightbox] = useState<{ att: Attachment; msg: Message } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dropped, setDropped] = useState<File[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Initial load
  useEffect(() => {
    setReplyTo(null);
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

  const subtitle =
    typing.length > 0
      ? `${conversation.kind === 'group' ? typing.map((t) => t.authorName.split(' ')[0]).join(', ') + ' ' : ''}typing…`
      : conversation.kind === 'group'
        ? (conversation.members ?? []).map((m) => m.name).join(', ')
        : conversation.number ?? (conversation.username ? '@' + conversation.username : '');

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) setDropped(Array.from(e.dataTransfer.files));
  }

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
        <button className="icon-btn back-btn" onClick={() => setState({ activeId: null })} aria-label="Back to chats">
          <Icon name="back" />
        </button>
        <Avatar name={conversation.title} seed={String(conversation.number ?? conversation.title)} group={conversation.kind === 'group'} size={40} />
        <div className="chat-head-text">
          <h2>{conversation.title}</h2>
          <p className={typing.length ? 'typing-text' : undefined}>{subtitle}</p>
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
          onReply={setReplyTo}
          onOpenImage={(att, msg) => setLightbox({ att, msg })}
        />
      )}

      <Composer
        key={id}
        conversation={conversation}
        replyTo={replyTo}
        clearReply={() => setReplyTo(null)}
        dropped={dropped}
        clearDropped={() => setDropped([])}
        disabled={!connected}
      />

      {dragging && <div className="drop-overlay">Drop files to send to {conversation.title}</div>}
      {lightbox && <Lightbox att={lightbox.att} msg={lightbox.msg} onClose={() => setLightbox(null)} />}
    </section>
  );
}

// ---------------------------------------------------------------------------

function MessageList({
  conversation,
  messages,
  hasMore,
  onReply,
  onOpenImage,
}: {
  conversation: Conversation;
  messages: Message[] | undefined;
  hasMore: boolean;
  onReply: (m: Message) => void;
  onOpenImage: (a: Attachment, m: Message) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // keep pinned to the bottom while the user is there
  const prevHeight = useRef(0);
  const loadingOlder = useRef(false);
  const [selected, setSelected] = useState<number | null>(null);
  const id = conversation.id;
  const last = messages?.[messages.length - 1];

  useLayoutEffect(() => {
    stick.current = true;
  }, [id]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (loadingOlder.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current; // keep position after prepending
      loadingOlder.current = false;
    } else if (stick.current || last?.outgoing) {
      el.scrollTop = el.scrollHeight;
    }
    prevHeight.current = el.scrollHeight;
  }, [messages, last?.outgoing]);

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

  function onScroll() {
    const el = ref.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 200) void loadOlder();
  }

  const jumpTo = (sentAt: number) => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-ts="${sentAt}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
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
        onOpenImage={onOpenImage}
        onJump={jumpTo}
      />,
    );
  });

  return (
    <div className="messages" ref={ref} onScroll={onScroll} role="log" aria-live="polite">
      <div className="messages-inner">
        {!hasMore && (
          <p className="history-start">
            {messages.length ? 'Start of the history on Signal Web. Earlier messages are on your phone.' : 'No messages yet. Say hi.'}
          </p>
        )}
        {items}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g;

function Linkified({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <a key={i} href={p} target="_blank" rel="noopener noreferrer">
            {p}
          </a>
        ) : (
          p
        ),
      )}
    </>
  );
}

const MessageItem = memo(function MessageItem({
  m,
  group,
  continued,
  selected,
  onSelect,
  onReply,
  onOpenImage,
  onJump,
}: {
  m: Message;
  group: boolean;
  continued: boolean;
  selected: boolean;
  onSelect: () => void;
  onReply: (m: Message) => void;
  onOpenImage: (a: Attachment, m: Message) => void;
  onJump: (sentAt: number) => void;
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

  const images = m.attachments.filter((a) => a.contentType.startsWith('image/'));
  const others = m.attachments.filter((a) => !a.contentType.startsWith('image/'));
  const jumbo = !m.deleted && !m.attachments.length && !m.quote && isJumbomoji(m.body);
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
        className={`bubble${jumbo ? ' jumbo' : ''}${m.deleted ? ' deleted' : ''}${images.length && !m.body && !m.quote ? ' media-only' : ''}`}
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
          <button className="quote" onClick={() => onJump(m.quote!.sentAt)} style={{ ['--hue' as string]: m.quote.author === 'self' ? 221 : hueFor(m.quote.author) }}>
            <strong>{m.quote.author === 'self' ? 'You' : m.quote.authorName}</strong>
            <span>{m.quote.text || 'Attachment'}</span>
          </button>
        )}
        {images.length > 0 && (
          <div className={`images n${Math.min(images.length, 4)}`}>
            {images.slice(0, 4).map((a, i) => (
              <button key={a.id} className="img-btn" onClick={() => onOpenImage(a, m)} aria-label={`Open image ${a.filename ?? ''}`}>
                <img
                  src={attachmentUrl(a.id)}
                  alt={a.caption ?? a.filename ?? 'Image'}
                  loading="lazy"
                  style={images.length === 1 && a.width && a.height ? { aspectRatio: `${a.width} / ${a.height}` } : undefined}
                />
                {i === 3 && images.length > 4 && <span className="more-images">+{images.length - 4}</span>}
              </button>
            ))}
          </div>
        )}
        {others.map((a) => (
          <AttachmentView key={a.id} a={a} />
        ))}
        {m.deleted ? (
          <p className="body">
            <em>{m.outgoing ? 'You deleted this message' : 'This message was deleted'}</em>
          </p>
        ) : m.kind === 'sticker' ? (
          <p className="body">
            <em>Sticker</em>
          </p>
        ) : (
          m.body && (
            <p className="body">
              <Linkified text={m.body} />
            </p>
          )
        )}
        <span className="meta">
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
          {m.body && (
            <button className="icon-btn sm" onClick={() => navigator.clipboard?.writeText(m.body ?? '')} aria-label="Copy text" title="Copy text">
              <Icon name="copy" size={17} />
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
            <div className="picker" role="menu">
              {QUICK_REACTIONS.map((e) => (
                <button key={e} className={e === myReaction ? 'mine' : undefined} onClick={() => (setPicker(false), act(() => api.react(m.id, e)))}>
                  {e}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

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

function Lightbox({ att, msg, onClose }: { att: Attachment; msg: Message; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-label="Image" onClick={onClose}>
      <header onClick={(e) => e.stopPropagation()}>
        <span>
          <strong>{msg.authorName}</strong> {formatDay(msg.sentAt)}, {formatTime(msg.sentAt)}
        </span>
        <a className="icon-btn" href={attachmentUrl(att.id, att.filename ?? att.id)} aria-label="Download">
          <Icon name="download" />
        </a>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="close" />
        </button>
      </header>
      <img src={attachmentUrl(att.id)} alt={att.caption ?? att.filename ?? 'Image'} onClick={(e) => e.stopPropagation()} />
    </div>
  );
}

// ---------------------------------------------------------------------------

interface Pending {
  file: File;
  preview?: string;
}

function Composer({
  conversation,
  replyTo,
  clearReply,
  dropped,
  clearDropped,
  disabled,
}: {
  conversation: Conversation;
  replyTo: Message | null;
  clearReply: () => void;
  dropped: File[];
  clearDropped: () => void;
  disabled: boolean;
}) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Pending[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const typingSent = useRef(0);
  const typingStop = useRef<ReturnType<typeof setTimeout>>(undefined);
  const id = conversation.id;

  useEffect(() => {
    area.current?.focus();
  }, [replyTo]);

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

  function onChange(v: string) {
    setText(v);
    if (!v) return stopTyping();
    const now = Date.now();
    if (now - typingSent.current > 8000) {
      typingSent.current = now;
      api.typing(id, true).catch(() => {});
    }
    clearTimeout(typingStop.current);
    typingStop.current = setTimeout(stopTyping, 4000);
  }

  async function send() {
    const body = text.trim();
    if ((!body && !files.length) || sending) return;
    setSending(true);
    setError(null);
    stopTyping();
    try {
      const attachments = await Promise.all(
        files.map(async (p) => ({ name: p.file.name || 'file', type: p.file.type || 'application/octet-stream', data: await fileToBase64(p.file) })),
      );
      const msg = await api.send(id, { text: body, quoteId: replyTo?.id, attachments: attachments.length ? attachments : undefined });
      upsertMessages(id, [msg]);
      files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
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

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
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

  return (
    <footer className="composer">
      {replyTo && (
        <div className="reply-preview" style={{ ['--hue' as string]: replyTo.author === 'self' ? 221 : hueFor(replyTo.author) }}>
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
        <button className="icon-btn" onClick={() => fileInput.current?.click()} aria-label="Attach files" title="Attach files" disabled={disabled}>
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
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={stopTyping}
          aria-label={`Message ${conversation.title}`}
        />
        <button className="send-btn" onClick={send} disabled={disabled || sending || (!text.trim() && !files.length)} aria-label="Send">
          <Icon name="send" />
        </button>
      </div>
    </footer>
  );
}
