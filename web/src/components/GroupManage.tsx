/**
 * Group management, the same for Signal and WhatsApp: the parts of group info that change things
 * (name, description, members, admins, settings, invite link, join requests, your label, leaving),
 * making a new group, and joining a WhatsApp group with a link.
 */
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { setState, upsertConversation, useStore } from '../store';
import type { Conversation, GroupAction, GroupDetails, GroupPerson, GroupSettings, Member, Network, Who } from '../types';
import { safeHref, squareAvatar } from '../util';
import { Avatar, Icon } from './ui';

/** Loads the group's details and runs actions on it; reloads when the group changes elsewhere. */
export function useGroup(conversation: Conversation) {
  const [details, setDetails] = useState<GroupDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const tick = useStore((s) => s.groupTick[conversation.id] ?? 0);
  const id = conversation.id;
  const isGroup = conversation.kind === 'group';
  useEffect(() => {
    if (!isGroup) return;
    let cancelled = false;
    api.group(id).then(
      (d) => !cancelled && setDetails(d),
      (e) => !cancelled && setError(e.message),
    );
    return () => {
      cancelled = true;
    };
  }, [id, isGroup, tick, conversation.members?.length, conversation.title, conversation.left]);
  useEffect(() => {
    setDetails(null);
    setError(null);
  }, [id]);

  async function act(a: GroupAction, label = a.action): Promise<boolean> {
    setBusy(label);
    setError(null);
    try {
      const r = await api.groupAction(id, a);
      upsertConversation(r.conversation);
      if (r.details) setDetails(r.details);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  }
  return { details, error, setError, busy, act };
}
export type GroupHandle = ReturnType<typeof useGroup>;

// ---------------------------------------------------------------------------
// Editing the name and description

export function EditableText({
  value,
  label,
  multiline,
  max,
  placeholder,
  onSave,
  children,
}: {
  value: string;
  label: string;
  multiline?: boolean;
  max: number;
  placeholder?: string;
  onSave: (v: string) => Promise<boolean>;
  children: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const [saving, setSaving] = useState(false);
  useEffect(() => setText(value), [value]);
  if (!editing)
    return (
      <div className="editable">
        {children}
        <button className="icon-btn small" onClick={() => setEditing(true)} aria-label={label} title={label}>
          <Icon name="pencil" size={18} />
        </button>
      </div>
    );
  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (text.trim() === value.trim()) return setEditing(false);
    setSaving(true);
    const ok = await onSave(text);
    setSaving(false);
    if (ok) setEditing(false);
  }
  return (
    <form className="editable editing" onSubmit={save}>
      {multiline ? (
        <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={max} rows={4} placeholder={placeholder} aria-label={label} autoFocus />
      ) : (
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={max} placeholder={placeholder} aria-label={label} autoFocus />
      )}
      <small className="muted">{max - text.length}</small>
      <button className="icon-btn small" type="submit" disabled={saving} aria-label="Save" title="Save">
        {saving ? <span className="spinner small" /> : <Icon name="check" size={18} />}
      </button>
      <button className="icon-btn small" type="button" onClick={() => (setText(value), setEditing(false))} aria-label="Cancel" title="Cancel">
        <Icon name="close" size={18} />
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Member actions (admins)

export function MemberMenu({ member, group, onMessage }: { member: Member; group: GroupHandle; onMessage: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const admin = group.details?.admin && group.details.member;
  return (
    <span className="member-menu-wrap" ref={ref}>
      <button className="icon-btn small member-menu-btn" onClick={() => setOpen((o) => !o)} aria-label={`Options for ${member.name}`} aria-haspopup="menu" aria-expanded={open}>
        <Icon name="down" size={18} />
      </button>
      {open && (
        <div className="row-menu member-menu" role="menu">
          <button role="menuitem" onClick={() => (setOpen(false), onMessage())}>
            Message {member.name}
          </button>
          {admin &&
            (member.admin ? (
              <button role="menuitem" onClick={() => (setOpen(false), void group.act({ action: 'demote', members: [member.key] }))}>
                Dismiss as admin
              </button>
            ) : (
              <button role="menuitem" onClick={() => (setOpen(false), void group.act({ action: 'promote', members: [member.key] }))}>
                Make group admin
              </button>
            ))}
          {admin && (
            <button
              role="menuitem"
              className="danger"
              onClick={() => (setOpen(false), confirm(`Remove ${member.name} from the group?`) && void group.act({ action: 'remove', members: [member.key] }))}
            >
              Remove from group
            </button>
          )}
        </div>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Choosing people (new group, add members)

type Candidate = { id: string; name: string; number: string | null; avatar?: string };

function useCandidates(network: Network) {
  const [list, setList] = useState<Candidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setList(null);
    api.directory().then(
      (d) =>
        setList(
          network === 'whatsapp'
            ? d.waContacts.map((c) => ({ id: c.jid, name: c.name, number: c.number, avatar: `/api/avatars/wa/${encodeURIComponent(c.jid)}.jpg` }))
            : d.contacts.map((c) => ({ id: c.uuid ?? c.number ?? c.key, name: c.name, number: c.number ?? (c.username ? '@' + c.username : null) })),
        ),
      (e) => setError(e.message),
    );
  }, [network]);
  return { list, error };
}

export function PeoplePicker({ network, exclude, chosen, onChange }: { network: Network; exclude?: Set<string>; chosen: Candidate[]; onChange: (c: Candidate[]) => void }) {
  const { list, error } = useCandidates(network);
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const digits = query.replace(/[\s()+-]/g, '');
  const ids = new Set(chosen.map((c) => c.id));
  const shown = (list ?? []).filter(
    (c) => !exclude?.has(c.id) && (!query || c.name.toLowerCase().includes(query) || (!!digits && /^\d+$/.test(digits) && !!c.number?.replace(/\D/g, '').includes(digits))),
  );
  const toggle = (c: Candidate) => onChange(ids.has(c.id) ? chosen.filter((x) => x.id !== c.id) : [...chosen, c]);
  return (
    <div className="people-picker">
      {chosen.length > 0 && (
        <div className="chips">
          {chosen.map((c) => (
            <button key={c.id} className="chip" onClick={() => toggle(c)} aria-label={`Remove ${c.name}`}>
              {c.name} <Icon name="close" size={14} />
            </button>
          ))}
        </div>
      )}
      <div className="search">
        <Icon name="search" size={18} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or number" aria-label="Search contacts" autoFocus />
      </div>
      {error && <p className="form-error pad">{error}</p>}
      {!list && !error && <div className="spinner picker-spinner" aria-label="Loading" />}
      <ul className="people-list">
        {shown.slice(0, 300).map((c) => (
          <li key={c.id}>
            <label className={`person${ids.has(c.id) ? ' on' : ''}`}>
              <input type="checkbox" checked={ids.has(c.id)} onChange={() => toggle(c)} />
              <Avatar name={c.name} seed={String(c.number ?? c.name)} size={36} src={c.avatar} />
              <span className="member-text">
                <strong>{c.name}</strong>
                <small>{c.number ?? ''}</small>
              </span>
            </label>
          </li>
        ))}
        {list && !shown.length && <li className="muted pad">{query ? 'Nobody matches.' : 'No contacts yet.'}</li>}
      </ul>
    </div>
  );
}

function AddMembers({ conversation, group, onDone }: { conversation: Conversation; group: GroupHandle; onDone: () => void }) {
  const [chosen, setChosen] = useState<Candidate[]>([]);
  // Present members, as the ids the directory uses.
  const exclude = useMemo(
    () => new Set((conversation.members ?? []).map((m) => (m.key.startsWith('wa:') ? m.key.slice(3) : m.key))),
    [conversation.members],
  );
  return (
    <div className="add-members">
      <PeoplePicker network={conversation.network} exclude={exclude} chosen={chosen} onChange={setChosen} />
      <div className="setting-actions">
        <button className="btn" onClick={onDone}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!chosen.length || !!group.busy}
          onClick={async () => {
            if (await group.act({ action: 'add', members: chosen.map((c) => c.id) })) onDone();
          }}
        >
          {group.busy === 'add' ? 'Adding…' : `Add ${chosen.length || ''}`.trim()}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The management sections of group info

const WHO: [Who, string][] = [
  ['all', 'All members'],
  ['admins', 'Only admins'],
];

export function GroupManageSections({ conversation, group, members }: { conversation: Conversation; group: GroupHandle; members: Member[] }) {
  const d = group.details;
  const [adding, setAdding] = useState(false);
  const [copied, setCopied] = useState(false);
  const wa = conversation.network === 'whatsapp';
  if (!d) return null;
  if (!d.member)
    return (
      <section className="panel-section">
        <p className="muted">You're no longer in this group.</p>
      </section>
    );
  const s = d.settings;
  const set = (patch: Partial<GroupSettings>) => void group.act({ action: 'settings', settings: patch }, 'settings');

  return (
    <>
      {d.canAddMembers && (
        <section className="panel-section group-add">
          {adding ? (
            <AddMembers conversation={conversation} group={group} onDone={() => setAdding(false)} />
          ) : (
            <button className="member add-member-btn" onClick={() => setAdding(true)}>
              <span className="round-icon">
                <Icon name="plus" size={22} />
              </span>
              <strong>Add members</strong>
            </button>
          )}
        </section>
      )}

      {d.admin && d.requests.length > 0 && (
        <section className="panel-section join-requests">
          <h4>
            {d.requests.length} {d.requests.length === 1 ? 'person wants' : 'people want'} to join
          </h4>
          <ul className="member-list">
            {d.requests.map((p) => (
              <RequestRow key={p.key} person={p} group={group} />
            ))}
          </ul>
          {d.requests.length > 1 && (
            <div className="setting-actions">
              <button className="btn" disabled={!!group.busy} onClick={() => void group.act({ action: 'approve', members: d.requests.map((p) => p.key) })}>
                Approve all
              </button>
            </div>
          )}
        </section>
      )}

      {d.invited.length > 0 && (
        <section className="panel-section">
          <h4>Invited</h4>
          <p className="muted panel-note">{d.invited.map((p) => p.name).join(', ')}: they haven't accepted yet.</p>
        </section>
      )}

      {(d.inviteLink || (!wa && d.admin)) && (
        <section className="panel-section invite-link">
          <h4>Invite link</h4>
          {d.inviteLink ? (
            <div className="link-row">
              <Icon name="link" size={20} />
              <a href={safeHref(d.inviteLink)} target="_blank" rel="noopener noreferrer" className="link-text">
                {d.inviteLink.replace(/^https?:\/\//, '')}
              </a>
              <button
                className="icon-btn small"
                onClick={() => navigator.clipboard?.writeText(d.inviteLink!).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}
                aria-label="Copy invite link"
                title={copied ? 'Copied' : 'Copy'}
              >
                <Icon name={copied ? 'check' : 'copy'} size={18} />
              </button>
            </div>
          ) : (
            <p className="muted panel-note">Off. Anyone with the link can ask to join, or join straight away.</p>
          )}
          <div className="setting-actions">
            {d.canResetLink && (
              <button
                className="btn"
                disabled={!!group.busy}
                onClick={() => confirm('Reset the link? The old one stops working.') && void group.act({ action: 'link', op: 'reset' })}
              >
                Reset link
              </button>
            )}
            {!wa && d.admin && (
              <button className="btn" disabled={!!group.busy} onClick={() => void group.act({ action: 'link', op: d.linkEnabled ? 'disable' : 'enable' })}>
                {d.linkEnabled ? 'Turn link off' : 'Turn link on'}
              </button>
            )}
          </div>
        </section>
      )}

      {d.admin && s && (
        <section className="panel-section group-settings">
          <h4>Group settings</h4>
          <SettingSelect label="Edit group info" hint="Name, picture and description" value={s.editInfo} onChange={(v) => set({ editInfo: v })} busy={group.busy === 'settings'} />
          <SettingSelect label="Send messages" value={s.sendMessages} onChange={(v) => set({ sendMessages: v })} busy={group.busy === 'settings'} />
          <SettingSelect label="Add members" value={s.addMembers} onChange={(v) => set({ addMembers: v })} busy={group.busy === 'settings'} />
          <label className="setting-row">
            <span className="setting-text">
              <strong>Approve new members</strong>
              <small>{wa ? 'Admins approve everyone who asks to join.' : 'Admins approve people who join through the invite link.'}</small>
            </span>
            <input type="checkbox" role="switch" className="switch" checked={s.approveMembers} disabled={!!group.busy} onChange={(e) => set({ approveMembers: e.target.checked })} />
          </label>
          {!wa && <p className="muted panel-note">Signal's API doesn't report "Edit group info" reliably; what's shown is what was last set here.</p>}
        </section>
      )}

      {d.labelsSupported && <MyLabel group={group} />}

      <section className="panel-section danger-zone">
        <button
          className="member danger"
          disabled={!!group.busy}
          onClick={() =>
            confirm(`Leave “${conversation.title}”?${d.admin && members.length > 1 && !members.some((m) => m.key !== 'self' && m.admin) ? ' You are its only admin: WhatsApp and Signal pick a new one.' : ''}`) &&
            void group.act({ action: 'leave' })
          }
        >
          <span className="round-icon">
            <Icon name="logout" size={20} />
          </span>
          <strong>{group.busy === 'leave' ? 'Leaving…' : 'Leave group'}</strong>
        </button>
      </section>
    </>
  );
}

function SettingSelect({ label, hint, value, onChange, busy }: { label: string; hint?: string; value: Who; onChange: (v: Who) => void; busy: boolean }) {
  return (
    <label className="setting-row">
      <span className="setting-text">
        <strong>{label}</strong>
        {hint && <small>{hint}</small>}
      </span>
      <select value={value} disabled={busy} onChange={(e) => onChange(e.target.value as Who)} aria-label={label}>
        {WHO.map(([v, t]) => (
          <option key={v} value={v}>
            {t}
          </option>
        ))}
      </select>
    </label>
  );
}

function RequestRow({ person, group }: { person: GroupPerson; group: GroupHandle }) {
  return (
    <li className="request-row">
      <span className="member">
        <Avatar name={person.name} seed={String(person.number ?? person.name)} size={40} src={person.avatar} />
        <span className="member-text">
          <strong>{person.name}</strong>
          <small>{person.number ?? ''}</small>
        </span>
      </span>
      <button className="btn small" disabled={!!group.busy} onClick={() => void group.act({ action: 'reject', members: [person.key] })} aria-label={`Reject ${person.name}`}>
        Reject
      </button>
      <button className="btn small primary" disabled={!!group.busy} onClick={() => void group.act({ action: 'approve', members: [person.key] })} aria-label={`Approve ${person.name}`}>
        Approve
      </button>
    </li>
  );
}

function MyLabel({ group }: { group: GroupHandle }) {
  const current = group.details?.myLabel ?? '';
  const [text, setText] = useState(current);
  useEffect(() => setText(current), [current]);
  const changed = text.trim() !== current;
  return (
    <section className="panel-section my-label">
      <h4>Your member label</h4>
      <form
        className="label-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (changed) void group.act({ action: 'label', label: text.trim() || null }, 'label');
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={30} placeholder="e.g. Organiser, Mum, Treasurer" aria-label="Your member label" />
        <button className="btn" disabled={!changed || !!group.busy || (text.trim().length === 1)}>
          {group.busy === 'label' ? 'Saving…' : text.trim() || !current ? 'Save' : 'Remove'}
        </button>
      </form>
      <p className="muted panel-note">Shown next to your name in this group. 2 to 30 characters.</p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// New group (sidebar view)

export function NewGroup({ onClose, initialNetwork }: { onClose: () => void; initialNetwork?: Network | null }) {
  const signalOn = useStore((s) => s.signal.status !== 'disabled');
  const waOn = useStore((s) => s.whatsapp.status !== 'disabled');
  // From a network's own + button: that network, no switch. From the ⋮ menu: a choice.
  const [network, setNetwork] = useState<Network>(initialNetwork ?? (signalOn ? 'signal' : 'whatsapp'));
  const fixed = !!initialNetwork;
  const netName = network === 'signal' ? 'Signal' : 'WhatsApp';
  const [step, setStep] = useState<'people' | 'details'>('people');
  const [chosen, setChosen] = useState<Candidate[]>([]);
  const [name, setName] = useState('');
  const [picture, setPicture] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const photo = useRef<HTMLInputElement>(null);
  const max = network === 'whatsapp' ? 100 : 32;

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const c = await api.createGroup({ network, name: name.trim(), members: chosen.map((x) => x.id), ...(picture ? { avatar: picture } : {}) });
      upsertConversation(c);
      setState({ activeId: c.id });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="sidebar new-group">
      <header className="side-head">
        <button className="icon-btn" onClick={() => (step === 'details' ? setStep('people') : onClose())} aria-label="Back">
          <Icon name="back" />
        </button>
        <h2>{step === 'people' ? (fixed ? `Add ${netName} group members` : 'Add group members') : fixed ? `New ${netName} group` : 'New group'}</h2>
      </header>
      {step === 'people' ? (
        <>
          {signalOn && waOn && !fixed && (
            <div className="network-switch" role="radiogroup" aria-label="Network">
              {(['signal', 'whatsapp'] as const).map((n) => (
                <button key={n} role="radio" aria-checked={network === n} className={network === n ? 'on' : undefined} onClick={() => (setNetwork(n), setChosen([]))}>
                  {n === 'signal' ? 'Signal group' : 'WhatsApp group'}
                </button>
              ))}
            </div>
          )}
          <PeoplePicker network={network} chosen={chosen} onChange={setChosen} />
          <div className="sticky-actions">
            <button className="btn primary" disabled={!chosen.length} onClick={() => setStep('details')}>
              Next{chosen.length ? ` (${chosen.length})` : ''}
            </button>
          </div>
        </>
      ) : (
        <form className="settings-body new-group-details" onSubmit={create}>
          <section className="settings-section new-group-form">
            <button type="button" className="profile-photo" onClick={() => photo.current?.click()} aria-label="Add group picture" title="Add group picture">
              {picture ? <img src={`data:image/jpeg;base64,${picture}`} alt="" /> : <Avatar name={name || '?'} seed={name || 'new'} group size={96} />}
              <span className="photo-overlay">
                <Icon name="camera" size={24} />
              </span>
            </button>
            <input
              ref={photo}
              type="file"
              accept="image/*"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) setPicture(await squareAvatar(f));
              }}
            />
            <input className="group-name-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={max} placeholder="Group name" aria-label="Group name" autoFocus />
            <small className="muted">
              {network === 'whatsapp' ? 'WhatsApp' : 'Signal'} group with {chosen.length} {chosen.length === 1 ? 'person' : 'people'}: {chosen.map((c) => c.name).join(', ')}
            </small>
            {error && <p className="form-error">{error}</p>}
            <button className="btn primary" disabled={busy || !name.trim()}>
              {busy ? 'Creating…' : 'Create group'}
            </button>
          </section>
        </form>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Join a WhatsApp group with a link (in "New chat")

export function JoinByLink({ onJoined }: { onJoined: () => void }) {
  const [link, setLink] = useState('');
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.joinInfo>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const valid = /chat\.whatsapp\.com\/\S{10,}/i.test(link);

  useEffect(() => {
    setPreview(null);
    setError(null);
    if (!valid) return;
    const t = setTimeout(() => api.joinInfo(link.trim()).then(setPreview, (e) => setError(e.message)), 300);
    return () => clearTimeout(t);
  }, [link, valid]);

  async function join() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.joinGroup(link.trim());
      if (r.conversation) {
        upsertConversation(r.conversation);
        setState({ activeId: r.conversation.id });
        onJoined();
      } else setNote('Request sent. The group appears here once an admin lets you in.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="join-link">
      <div className="search">
        <Icon name="link" size={18} />
        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://chat.whatsapp.com/…" aria-label="WhatsApp group link" autoFocus />
      </div>
      {error && <p className="form-error pad">{error}</p>}
      {note && <p className="muted pad">{note}</p>}
      {preview && !note && (
        <div className="join-preview">
          <Avatar name={preview.name} seed={preview.name} group size={48} />
          <span className="member-text">
            <strong>{preview.name}</strong>
            <small>{[preview.size ? `${preview.size} members` : null, preview.approval ? 'an admin approves new members' : null].filter(Boolean).join(' · ')}</small>
          </span>
          <button className="btn primary" disabled={busy || preview.already} onClick={() => void join()}>
            {preview.already ? "You're in it" : busy ? 'Joining…' : preview.approval ? 'Ask to join' : 'Join group'}
          </button>
        </div>
      )}
    </div>
  );
}
