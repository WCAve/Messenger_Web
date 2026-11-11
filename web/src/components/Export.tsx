/**
 * The Export window: pick chats (one is preselected from chat info; ⋮ → Export chats starts with none),
 * formats, photos and files, an optional date range; then it runs (exporter.ts) with progress and saves
 * one ZIP to the browser's downloads.
 */
import { useMemo, useRef, useState } from 'react';
import { setState, useStore } from '../store';
import { EXPORT_FORMATS, type ExportFormat, type ExportProgress, exportChats, exportFileName } from '../exporter';
import { formatSize } from '../util';
import { Dialog } from './Extras';
import { Avatar, Icon } from './ui';

export function ExportDialog() {
  const open = useStore((s) => s.exportDialog);
  if (!open) return null;
  return <ExportWindow preselect={open.preselect} />;
}

function ExportWindow({ preselect }: { preselect: number[] }) {
  const conversations = useStore((s) => s.conversations);
  const both = useStore((s) => s.signal.status !== 'disabled' && s.whatsapp.status !== 'disabled');
  const all = useMemo(() => Object.values(conversations).sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0)), [conversations]);
  const [selected, setSelected] = useState<Set<number>>(() => new Set(preselect));
  const [q, setQ] = useState('');
  const [formats, setFormats] = useState<Set<ExportFormat>>(() => new Set(EXPORT_FORMATS.map((f) => f.id)));
  const [media, setMedia] = useState(true);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const single = preselect.length === 1 && all.find((c) => c.id === preselect[0]);

  const shown = q.trim() ? all.filter((c) => c.title.toLowerCase().includes(q.trim().toLowerCase())) : all;
  const toggle = <T,>(set: Set<T>, v: T) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    return next;
  };
  const close = () => {
    abort.current?.abort();
    setState({ exportDialog: null });
  };

  const run = async () => {
    const chats = all.filter((c) => selected.has(c.id));
    if (!chats.length || !formats.size) return;
    setError(null);
    setDone(null);
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const blob = await exportChats(
        chats,
        {
          formats: EXPORT_FORMATS.map((f) => f.id).filter((f) => formats.has(f)),
          media,
          from: from ? new Date(`${from}T00:00`).getTime() : undefined,
          to: to ? new Date(`${to}T00:00`).getTime() + 24 * 3600_000 : undefined,
        },
        setProgress,
        ctl.signal,
      );
      const name = exportFileName();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      setDone(`Saved “${name}” (${formatSize(blob.size)}) to your downloads.`);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    } finally {
      abort.current = null;
      setProgress(null);
    }
  };

  const running = !!progress;
  return (
    <Dialog title={single ? `Export ${single.title}` : 'Export chats'} onClose={close}>
      <div className="dialog-body export">
        {!single && (
          <section>
            <div className="export-pick-head">
              <strong>Chats</strong>
              <span className="muted">{selected.size} selected</span>
              <button className="link-btn" onClick={() => setSelected(new Set([...selected, ...shown.map((c) => c.id)]))} disabled={running}>
                Select {q.trim() ? 'these' : 'all'}
              </button>
              <button className="link-btn" onClick={() => setSelected(new Set())} disabled={running || !selected.size}>
                None
              </button>
            </div>
            <div className="search">
              <Icon name="search" size={18} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a chat" aria-label="Find a chat" disabled={running} />
            </div>
            <ul className="export-chats" role="listbox" aria-multiselectable="true" aria-label="Chats to export">
              {shown.map((c) => (
                <li key={c.id}>
                  <label className="export-chat">
                    <input type="checkbox" checked={selected.has(c.id)} onChange={() => setSelected(toggle(selected, c.id))} disabled={running} />
                    <Avatar name={c.title} seed={String(c.number ?? c.title)} group={c.kind === 'group'} src={c.avatar} size={32} network={both ? c.network : undefined} />
                    <span className="export-chat-title">{c.title}</span>
                    {c.archived && <span className="muted export-chat-note">archived</span>}
                  </label>
                </li>
              ))}
              {!shown.length && <li className="muted panel-empty">No chats found.</li>}
            </ul>
          </section>
        )}

        <section>
          <strong>Formats</strong>
          {EXPORT_FORMATS.map((f) => (
            <label key={f.id} className="export-option">
              <input type="checkbox" checked={formats.has(f.id)} onChange={() => setFormats(toggle(formats, f.id))} disabled={running} />
              <span>
                {f.label}
                <small className="muted">{f.hint}</small>
              </span>
            </label>
          ))}
        </section>

        <section>
          <label className="export-option">
            <input type="checkbox" checked={media} onChange={(e) => setMedia(e.target.checked)} disabled={running} />
            <span>
              Photos and files
              <small className="muted">Full files in a media folder; small photos built into the web page, the full one when clicked.</small>
            </span>
          </label>
        </section>

        <section className="export-dates">
          <strong>Period</strong>
          <span className="muted">(optional)</span>
          <label>
            From <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} disabled={running} aria-label="From" />
          </label>
          <label>
            to <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} disabled={running} aria-label="To" />
          </label>
        </section>

        <p className="muted setting-note">Deleted messages show as “This message was deleted” and edited ones as “edited”; what they said before isn’t exported.</p>

        {progress && (
          <p className="export-progress" role="status">
            <span className="spinner" aria-hidden="true" />
            {progress.chats > 1 ? `Chat ${progress.chat} of ${progress.chats}: ` : ''}
            {progress.title}, {progress.messages} message{progress.messages === 1 ? '' : 's'}
            {media ? `, ${progress.files} file${progress.files === 1 ? '' : 's'}` : ''}
            {progress.step === 'writing' ? ' – writing…' : '…'}
          </p>
        )}
        {done && (
          <p className="export-done" role="status">
            {done}
          </p>
        )}
        {error && <p className="form-error">{error}</p>}

        <div className="dialog-actions">
          <button className="btn" onClick={close}>
            {running ? 'Cancel' : done ? 'Close' : 'Cancel'}
          </button>
          <button className="btn primary" onClick={() => void run()} disabled={running || !selected.size || !formats.size}>
            <Icon name="download" size={18} /> Export{selected.size > 1 ? ` ${selected.size} chats` : ''}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
