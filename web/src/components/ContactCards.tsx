/**
 * Contact cards: shared contacts shown in a message (name, numbers, organisation, with "Message" to open
 * or start a chat with them on this chat's network, and "Copy"), and the window to share one of your
 * contacts (Signal and WhatsApp contacts with a number, searchable).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { setState, upsertConversation, upsertMessages } from '../store';
import type { Conversation, Message, SharedContact } from '../types';
import { Dialog } from './Extras';
import { Avatar } from './ui';

const plain = (n: string) => {
  const d = n.replace(/[^\d+]/g, '');
  return d.startsWith('+') ? d : d.startsWith('00') ? '+' + d.slice(2) : '+' + d;
};

export function ContactCards({ m, network }: { m: Message; network: 'signal' | 'whatsapp' }) {
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  async function message(number: string) {
    setError(null);
    try {
      const c = await api.startChat(network === 'whatsapp' ? { network: 'whatsapp', number: plain(number) } : { number: plain(number) });
      upsertConversation(c);
      setState({ activeId: c.id, panel: null });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="contact-cards">
      {(m.contacts ?? []).map((c, i) => (
        <div key={i} className="contact-card">
          <div className="contact-card-head">
            <Avatar name={c.name} seed={c.numbers[0] ?? c.name} size={40} />
            <span className="contact-card-text">
              <strong>{c.name}</strong>
              {c.organization && <small>{c.organization}</small>}
              {c.numbers.map((n) => (
                <small key={n} className="contact-card-number">
                  {n}
                </small>
              ))}
            </span>
          </div>
          {c.numbers[0] && (
            <div className="contact-card-actions">
              <button className="link-btn" onClick={() => void message(c.numbers[0])}>
                Message
              </button>
              <button
                className="link-btn"
                onClick={() => void navigator.clipboard?.writeText(c.numbers[0]).then(() => (setCopied(c.numbers[0]), setTimeout(() => setCopied(null), 1500)))}
              >
                {copied === c.numbers[0] ? 'Copied' : 'Copy number'}
              </button>
            </div>
          )}
        </div>
      ))}
      {error && <small className="form-error">{error}</small>}
    </div>
  );
}

interface Pick {
  name: string;
  number: string;
  network: string;
}

export function ShareContactDialog({ conversation, onClose }: { conversation: Conversation; onClose: () => void }) {
  const [dir, setDir] = useState<Awaited<ReturnType<typeof api.directory>> | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    api.directory().then(setDir, (e) => setError(e.message));
    input.current?.focus();
  }, []);
  // Everyone with a number, from both networks, once per number (Signal's name first)
  const people = useMemo(() => {
    const seen = new Map<string, Pick>();
    for (const c of dir?.contacts ?? []) if (c.number) seen.set(c.number.replace(/\D/g, ''), { name: c.name, number: c.number, network: 'Signal' });
    for (const c of dir?.waContacts ?? []) {
      if (!c.number) continue;
      const k = c.number.replace(/\D/g, '');
      const had = seen.get(k);
      if (had) had.network = 'Signal · WhatsApp';
      else seen.set(k, { name: c.name, number: c.number.startsWith('+') ? c.number : '+' + c.number, network: 'WhatsApp' });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [dir]);
  const query = q.trim().toLowerCase();
  const digits = query.replace(/\D/g, '');
  const shown = people.filter((p) => !query || p.name.toLowerCase().includes(query) || (!!digits && p.number.replace(/\D/g, '').includes(digits))).slice(0, 200);

  async function share(p: Pick) {
    setBusy(true);
    setError(null);
    try {
      upsertMessages(conversation.id, [await api.shareContact(conversation.id, { name: p.name, number: p.number })]);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Share a contact" onClose={onClose}>
      <div className="dialog-body share-contact">
        <div className="search">
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a contact" aria-label="Find a contact" />
        </div>
        {conversation.network === 'signal' && <p className="muted panel-note">Signal can’t send contact cards from here: the name and number go as a message, with a contact file to save.</p>}
        {!dir && !error && <p className="muted">Loading…</p>}
        <ul className="member-list">
          {shown.map((p) => (
            <li key={p.number} className="member-row">
              <button className="member" onClick={() => void share(p)} disabled={busy}>
                <Avatar name={p.name} seed={p.number} size={36} />
                <span className="member-text">
                  <strong>{p.name}</strong>
                  <small>
                    {p.number} · {p.network}
                  </small>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {dir && !shown.length && <p className="muted">No contact with a phone number matches.</p>}
        {error && <p className="form-error">{error}</p>}
      </div>
    </Dialog>
  );
}
export type { SharedContact };
