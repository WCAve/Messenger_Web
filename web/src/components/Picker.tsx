/**
 * The emoji / sticker / GIF picker under the composer. Stickers: one grid for every chat (Signal's
 * layout): recent, Signal packs, your own packs (sticker manager), WhatsApp stickers not in a pack, and
 * on WhatsApp "send an image as a sticker". How a sticker is sent depends on the chat (server). GIFs
 * come from Giphy when GIPHY_API_KEY is set.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { CATEGORIES, displayCode, recentEmoji, rememberEmoji, searchEmoji } from '../emoji';
import { Emojified } from '../emoji/render';
import { frequentEmoji, loadUsage } from '../emoji/usage';
import { setState } from '../store';
import type { LocalStickers, StickerItem, StickerPack } from '../types';
import { Icon } from './ui';

export interface PickedGif {
  url: string; // animated GIF to send
  title: string;
}

/** A Signal pack sticker, or one of your own (sticker manager / WhatsApp). */
export type PickedSticker = { packId: string; stickerId: number } | { localId: string };

export type PickerTab = 'emoji' | 'gif' | 'sticker';

/** The panel above the composer: emoji grid and GIF search, like WhatsApp's. */
export function Picker({
  tab,
  onTab,
  onEmoji,
  onGif,
  onSticker,
  onClose,
  title,
  allowGif = true,
  allowStickers = true,
  stickerNetwork = 'signal',
  onStickerImage,
}: {
  tab: PickerTab;
  onTab: (t: PickerTab) => void;
  onEmoji: (e: string) => void;
  onGif: (g: PickedGif) => void;
  onSticker: (s: PickedSticker) => void;
  onClose: () => void;
  title?: string;
  allowGif?: boolean; // false = emoji only (choosing a reaction)
  allowStickers?: boolean;
  /** Which network the chat is on (how a sticker gets sent), and "image as sticker" for WhatsApp. */
  stickerNetwork?: 'signal' | 'whatsapp';
  onStickerImage?: (file: File) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="picker-panel" role="dialog" aria-label={title ?? 'Emoji and GIFs'}>
      <div className="picker-tabs">
        {title && <span className="picker-title">{title}</span>}
        {allowGif && (
          <button className={tab === 'emoji' ? 'on' : undefined} onClick={() => onTab('emoji')}>
            Emoji
          </button>
        )}
        {allowGif && (
          <button className={tab === 'gif' ? 'on' : undefined} onClick={() => onTab('gif')}>
            GIF
          </button>
        )}
        {allowGif && allowStickers && (
          <button className={tab === 'sticker' ? 'on' : undefined} onClick={() => onTab('sticker')}>
            Stickers
          </button>
        )}
        <button className="icon-btn sm picker-close" onClick={onClose} aria-label="Close">
          <Icon name="close" size={18} />
        </button>
      </div>
      {tab === 'emoji' || !allowGif || (tab === 'sticker' && !allowStickers) ? (
        <EmojiGrid
          onPick={(e) => {
            rememberEmoji(e);
            onEmoji(e);
          }}
        />
      ) : tab === 'gif' ? (
        <GifGrid onPick={onGif} />
      ) : (
        <StickerGrid onPick={onSticker} network={stickerNetwork} onImage={onStickerImage} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

const RECENT_STICKERS = 'sw-recent-stickers';
type Recent = PickedSticker & { url: string };
function recentStickers(): Recent[] {
  try {
    return (JSON.parse(localStorage.getItem(RECENT_STICKERS) ?? '[]') as Recent[]).filter((s) => s && s.url);
  } catch {
    return [];
  }
}
function rememberSticker(s: Recent) {
  try {
    const same = (x: Recent) => ('localId' in x && 'localId' in s ? x.localId === s.localId : 'packId' in x && 'packId' in s && x.packId === s.packId && x.stickerId === s.stickerId);
    const list = [s, ...recentStickers().filter((x) => !same(x))].slice(0, 24);
    localStorage.setItem(RECENT_STICKERS, JSON.stringify(list));
  } catch {
    /* private mode */
  }
}

let packsCache: StickerPack[] | null = null;
let localCache: LocalStickers | null = null;

/**
 * One sticker picker for every chat: Signal's packs, your own packs from the sticker manager, and
 * WhatsApp stickers not in a pack yet. How it's sent depends on the chat (see the Composer).
 */
function StickerGrid({
  onPick,
  network,
  onImage,
}: {
  onPick: (s: PickedSticker) => void;
  network: 'signal' | 'whatsapp';
  onImage?: (file: File) => void;
}) {
  const [packs, setPacks] = useState<StickerPack[] | null>(packsCache);
  const [local, setLocal] = useState<LocalStickers | null>(localCache);
  const [active, setActive] = useState<string>('recent');
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState('');
  const [adding, setAdding] = useState(false);
  const recent = useMemo(() => recentStickers(), []);
  const imageInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .stickers()
      .then((r) => {
        packsCache = r.packs;
        localCache = r.local;
        setPacks(r.packs);
        setLocal(r.local);
        setActive((a) => (a === 'recent' && !recent.length ? (r.packs[0]?.packId ?? (r.local.packs[0] ? r.local.packs[0].id : r.local.unsorted.length ? 'unsorted' : 'add')) : a));
      })
      .catch((e) => setError(e.message));
  }, [recent.length]);

  async function addPack() {
    setAdding(true);
    setError(null);
    try {
      const r = await api.addStickerPack(link.trim());
      packsCache = r.packs;
      setPacks(r.packs);
      const added = /pack_id=([0-9a-f]{32})/i.exec(link)?.[1]?.toLowerCase();
      if (added) setActive(added);
      setLink('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAdding(false);
    }
  }

  const pickSignal = (packId: string, s: StickerItem) => {
    rememberSticker({ packId, stickerId: s.id, url: s.url });
    onPick({ packId, stickerId: s.id });
  };
  const pickLocal = (s: { id: string; url: string }) => {
    rememberSticker({ localId: s.id, url: s.url });
    onPick({ localId: s.id });
  };

  const signalPack = packs?.find((p) => p.packId === active);
  const localPack = local?.packs.find((p) => p.id === active);
  const loaded = !!packs && !!local;
  // Your own packs can't be sent as Signal stickers (Signal's API can't upload packs): they go as a picture.
  const asPicture = network === 'signal' && (!!localPack || active === 'unsorted');

  return (
    <>
      <nav className="sticker-packs" aria-label="Sticker packs">
        {recent.length > 0 && (
          <button className={active === 'recent' ? 'on' : undefined} onClick={() => setActive('recent')} title="Recent">
            🕘
          </button>
        )}
        {packs?.map((p) => (
          <button key={p.packId} className={active === p.packId ? 'on' : undefined} onClick={() => setActive(p.packId)} title={p.title}>
            <img src={p.cover.url} alt={p.title} loading="lazy" />
          </button>
        ))}
        {local?.packs.map((p) => (
          <button key={p.id} className={active === p.id ? 'on' : undefined} onClick={() => setActive(p.id)} title={p.title}>
            {p.cover ? <img src={p.cover.url} alt={p.title} loading="lazy" /> : <Icon name="sticker" size={20} />}
          </button>
        ))}
        {!!local?.unsorted.length && (
          <button className={active === 'unsorted' ? 'on' : undefined} onClick={() => setActive('unsorted')} title="WhatsApp stickers not in a pack">
            <img src={local.unsorted[0].url} alt="Not in a pack" loading="lazy" />
          </button>
        )}
        {network === 'whatsapp' && onImage && (
          <>
            <button onClick={() => imageInput.current?.click()} title="Send an image as a sticker" aria-label="Send an image as a sticker">
              <Icon name="image" size={20} />
            </button>
            <input ref={imageInput} type="file" accept="image/*" hidden onChange={(e) => (e.target.files?.[0] && onImage(e.target.files[0]), (e.target.value = ''))} />
          </>
        )}
        <button className={active === 'add' ? 'on' : undefined} onClick={() => setActive('add')} title="Add a Signal sticker pack" aria-label="Add a sticker pack">
          <Icon name="plus" size={20} />
        </button>
        <button onClick={() => setState({ stickerManager: true })} title="Sticker manager" aria-label="Sticker manager">
          <Icon name="gear" size={20} />
        </button>
      </nav>
      <div className="picker-body">
        {error && <p className="form-error picker-empty">{error}</p>}
        {!loaded && !error && <div className="spinner picker-spinner" aria-label="Loading" />}
        {active === 'recent' && recent.length > 0 && (
          <div className="sticker-grid">
            {recent.map((s) => (
              <button key={'localId' in s ? s.localId : `${s.packId}:${s.stickerId}`} className="sticker-cell" onClick={() => ('localId' in s ? pickLocal({ id: s.localId, url: s.url }) : onPick(s))}>
                <img src={s.url} alt="Sticker" loading="lazy" />
              </button>
            ))}
          </div>
        )}
        {signalPack && (
          <>
            <h4>
              {signalPack.title}
              {signalPack.author && <span className="muted"> · {signalPack.author}</span>}
            </h4>
            <div className="sticker-grid">
              {signalPack.stickers.map((s) => (
                <button key={s.id} className="sticker-cell" onClick={() => pickSignal(signalPack.packId, s)} title={s.emoji ?? 'Sticker'}>
                  <img src={s.url} alt={s.emoji ?? 'Sticker'} loading="lazy" />
                </button>
              ))}
            </div>
          </>
        )}
        {(localPack || active === 'unsorted') && local && (
          <>
            <h4>
              {localPack ? localPack.title : 'WhatsApp stickers not in a pack'}
              {asPicture && <span className="muted"> · sent as a picture in Signal chats</span>}
            </h4>
            <div className="sticker-grid">
              {(localPack ? localPack.stickers : local.unsorted).map((s) => (
                <button key={s.id} className="sticker-cell" onClick={() => pickLocal(s)} title="Sticker">
                  <img src={s.url} alt="Sticker" loading="lazy" />
                </button>
              ))}
            </div>
          </>
        )}
        {loaded && (active === 'add' || (!packs!.length && !local!.packs.length && !local!.unsorted.length && !recent.length)) && (
          <form
            className="sticker-add"
            onSubmit={(e) => {
              e.preventDefault();
              if (link.trim()) void addPack();
            }}
          >
            {!packs!.length && !local!.packs.length && (
              <p>No stickers yet. Signal packs you install on your phone appear here automatically, and WhatsApp stickers can be put in packs in the sticker manager.</p>
            )}
            <p>
              Add a Signal pack from{' '}
              <a href="https://signalstickers.org/" target="_blank" rel="noopener noreferrer">
                signalstickers.org
              </a>
              : open a pack, copy the “Add to Signal” link, and paste it here.
            </p>
            <div className="picker-search">
              <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://signal.art/addstickers/#pack_id=…" aria-label="Sticker pack link" />
            </div>
            <button className="btn primary" disabled={adding || !link.trim()}>
              {adding ? 'Adding…' : 'Add pack'}
            </button>
          </form>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function EmojiGrid({ onPick }: { onPick: (e: string) => void }) {
  const [q, setQ] = useState('');
  const body = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // Most used across all your browsers (from the server); this browser's recent picks until there's history.
  const [frequent, setFrequent] = useState<string[]>(() => frequentEmoji());
  const recent = useMemo(() => (frequent.length ? frequent : recentEmoji()), [frequent]);
  const results = useMemo(() => (q.trim() ? searchEmoji(q.trim(), 120).map((r) => r.entry) : null), [q]);

  useEffect(() => {
    input.current?.focus();
    loadUsage(true).then(() => setFrequent(frequentEmoji()));
  }, []);

  const cell = (e: string) => (
    <button key={e} className="emoji-cell" onClick={() => onPick(e)} title={`:${displayCode(e) ?? ''}:`}>
      <Emojified text={e} />
    </button>
  );

  return (
    <>
      <div className="picker-search">
        <Icon name="search" size={18} />
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search emoji" aria-label="Search emoji" />
      </div>
      {!results && (
        <nav className="emoji-cats" aria-label="Emoji categories">
          {recent.length > 0 && (
            <button onClick={() => body.current?.querySelector('#cat-recent')?.scrollIntoView()} title={frequent.length ? 'Frequently used' : 'Recent'}>
              🕘
            </button>
          )}
          {CATEGORIES.map((c) => (
            <button key={c.name} title={c.name} onClick={() => body.current?.querySelector(`#cat-${CSS.escape(c.name)}`)?.scrollIntoView()}>
              {c.icon}
            </button>
          ))}
        </nav>
      )}
      <div className="picker-body" ref={body}>
        {results ? (
          results.length ? (
            <div className="emoji-grid">{results.map((x) => cell(x.e))}</div>
          ) : (
            <p className="picker-empty">No emoji match “{q}”.</p>
          )
        ) : (
          <>
            {recent.length > 0 && (
              <section id="cat-recent">
                <h4>{frequent.length ? 'Frequently used' : 'Recent'}</h4>
                <div className="emoji-grid">{recent.map(cell)}</div>
              </section>
            )}
            {CATEGORIES.map((c) => (
              <section key={c.name} id={`cat-${c.name}`}>
                <h4>{c.name}</h4>
                <div className="emoji-grid">{c.items.map((x) => cell(x.e))}</div>
              </section>
            ))}
          </>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

interface GiphyImage {
  url?: string;
  webp?: string;
  width?: string;
  height?: string;
  size?: string;
}
interface GiphyGif {
  id: string;
  title: string;
  images: Record<string, GiphyImage | undefined>;
}

let configPromise: Promise<{ giphyApiKey: string | null; giphyRating: string }> | null = null;

function GifGrid({ onPick }: { onPick: (g: PickedGif) => void }) {
  const [cfg, setCfg] = useState<{ giphyApiKey: string | null; giphyRating: string } | null>(null);
  const [q, setQ] = useState('');
  const [gifs, setGifs] = useState<GiphyGif[]>([]);
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const reqId = useRef(0);

  useEffect(() => {
    configPromise ??= api.config();
    configPromise.then(setCfg).catch((e) => {
      configPromise = null;
      setError(e.message);
    });
  }, []);

  async function load(query: string, from: number) {
    if (!cfg?.giphyApiKey) return;
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      api_key: cfg.giphyApiKey,
      limit: '24',
      offset: String(from),
      rating: cfg.giphyRating,
    });
    if (query) {
      params.set('q', query.slice(0, 50));
      params.set('lang', (navigator.language || 'en').slice(0, 2));
    }
    try {
      const res = await fetch(`https://api.giphy.com/v1/gifs/${query ? 'search' : 'trending'}?${params}`, { referrerPolicy: 'no-referrer' });
      const body = await res.json();
      if (id !== reqId.current) return;
      if (!res.ok) throw new Error(body?.meta?.msg ? `Giphy: ${body.meta.msg}` : `Giphy request failed (${res.status})`);
      const list: GiphyGif[] = body.data ?? [];
      setGifs((prev) => (from ? [...prev, ...list] : list));
      setOffset(from + list.length);
      setMore(list.length === 24);
    } catch (e) {
      if (id === reqId.current) setError((e as Error).message === 'Failed to fetch' ? "Can't reach Giphy from this browser." : (e as Error).message);
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }

  // Search as you type (debounced); trending when the box is empty.
  useEffect(() => {
    if (!cfg?.giphyApiKey) return;
    input.current?.focus();
    const t = setTimeout(() => load(q.trim(), 0), q ? 350 : 0);
    return () => clearTimeout(t);
  }, [q, cfg]); // eslint-disable-line react-hooks/exhaustive-deps

  if (cfg && !cfg.giphyApiKey) {
    return (
      <div className="picker-body gif-setup">
        <p>
          <strong>GIF search needs a free Giphy API key.</strong>
        </p>
        <ol>
          <li>
            Create an app at{' '}
            <a href="https://developers.giphy.com/dashboard/" target="_blank" rel="noopener noreferrer">
              developers.giphy.com
            </a>{' '}
            and choose <em>API</em>.
          </li>
          <li>
            Copy the key into the <strong>Giphy API key</strong> setting (<code>GIPHY_API_KEY</code>) of the signal-web container, and apply.
          </li>
        </ol>
      </div>
    );
  }

  return (
    <>
      <div className="picker-search">
        <Icon name="search" size={18} />
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Giphy" aria-label="Search GIFs" />
      </div>
      <div
        className="picker-body"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (more && !loading && el.scrollHeight - el.scrollTop - el.clientHeight < 200) void load(q.trim(), offset);
        }}
      >
        {error && <p className="form-error picker-empty">{error}</p>}
        {!error && !loading && !gifs.length && cfg && <p className="picker-empty">No GIFs found.</p>}
        <div className="gif-grid">
          {gifs.map((g) => {
            const preview = g.images.fixed_width ?? g.images.fixed_width_small ?? g.images.original;
            const send = g.images.downsized ?? g.images.downsized_medium ?? g.images.original;
            if (!preview || !send?.url) return null;
            return (
              <button key={g.id} className="gif-cell" onClick={() => onPick({ url: send.url!, title: g.title })} title={g.title || 'GIF'}>
                <img
                  src={preview.webp || preview.url}
                  alt={g.title || 'GIF'}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  style={{ aspectRatio: `${preview.width ?? 1} / ${preview.height ?? 1}` }}
                />
              </button>
            );
          })}
        </div>
        {loading && <div className="spinner picker-spinner" aria-label="Loading" />}
        <p className="giphy-credit">Powered by GIPHY</p>
      </div>
    </>
  );
}
