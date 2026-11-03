import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { CATEGORIES, EMOJI, recentEmoji, rememberEmoji, searchEmoji } from '../emoji';
import { Icon } from './ui';

export interface PickedGif {
  url: string; // animated GIF to send
  title: string;
}

/** The panel above the composer: emoji grid and GIF search, like WhatsApp's. */
export function Picker({
  tab,
  onTab,
  onEmoji,
  onGif,
  onClose,
  title,
  allowGif = true,
}: {
  tab: 'emoji' | 'gif';
  onTab: (t: 'emoji' | 'gif') => void;
  onEmoji: (e: string) => void;
  onGif: (g: PickedGif) => void;
  onClose: () => void;
  title?: string;
  allowGif?: boolean;
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
        <button className="icon-btn sm picker-close" onClick={onClose} aria-label="Close">
          <Icon name="close" size={18} />
        </button>
      </div>
      {tab === 'emoji' || !allowGif ? (
        <EmojiGrid
          onPick={(e) => {
            rememberEmoji(e);
            onEmoji(e);
          }}
        />
      ) : (
        <GifGrid onPick={onGif} />
      )}
    </div>
  );
}

function EmojiGrid({ onPick }: { onPick: (e: string) => void }) {
  const [q, setQ] = useState('');
  const body = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const recent = useMemo(() => recentEmoji(), []);
  const results = useMemo(() => (q.trim() ? searchEmoji(q.trim(), 120).map((r) => r.entry) : null), [q]);
  const nameOf = useMemo(() => new Map(EMOJI.map((x) => [x.e, x.codes[0]])), []);

  useEffect(() => input.current?.focus(), []);

  const cell = (e: string) => (
    <button key={e} className="emoji-cell" onClick={() => onPick(e)} title={`:${nameOf.get(e) ?? ''}:`}>
      {e}
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
            <button onClick={() => body.current?.querySelector('#cat-recent')?.scrollIntoView()} title="Recent">
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
                <h4>Recent</h4>
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
