/** Polls (showing, voting, creating) and forwarding messages. */
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { setState, upsertMessages, useStore } from '../store';
import type { Message } from '../types';
import { Avatar, Icon } from './ui';
import { Emojified } from '../emoji/render';

function Dialog({ title, onClose, children, label }: { title: string; onClose: () => void; children: ReactNode; label?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={label ?? title}>
        <header className="dialog-head">
          <h2>{title}</h2>
          <button className="icon-btn sm" onClick={onClose} aria-label="Close">
            <Icon name="close" size={20} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function PollView({ m, canEnd = true }: { m: Message; canEnd?: boolean }) {
  const poll = m.poll!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const max = Math.max(1, ...poll.options.map((o) => o.voters.length));

  async function vote(i: number) {
    if (poll.closed || busy) return;
    let next: number[];
    if (poll.multiple) next = poll.mine.includes(i) ? poll.mine.filter((x) => x !== i) : [...poll.mine, i];
    else next = [i];
    if (!next.length) return setError("Signal can't take back a vote; pick another option instead.");
    if (!poll.multiple && poll.mine.length === 1 && poll.mine[0] === i) return;
    setBusy(true);
    setError(null);
    try {
      upsertMessages(m.conversationId, [await api.vote(m.id, next)]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function end() {
    if (!confirm('End this poll? Nobody can vote after that.')) return;
    try {
      upsertMessages(m.conversationId, [await api.closePoll(m.id)]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className={`poll${poll.closed ? ' closed' : ''}`}>
      <strong className="poll-q">
        <Emojified text={poll.question} />
      </strong>
      <small className="poll-kind">{poll.closed ? 'Poll ended' : poll.multiple ? 'Select one or more' : 'Select one'}</small>
      <ul>
        {poll.options.map((o, i) => {
          const mine = poll.mine.includes(i);
          return (
            <li key={i}>
              <button
                className={`poll-option${mine ? ' mine' : ''}`}
                onClick={() => void vote(i)}
                disabled={poll.closed || busy || m.status === 'pending'}
                aria-pressed={mine}
                title={o.voters.length ? o.voters.map((v) => v.name).join(', ') : 'No votes yet'}
              >
                <span className={`poll-check${poll.multiple ? ' square' : ''}`} aria-hidden>
                  {mine && <Icon name="check" size={14} />}
                </span>
                <span className="poll-text">
                  <Emojified text={o.text} />
                </span>
                <span className="poll-count">{o.voters.length}</span>
                <span className="poll-bar" style={{ width: `${(o.voters.length / max) * 100}%` }} />
              </button>
            </li>
          );
        })}
      </ul>
      <div className="poll-foot">
        <span>
          {poll.totalVoters} {poll.totalVoters === 1 ? 'person voted' : 'people voted'}
        </span>
        {m.outgoing && !poll.closed && canEnd && (
          <button className="link-btn" onClick={() => void end()}>
            End poll
          </button>
        )}
      </div>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

export function PollDialog({ conversationId, onClose }: { conversationId: number; onClose: () => void }) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multiple, setMultiple] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);

  function setOption(i: number, v: string) {
    const next = options.map((o, j) => (j === i ? v : o));
    // Always one empty field at the end, up to 10 options.
    if (next[next.length - 1].trim() && next.length < 10) next.push('');
    setOptions(next);
  }

  const filled = options.map((o) => o.trim()).filter(Boolean);
  const ok = question.trim() && filled.length >= 2 && new Set(filled).size === filled.length;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      const msg = await api.createPoll(conversationId, { question: question.trim(), options: filled, multiple });
      upsertMessages(conversationId, [msg]);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Dialog title="New poll" onClose={onClose}>
      <form className="dialog-body poll-form" onSubmit={submit}>
        <label className="field">
          <span>Question</span>
          <input ref={first} value={question} maxLength={200} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask a question" />
        </label>
        <div className="field">
          <span>Options</span>
          {options.map((o, i) => (
            <div key={i} className="poll-form-option">
              <input value={o} maxLength={100} onChange={(e) => setOption(i, e.target.value)} placeholder={`Option ${i + 1}`} aria-label={`Option ${i + 1}`} />
              {options.length > 2 && o && (
                <button type="button" className="icon-btn sm" onClick={() => setOptions(options.filter((_, j) => j !== i))} aria-label={`Remove option ${i + 1}`}>
                  <Icon name="close" size={16} />
                </button>
              )}
            </div>
          ))}
        </div>
        <label className="setting-row">
          <span className="setting-text">
            <strong>Allow multiple answers</strong>
          </span>
          <input type="checkbox" role="switch" className="switch" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} />
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!ok || busy}>
            {busy ? 'Sending…' : 'Send poll'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------

export function ForwardDialog({ message, onClose }: { message: Message; onClose: () => void }) {
  const conversations = useStore((s) => s.conversations);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    return Object.values(conversations)
      .filter((c) => !term || c.title.toLowerCase().includes(term) || c.number?.includes(term))
      .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
  }, [conversations, q]);

  const toggle = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 5 ? p : [...p, id]));

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.forward(message.id, picked);
      for (const m of r.messages) upsertMessages(m.conversationId, [m]);
      if (picked.length === 1) setState({ activeId: picked[0] });
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const what = message.kind === 'sticker' ? 'Sticker' : message.body || (message.attachments.length ? `${message.attachments.length} attachment${message.attachments.length > 1 ? 's' : ''}` : '');

  return (
    <Dialog title="Forward message" onClose={onClose}>
      <div className="dialog-body">
        <p className="forward-what">{what}</p>
        <div className="search">
          <Icon name="search" size={18} />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats" aria-label="Search chats" />
        </div>
        <ul className="forward-list">
          {list.map((c) => (
            <li key={c.id}>
              <label className={`forward-row${picked.includes(c.id) ? ' on' : ''}`}>
                <input type="checkbox" checked={picked.includes(c.id)} onChange={() => toggle(c.id)} disabled={!picked.includes(c.id) && picked.length >= 5} />
                <Avatar name={c.title} seed={String(c.number ?? c.title)} group={c.kind === 'group'} size={36} src={c.avatar} />
                <span>{c.title}</span>
              </label>
            </li>
          ))}
        </ul>
        {error && <p className="form-error">{error}</p>}
        <div className="dialog-actions">
          <span className="muted">{picked.length ? `${picked.length} of 5 chosen` : 'Choose up to 5 chats'}</span>
          <button className="btn primary" onClick={() => void send()} disabled={!picked.length || busy}>
            <Icon name="forward" size={18} /> {busy ? 'Forwarding…' : 'Forward'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
