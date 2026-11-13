/**
 * The panel on the right: chat info (picture, name, about/description, media and links, members,
 * group management from GroupManage.tsx, disappearing messages, block, WhatsApp contact actions),
 * search in the chat (and "go to date"), and message info (who received/read it). Which one is open
 * is `panel` in the store.
 */
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { api, attachmentUrl, thumbUrl, tinyBehind } from '../api';
import { setState, upsertConversation, useStore } from '../store';
import { jumpToMessage } from '../jump';
import { NETWORK_LABEL, capsFor } from '../networks';
import type { Attachment, Conversation, ConversationInfo, Member, Message, Recipient, SearchResult } from '../types';
import { durationLabel, formatDay, formatListTime, formatSize, formatTime, safeHref, squareAvatar, TIMER_OPTIONS } from '../util';
import { Avatar, Icon, StatusMark } from './ui';
import { EditableText, GroupManageSections, MemberMenu, useGroup } from './GroupManage';

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

export function ChatInfoPanel({ conversation, onOpenMedia }: { conversation: Conversation; onOpenMedia: (a: Attachment, authorName: string, sentAt: number, messageId: number) => void }) {
  const [info, setInfo] = useState<ConversationInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'media' | 'files' | 'links'>('media');
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState('');
  const id = conversation.id;
  const groupTick = useStore((s) => s.groupTick[id] ?? 0);

  // Reload when the chat changes, new messages/members arrive, or the group changes (admins, labels).
  useEffect(() => {
    let cancelled = false;
    api
      .info(id)
      .then((i) => !cancelled && (setInfo(i), setError(null)))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [id, conversation.lastMessageAt, conversation.title, conversation.members?.length, conversation.admin, conversation.left, groupTick]);

  useEffect(() => {
    setExpanded(false);
    setFilter('');
    setTab('media');
  }, [id]);

  const group = conversation.kind === 'group';
  const g = useGroup(conversation);
  const canEdit = group && !!g.details?.canEditInfo;
  const labels = g.details?.labels ?? {};
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
      const c = await api.startChat(
        m.key.startsWith('wa:') ? { network: 'whatsapp', jid: m.key.slice(3) } : m.key.startsWith('+') ? { number: m.key } : { uuid: m.key, number: m.number ?? undefined },
      );
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
          {canEdit && capsFor(conversation).groupPhoto ? (
            <button className="profile-photo" onClick={() => photoInput.current?.click()} title="Change group picture" aria-label="Change group picture" disabled={photoBusy}>
              <Avatar key={conversation.avatar ?? ''} name={conversation.title} seed={String(conversation.title)} group size={120} src={conversation.avatar} />
              <span className="photo-overlay">{photoBusy ? <span className="spinner small" /> : <Icon name="camera" size={26} />}</span>
            </button>
          ) : (
            <Avatar name={conversation.title} seed={String(conversation.number ?? conversation.title)} group={group} size={120} src={conversation.avatar} />
          )}
          <input ref={photoInput} type="file" accept="image/*" hidden onChange={(e) => (void changeGroupPhoto(e.target.files?.[0]), (e.target.value = ''))} />
          {canEdit ? (
            <EditableText value={conversation.title} label="Edit group name" max={conversation.network === 'whatsapp' ? 100 : 32} onSave={(v) => g.act({ action: 'rename', name: v.trim() })}>
              <h3>{conversation.title}</h3>
            </EditableText>
          ) : (
            <h3>{conversation.title}</h3>
          )}
          <p className="muted">
            {group
              ? `${conversation.network === 'whatsapp' ? 'WhatsApp group' : 'Group'} · ${info?.memberCount ?? conversation.members?.length ?? 0} members`
              : [conversation.number, conversation.username ? '@' + conversation.username : null].filter(Boolean).join('  ')}
          </p>
        </section>

        {error && <p className="form-error pad">{error}</p>}
        {g.error && <p className="form-error pad">{g.error}</p>}

        {canEdit && (
          <section className="panel-section">
            <h4>Description</h4>
            <EditableText
              value={info?.description ?? ''}
              label={info?.description ? 'Edit group description' : 'Add group description'}
              multiline
              max={conversation.network === 'whatsapp' ? 2048 : 480}
              placeholder="Group description"
              onSave={async (v) => {
                const ok = await g.act({ action: 'describe', description: v });
                if (ok) setInfo((i) => (i ? { ...i, description: v.trim() || null } : i));
                return ok;
              }}
            >
              {info?.description ? (
                <p className={`panel-text${long && !expanded ? ' clamped' : ''}`}>{info.description}</p>
              ) : (
                <p className="muted panel-text">Add a group description</p>
              )}
            </EditableText>
            {long && (
              <button className="link-btn" onClick={() => setExpanded((x) => !x)}>
                {expanded ? 'Show less' : 'Read more'}
              </button>
            )}
          </section>
        )}

        {text && !canEdit && (
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

        {capsFor(conversation).timer && <DisappearingSection conversation={conversation} />}

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
                <button
                  key={m.attachment.id}
                  onClick={() => (m.attachment.pending ? void api.fetchAttachment(m.attachment.id).catch(() => {}) : onOpenMedia(m.attachment, m.authorName, m.sentAt, m.messageId))}
                  aria-label={`Open ${m.attachment.filename ?? 'media'}`}
                  title={m.attachment.pending ? 'Not on the server yet: click to get it from WhatsApp' : undefined}
                >
                  {m.attachment.pending ? (
                    <span className="media-badge">{m.attachment.contentType.startsWith('image/') ? 'Photo' : 'Video'} · not loaded</span>
                  ) : m.attachment.contentType.startsWith('image/') ? (
                    <>
                      <img src={thumbUrl(m.attachment)} alt="" loading="lazy" style={tinyBehind(m.attachment)} />
                      {m.attachment.contentType === 'image/gif' && <span className="media-badge">GIF</span>}
                    </>
                  ) : (
                    <>
                      {/* the video's still, not the video: a page of them stays light */}
                      <img src={thumbUrl(m.attachment)} alt="" loading="lazy" style={tinyBehind(m.attachment)} onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
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
                  <a className="file" href={safeHref(l.url)} target="_blank" rel="noopener noreferrer">
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
                <li key={m.key} className="member-row">
                  <button className="member" onClick={() => openMember(m)} disabled={m.key === 'self'} title={m.key === 'self' ? undefined : `Message ${m.name}`}>
                    <Avatar name={m.name} seed={String(m.number ?? m.name)} size={40} src={m.avatar} />
                    <span className="member-text">
                      <strong>
                        {m.name}
                        {(labels[m.key] ?? m.label) && <span className="member-label">{labels[m.key] ?? m.label}</span>}
                      </strong>
                      <small>{m.about || m.number || (m.username ? '@' + m.username : m.name === 'Unknown' ? 'Not in your contacts' : '')}</small>
                    </span>
                    {m.admin && <span className="admin-badge">Group admin</span>}
                  </button>
                  {m.key !== 'self' && g.details?.admin && g.details.member && <MemberMenu member={m} group={g} onMessage={() => void openMember(m)} />}
                </li>
              ))}
            </ul>
          </section>
        )}

        {group && <GroupManageSections conversation={conversation} group={g} members={info?.members ?? []} />}

        {!group && conversation.network === 'whatsapp' && conversation.number && <WaContactSection conversation={conversation} />}
        <section className="panel-section">
          <button className="panel-action" onClick={() => setState({ exportDialog: { preselect: [conversation.id] } })}>
            <Icon name="download" size={20} /> Export chat
          </button>
        </section>

        {!group && conversation.network === 'whatsapp' && <BlockSection conversation={conversation} />}
      </div>
    </aside>
  );
}

function DisappearingSection({ conversation }: { conversation: Conversation }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = conversation.expireTimer;
  const options = TIMER_OPTIONS.includes(current) || !current ? TIMER_OPTIONS : [...TIMER_OPTIONS, current].sort((a, b) => a - b);

  async function choose(seconds: number) {
    if (seconds === current) return;
    setBusy(true);
    setError(null);
    try {
      upsertConversation(await api.setTimer(conversation.id, seconds));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel-section">
      <h4>Disappearing messages</h4>
      <label className="timer-row">
        <Icon name="timer" size={20} />
        <select value={current} disabled={busy} onChange={(e) => void choose(Number(e.target.value))} aria-label="Disappearing messages timer">
          <option value={0} disabled>
            Off{current ? ' (switch off on your phone)' : ''}
          </option>
          {options.map((s) => (
            <option key={s} value={s}>
              {durationLabel(s)}
            </option>
          ))}
        </select>
        {busy && <span className="spinner small" />}
      </label>
      <p className="muted panel-note">
        {current
          ? `New messages disappear ${durationLabel(current)} after they've been read.`
          : 'Off. When on, new messages disappear for everyone after they have been read.'}{' '}
        Signal's API can't switch the timer off; use your phone for that.
      </p>
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------

/** Search inside the open chat; picking a result jumps to it. */
/** yyyy-mm-dd in your own time zone. */
function dayString(ts: number) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function SearchPanel({ conversation, date = false }: { conversation: Conversation; date?: boolean }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<{ first: number | null; last: number | null } | null>(null);
  const [day, setDay] = useState('');
  const [dayNote, setDayNote] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const dateInput = useRef<HTMLInputElement>(null);
  const id = conversation.id;

  useEffect(() => {
    if (!date) return input.current?.focus();
    dateInput.current?.focus();
    try {
      dateInput.current?.showPicker?.();
    } catch {
      /* needs a click in some browsers */
    }
  }, [date]);
  useEffect(() => {
    setRange(null);
    setDay('');
    setDayNote(null);
    api.messageNearDate(id).then((r) => setRange(r), () => {});
  }, [id]);

  async function goTo(value: string) {
    setDay(value);
    setDayNote(null);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
    try {
      const start = new Date(`${value}T00:00:00`).getTime();
      const r = await api.messageNearDate(id, start);
      if (r.sentAt === null) return setDayNote('No messages in this chat yet.');
      if (dayString(r.sentAt) !== value) setDayNote(`No messages that day; showing ${formatDay(r.sentAt)}.`);
      await jumpToMessage(id, r.sentAt);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return setResults(null);
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .search(term, id)
        .then((r) => !cancelled && (setResults(r.results), setError(null)))
        .catch((e) => !cancelled && setError(e.message));
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, id]);

  return (
    <aside className="panel" aria-label="Search messages">
      <PanelHead title="Search messages" />
      <div className="panel-body">
        <div className="search panel-search">
          <Icon name="search" size={18} />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), q ? setQ('') : setState({ panel: null }))}
            placeholder={`Search in ${conversation.title}`}
            aria-label="Search messages"
          />
        </div>
        <label className="date-jump">
          <Icon name="calendar" size={18} />
          <span>Go to date</span>
          <input
            ref={dateInput}
            type="date"
            value={day}
            min={range?.first ? dayString(range.first) : undefined}
            max={range?.last ? dayString(Math.max(range.last, Date.now())) : undefined}
            onChange={(e) => void goTo(e.target.value)}
            aria-label="Go to date"
          />
        </label>
        {dayNote && <p className="muted panel-empty">{dayNote}</p>}
        {range?.first && !results && <p className="muted panel-empty">History here goes back to {formatDay(range.first)}.</p>}
        {error && <p className="form-error pad">{error}</p>}
        {results && !results.length && <p className="muted panel-empty">No messages found.</p>}
        {!results && <p className="muted panel-empty">Search the messages Messenger Web has for this chat.</p>}
        <ul className="search-results">
          {results?.map((r) => (
            <li key={r.id}>
              <button onClick={() => void jumpToMessage(r.conversationId, r.sentAt).catch((e) => setError(e.message))}>
                <span className="search-result-top">
                  <strong>{r.outgoing ? 'You' : r.authorName}</strong>
                  <time>{formatListTime(r.sentAt)}</time>
                </span>
                <Highlight text={r.snippet} term={q.trim()} />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

export function Highlight({ text, term }: { text: string; term: string }) {
  if (!term) return <span className="snippet">{text}</span>;
  const lower = text.toLowerCase();
  const t = term.toLowerCase();
  const parts: ReactNode[] = [];
  let pos = 0;
  for (let at = lower.indexOf(t); at >= 0 && t; at = lower.indexOf(t, at + t.length)) {
    parts.push(text.slice(pos, at), <mark key={at}>{text.slice(at, at + t.length)}</mark>);
    pos = at + t.length;
  }
  parts.push(text.slice(pos));
  return <span className="snippet">{parts}</span>;
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
  const conv = useStore((s) => (m ? s.conversations[m.conversationId] : undefined));

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
        {data && !data.recipients.length && (
          <p className="muted panel-empty">
            No delivery information yet.
          </p>
        )}
        <p className="muted panel-note">
          People who turned off read receipts in Signal never show up under “Read by”.
        </p>
      </div>
    </aside>
  );
}

function BlockSection({ conversation }: { conversation: Conversation }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = conversation.title;
  async function toggle() {
    if (!conversation.blocked && !confirm(`Block ${name}? Blocked contacts can't call you or send you messages.`)) return;
    setBusy(true);
    setError(null);
    try {
      upsertConversation(await api.block(conversation.id, !conversation.blocked));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel-section">
      <button className={`panel-action${conversation.blocked ? '' : ' danger'}`} disabled={busy} onClick={() => void toggle()}>
        <Icon name="block" size={20} /> {conversation.blocked ? `Unblock ${name}` : `Block ${name}`}
      </button>
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}

/** Save someone in your WhatsApp contacts (your phone's address book), or change the name there. */
function WaContactSection({ conversation }: { conversation: Conversation }) {
  const [editing, setEditing] = useState(false);
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const known = !/^\+?\d[\d\s]*$/.test(conversation.title); // a name, not just the number
  function start() {
    const parts = known ? conversation.title.split(' ') : [];
    setFirst(parts[0] ?? '');
    setLast(parts.slice(1).join(' '));
    setEditing(true);
    setDone(false);
  }
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.saveWaContact(conversation.number!.replace(/\D/g, '') + '@c.us', first.trim(), last.trim());
      setEditing(false);
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel-section">
      {!editing ? (
        <button className="panel-action" onClick={start}>
          <Icon name="pencil" size={20} /> {known ? 'Edit contact' : 'Add to contacts'}
        </button>
      ) : (
        <div className="contact-edit">
          <label className="field">
            <span>First name</span>
            <input value={first} onChange={(e) => setFirst(e.target.value)} maxLength={100} autoFocus aria-label="First name" />
          </label>
          <label className="field">
            <span>Last name</span>
            <input value={last} onChange={(e) => setLast(e.target.value)} maxLength={100} aria-label="Last name" />
          </label>
          <div className="setting-actions">
            <button className="btn primary" onClick={() => void save()} disabled={busy || !first.trim()}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button className="btn" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {done && <p className="muted setting-note">Saved in your WhatsApp contacts. Your phone shows it within a minute.</p>}
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}
