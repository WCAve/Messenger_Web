/**
 * Sticker manager: Signal's packs as they are, and your own packs made from WhatsApp stickers
 * (received, imported from the backup folder, or your own images). Every chat's sticker picker shows
 * both; how a sticker is sent depends on the chat.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { setState } from '../store';
import type { LocalStickers, StickerPack } from '../types';
import { fileToBase64 } from '../util';
import { Icon } from './ui';

export function StickerManager() {
  const [signal, setSignal] = useState<StickerPack[] | null>(null);
  const [local, setLocal] = useState<LocalStickers | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [link, setLink] = useState('');
  const images = useRef<HTMLInputElement>(null);
  const imagesFor = useRef<string | undefined>(undefined);

  useEffect(() => {
    api.stickers().then(
      (r) => {
        setSignal(r.packs);
        setLocal(r.local);
      },
      (e) => setError(e.message),
    );
  }, []);

  async function run(fn: () => Promise<LocalStickers | void>, done?: string) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await fn();
      if (r) setLocal(r);
      if (done) setNote(done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const picked = [...selected];

  async function addImages(files: FileList | null) {
    if (!files?.length) return;
    const list = await Promise.all([...files].map(async (f) => `data:${f.type};base64,${await fileToBase64(f)}`));
    await run(() => api.addStickerImages(list, imagesFor.current), `${list.length} image${list.length === 1 ? '' : 's'} added`);
  }

  return (
    <aside className="sidebar settings sticker-manager">
      <header className="side-head">
        <button className="icon-btn" onClick={() => setState({ stickerManager: false })} aria-label="Back to chats">
          <Icon name="back" />
        </button>
        <h2>Sticker manager</h2>
      </header>
      <div className="settings-body">
        {error && <p className="form-error pad">{error}</p>}
        {note && <p className="muted pad">{note}</p>}
        <input ref={images} type="file" accept="image/webp,image/png,image/jpeg,image/gif" multiple hidden onChange={(e) => (void addImages(e.target.files), (e.target.value = ''))} />

        <section className="settings-section">
          <h3>Your packs</h3>
          <p className="setting-note muted">
            In WhatsApp chats these are sent as WhatsApp stickers. In Signal chats they're sent as a picture: Signal can't take new packs from here.
          </p>
          {local && !local.packs.length && <p className="setting-note">No packs yet. Select stickers below and make one.</p>}
          {local?.packs.map((p) => (
            <div key={p.id} className="stk-pack">
              <button className="stk-pack-head" onClick={() => setOpen((o) => (o === p.id ? null : p.id))} aria-expanded={open === p.id}>
                {p.cover ? <img src={p.cover.url} alt="" /> : <Icon name="sticker" size={28} />}
                <span>
                  <strong>{p.title}</strong>
                  <small>
                    {p.stickers.length} sticker{p.stickers.length === 1 ? '' : 's'}
                  </small>
                </span>
                <Icon name={open === p.id ? 'up' : 'down'} size={18} />
              </button>
              {open === p.id && (
                <div className="stk-pack-body">
                  <div className="sticker-grid">
                    {p.stickers.map((s) => (
                      <div key={s.id} className="sticker-cell stk-cell">
                        <img src={s.url} alt="Sticker" loading="lazy" />
                        <button className="stk-remove" title="Take out of this pack" aria-label="Take out of this pack" onClick={() => void run(() => api.updateStickerPack(p.id, { remove: [s.id] }))}>
                          <Icon name="close" size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="setting-actions">
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() => {
                        const t = prompt('Pack name', p.title);
                        if (t && t.trim() && t !== p.title) void run(() => api.updateStickerPack(p.id, { title: t.trim() }));
                      }}
                    >
                      Rename
                    </button>
                    <button className="btn" disabled={busy} onClick={() => ((imagesFor.current = p.id), images.current?.click())}>
                      Add images
                    </button>
                    <button
                      className="btn danger"
                      disabled={busy}
                      onClick={() => confirm(`Delete the pack “${p.title}”? Its stickers go back to “Not in a pack”.`) && void run(() => api.deleteStickerPack(p.id))}
                    >
                      Delete pack
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </section>

        <section className="settings-section">
          <h3>Not in a pack{local ? ` (${local.unsorted.length})` : ''}</h3>
          <p className="setting-note muted">WhatsApp stickers you've received or sent, imported ones, and images you add. Click to select.</p>
          <div className="setting-actions">
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const r = await api.importWaStickers();
                  const fresh = await api.stickers();
                  setSignal(fresh.packs);
                  setNote(`${r.found.toLocaleString()} stickers found in the backup folder, ${r.added.toLocaleString()} new.`);
                  return fresh.local;
                })
              }
            >
              Import from the backup folder
            </button>
            <button className="btn" disabled={busy} onClick={() => ((imagesFor.current = undefined), images.current?.click())}>
              Add images…
            </button>
          </div>
          {!!picked.length && (
            <div className="stk-toolbar">
              <span>{picked.length} selected</span>
              {!!local?.packs.length && (
                <>
                  <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Pack to add to">
                    <option value="">Add to pack…</option>
                    {local.packs.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                  <button className="btn" disabled={busy || !target} onClick={() => void run(async () => (setSelected(new Set()), api.updateStickerPack(target, { add: picked })))}>
                    Add
                  </button>
                </>
              )}
              <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="New pack name" aria-label="New pack name" />
              <button
                className="btn primary"
                disabled={busy || !newTitle.trim()}
                onClick={() => void run(async () => (setSelected(new Set()), setNewTitle(''), api.createStickerPack(newTitle.trim(), picked)))}
              >
                New pack
              </button>
              <button
                className="btn danger"
                disabled={busy}
                onClick={() => confirm(`Remove ${picked.length} sticker${picked.length === 1 ? '' : 's'} from the manager?`) && void run(async () => (setSelected(new Set()), api.forgetStickers(picked)))}
              >
                Remove
              </button>
            </div>
          )}
          <div className="sticker-grid stk-unsorted">
            {local?.unsorted.map((s) => (
              <button key={s.id} className={`sticker-cell stk-cell${selected.has(s.id) ? ' on' : ''}`} onClick={() => toggle(s.id)} aria-pressed={selected.has(s.id)}>
                <img src={s.url} alt="Sticker" loading="lazy" />
                {selected.has(s.id) && <span className="stk-check">✓</span>}
              </button>
            ))}
          </div>
          {local && !local.unsorted.length && <p className="setting-note">Nothing here. Stickers you receive on WhatsApp appear here.</p>}
        </section>

        <section className="settings-section">
          <h3>Signal packs</h3>
          <p className="setting-note muted">Installed in Signal. They work in every chat: as Signal stickers, or sent as WhatsApp stickers in WhatsApp chats. Remove them in Signal on your phone.</p>
          {signal?.map((p) => (
            <div key={p.packId} className="stk-pack">
              <div className="stk-pack-head">
                <img src={p.cover.url} alt="" />
                <span>
                  <strong>{p.title}</strong>
                  <small>
                    {[p.author, `${p.stickers.length} stickers`].filter(Boolean).join(' · ')}
                  </small>
                </span>
              </div>
            </div>
          ))}
          {signal && !signal.length && <p className="setting-note">No Signal packs (or Signal isn't set up).</p>}
          <form
            className="stk-link"
            onSubmit={(e) => {
              e.preventDefault();
              if (link.trim())
                void run(async () => {
                  const r = await api.addStickerPack(link.trim());
                  setSignal(r.packs);
                  setLink('');
                }, 'Pack added');
            }}
          >
            <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="Add a pack: https://signal.art/addstickers/#pack_id=…" aria-label="Sticker pack link" />
            <button className="btn" disabled={busy || !link.trim()}>
              Add
            </button>
          </form>
        </section>
      </div>
    </aside>
  );
}
