import { useEffect, useRef, useState } from 'react';
import { api, attachmentUrl } from '../api';
import { setState, upsertConversation, useStore } from '../store';
import type { Attachment, Conversation, ConversationInfo, Member, Message, Recipient } from '../types';
import { formatDay, formatSize, formatTime, squareAvatar } from '../util';
import { Avatar, Icon, StatusMark } from './ui';

function closePanel() {
  setState({ panel: null });
}

function PanelHead({ title }: { title: string }) {
  return (
    <header className="panel-head">
      <button className="icon-btn" onClick={closePanel} aria-label="Close">
        <Icon name="close" />
      </button>
      <h2>{title}</h2>
    </header>
  );
}

// ---------------------------------------------------------------------------

export function ChatInfoPanel({ conversation, onOpenMedia }: { conversation: Conversation; onOpenMedia: (a: Attachment, authorName: string, sentAt: number) => void }) {
  const [info, setInfo] = useState<ConversationInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'media' | 'files' | 'links'>('media');
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState('');
  const id = conversation.id;

  // Reload when the chat changes or new messages/members arrive.
  useEffect(() => {
    let cancelled = false;
    api
      .info(id)
      .then((i) => !cancelled && (setInfo(i), setError(null)))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [id, conversation.lastMessageAt, conversation.title, conversation.members?.length]);

  useEffect(() => {
    setExpanded(false);
    setFilter('');
    setTab('media');
  }, [id]);

  const group = conversation.kind === 'group';
  const text = group ? info?.description : info?.about;
  const long = !!text && (text.length > 220 || text.split('\n').length > 5);
  const members = (info?.members ?? []).filter((m) => !filter || m.name.toLowerCase().includes(filter.toLowerCase()) || m.number?.includes(filter));

  const photoInput = useRef<HTMLInputElement>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  async function changeGroupPhoto(file: File | undefined) {
    if (!file) return;
    setPhotoBusy(true);
    setError(null);
    try {
      const data = await squareAvatar(file);
      upsertConversation(await api.setGroupAvatar(id, data));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPhotoBusy(false);
    }
  }

  async function openMember(m: Member) {
    if (m.key === 'self') return;
    try {
      const c = await api.startChat(m.key.startsWith('+') ? { number: m.key } : { uuid: m.key, number: m.number ?? undefined });
      upsertConversation(c);
      setState({ activeId: c.id, panel: null });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <aside className="panel" aria-label={group ? 'Group info' : 'Contact info'}>
      <PanelHead title={group ? 'Group info' : 'Contact info'} />
      <div className="panel-body">
        <section className="panel-hero">
          {group ? (
            <button className="profile-photo" onClick={() => photoInput.current?.click()} title="Change group picture" aria-label="Change group picture" disabled={photoBusy}>
              <Avatar key={conversation.avatar ?? ''} name={conversation.title} seed={String(conversation.title)} group size={120} src={conversation.avatar} />
              <span className="photo-overlay">{photoBusy ? <span className="spinner small" /> : <Icon name="camera" size={26} />}</span>
            </button>
          ) : (
            <Avatar name={conversation.title} seed={String(conversation.number ?? conversation.title)} size={120} src={conversation.avatar} />
          )}
          <input ref={photoInput} type="file" accept="image/*" hidden onChange={(e) => (void changeGroupPhoto(e.target.files?.[0]), (e.target.value = ''))} />
          <h3>{conversation.title}</h3>
          <p className="muted">
            {group
              ? `Group · ${info?.memberCount ?? conversation.members?.length ?? 0} members`
              : [conversation.number, conversation.username ? '@' + conversation.username : null].filter(Boolean).join('  ')}
          </p>
        </section>

        {error && <p className="form-error pad">{error}</p>}

        {text && (
          <section className="panel-section">
            <h4>{group ? 'Description' : 'About'}</h4>
            <p className={`panel-text${long && !expanded ? ' clamped' : ''}`}>{text}</p>
            {long && (
              <button className="link-btn" onClick={() => setExpanded((x) => !x)}>
                {expanded ? 'Show less' : 'Read more'}
              </button>
            )}
          </section>
        )}

        <section className="panel-section">
          <div className="media-tabs" role="tablist">
            {(
              [
                ['media', 'Media', info?.media.length],
                ['files', 'Docs', info?.files.length],
                ['links', 'Links', info?.links.length],
              ] as const
            ).map(([key, label, n]) => (
              <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'on' : undefined} onClick={() => setTab(key)}>
                {label}
                {n ? <span>{n}</span> : null}
              </button>
            ))}
          </div>
          {info && tab === 'media' && (info.media.length ? (
            <div className="media-grid">
              {info.media.map((m) => (
                <button key={m.attachment.id} onClick={() => onOpenMedia(m.attachment, m.authorName, m.sentAt)} aria-label={`Open ${m.attachment.filename ?? 'media'}`}>
                  {m.attachment.contentType.startsWith('image/') ? (
                    <>
                      <img src={attachmentUrl(m.attachment.id)} alt="" loading="lazy" />
                      {m.attachment.contentType === 'image/gif' && <span className="media-badge">GIF</span>}
                    </>
                  ) : (
                    <>
                      <video src={attachmentUrl(m.attachment.id)} muted preload="metadata" />
                      {!m.attachment.gif && <span className="media-badge">Video</span>}
                      {m.attachment.gif && <span className="media-badge">GIF</span>}
                    </>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <p className="muted panel-empty">Photos and videos sent in this chat appear here.</p>
          ))}
          {info && tab === 'files' && (info.files.length ? (
            <ul className="panel-list">
              {info.files.map((f) => (
                <li key={f.attachment.id}>
                  <a className="file" href={attachmentUrl(f.attachment.id, f.attachment.filename ?? f.attachment.id)}>
                    <Icon name="file" size={24} />
                    <span>
                      <strong>{f.attachment.filename ?? 'File'}</strong>
                      <small>
                        {formatSize(f.attachment.size)} · {f.authorName}, {formatDay(f.sentAt)}
                      </small>
                    </span>
                    <Icon name="download" size={20} />
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted panel-empty">Documents sent in this chat appear here.</p>
          ))}
          {info && tab === 'links' && (info.links.length ? (
            <ul className="panel-list">
              {info.links.map((l, i) => (
                <li key={i}>
                  <a className="file" href={l.url} target="_blank" rel="noopener noreferrer">
                    <Icon name="link" size={22} />
                    <span>
                      <strong>{l.url.replace(/^https?:\/\/(www\.)?/, '')}</strong>
                      <small>
                        {l.authorName}, {formatDay(l.sentAt)}
                      </small>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted panel-empty">Links shared in this chat appear here.</p>
          ))}
        </section>

        {group && info?.members && (
          <section className="panel-section members">
            <h4>{info.memberCount} members</h4>
            {info.memberCount > 8 && (
              <div className="search panel-search">
                <Icon name="search" size={18} />
                <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search members" aria-label="Search members" />
              </div>
            )}
            <ul className="member-list">
              {members.map((m) => (
                <li key={m.key}>
                  <button className="member" onClick={() => openMember(m)} disabled={m.key === 'self'} title={m.key === 'self' ? undefined : `Message ${m.name}`}>
                    <Avatar name={m.name} seed={String(m.number ?? m.name)} size={40} src={m.avatar} />
                    <span className="member-text">
                      <strong>{m.name}</strong>
                      <small>{m.about || m.number || (m.username ? '@' + m.username : m.name === 'Unknown' ? 'Not in your contacts' : '')}</small>
                    </span>
                    {m.admin && <span className="admin-badge">Group admin</span>}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------

function when(ts: number) {
  return `${formatDay(ts)}, ${formatTime(ts)}`;
}

export function MessageInfoPanel({ messageId }: { messageId: number }) {
  const tick = useStore((s) => s.receiptTick);
  const [data, setData] = useState<{ message: Message; recipients: Recipient[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .messageInfo(messageId)
      .then((d) => !cancelled && (setData(d), setError(null)))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [messageId, tick]);

  const read = data?.recipients.filter((r) => r.readAt) ?? [];
  const delivered = data?.recipients.filter((r) => !r.readAt && r.deliveredAt) ?? [];
  const waiting = data?.recipients.filter((r) => !r.readAt && !r.deliveredAt) ?? [];
  const m = data?.message;

  const list = (title: string, people: Recipient[], time: (r: Recipient) => number | null) =>
    people.length > 0 && (
      <section className="panel-section">
        <h4>
          {title} <span className="muted">{people.length}</span>
        </h4>
        <ul className="member-list">
          {people.map((r) => (
            <li key={r.key} className="member static">
              <Avatar name={r.name} seed={r.name} size={36} src={r.avatar} />
              <span className="member-text">
                <strong>{r.name}</strong>
                {time(r) && <small>{when(time(r)!)}</small>}
              </span>
            </li>
          ))}
        </ul>
      </section>
    );

  return (
    <aside className="panel" aria-label="Message info">
      <PanelHead title="Message info" />
      <div className="panel-body">
        {error && <p className="form-error pad">{error}</p>}
        {m && (
          <section className="panel-section info-preview">
            <div className="bubble out-preview">
              {m.kind === 'sticker' && m.sticker ? (
                <img className="sticker-img small" src={m.sticker.url} alt="Sticker" />
              ) : null}
              {m.body || (m.kind === 'sticker' ? '' : null) || (m.attachments.length ? (m.attachments[0].contentType.startsWith('image/') ? 'Photo' : m.attachments[0].filename ?? 'Attachment') : '')}
              <span className="meta">
                {formatTime(m.sentAt)} <StatusMark status={m.status} />
              </span>
            </div>
            <p className="muted">Sent {when(m.sentAt)}</p>
          </section>
        )}
        {list('Read by', read, (r) => r.readAt)}
        {list('Delivered to', delivered, (r) => r.deliveredAt)}
        {list(m?.status === 'pending' ? 'Sending to' : 'Not delivered yet', waiting, () => null)}
        {data && !data.recipients.length && <p className="muted panel-empty">No delivery information yet.</p>}
        <p className="muted panel-note">
          People who turned off read receipts in Signal never show up under “Read by”.
        </p>
      </div>
    </aside>
  );
}
