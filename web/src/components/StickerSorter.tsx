/**
 * The sticker sorting game (server: stickersort.ts), full screen. Two rounds:
 *   Keep or throw away  one sticker at a time: swipe (or drag) right to keep, left to throw away, or the
 *                       buttons / ← → keys; ↓ skips; search words can be added before deciding.
 *   Look-alikes         stickers that look the same: keep the best copy (the others go, their search
 *                       words and uses move to it), or "Not the same".
 * Every decision can be undone (Undo / Ctrl+Z), one step at a time.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { setState } from '../store';
import type { SortCard } from '../types';
import { formatSize } from '../util';
import { Icon } from './ui';

type Done = { kind: 'card'; card: SortCard; keep: boolean } | { kind: 'look'; group: SortCard[]; thrown: string[] };

const SWIPE = 110; // px dragged to decide

export function StickerSorter() {
  const [mode, setMode] = useState<'keep' | 'look'>('keep');
  const [queue, setQueue] = useState<SortCard[] | null>(null);
  const [left, setLeft] = useState(0);
  const [total, setTotal] = useState(0);
  const [groups, setGroups] = useState<SortCard[][] | null>(null);
  const [history, setHistory] = useState<Done[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [word, setWord] = useState('');
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [fly, setFly] = useState<0 | 1 | -1>(0);
  const skipped = useRef<string[]>([]);
  const loading = useRef(false);
  const drag = useRef<{ x: number; id: number } | null>(null);

  const close = () => setState({ stickerSorter: false });
  const fail = (e: unknown) => setError((e as Error).message);

  const loadMore = useCallback(async (have: SortCard[]) => {
    if (loading.current) return;
    loading.current = true;
    try {
      const r = await api.sortNext([...skipped.current, ...have.map((c) => c.id)]);
      setQueue((q) => [...(q ?? []), ...r.cards.filter((c) => !(q ?? []).some((x) => x.id === c.id))]);
      setLeft(r.left);
      setTotal(r.total);
    } catch (e) {
      fail(e);
    } finally {
      loading.current = false;
    }
  }, []);
  useEffect(() => {
    void loadMore([]);
    api.lookAlikes().then((r) => setGroups(r.groups), fail);
  }, [loadMore]);
  useEffect(() => {
    if (queue && queue.length < 5 && left > queue.length + skipped.current.length) void loadMore(queue);
  }, [queue, left, loadMore]);

  const card = queue?.[0];
  // The words of the sticker on top
  useEffect(() => {
    setTags(card?.tags ?? []);
    setWord('');
    setDx(0);
    setFly(0);
  }, [card?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const withWord = () => {
    const extra = word
      .split(',')
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean);
    return [...tags, ...extra.filter((w) => !tags.includes(w))];
  };

  function decide(keep: boolean) {
    if (!card || fly) return;
    const words = withWord();
    setFly(keep ? 1 : -1);
    window.setTimeout(() => {
      setQueue((q) => (q ?? []).slice(1));
      setLeft((n) => Math.max(0, n - 1));
      setHistory((h) => [...h, { kind: 'card', card: { ...card, tags: words }, keep }]);
      api.sortDecide(card.id, keep, keep ? words : undefined).catch(fail);
    }, 180);
  }
  function skip() {
    if (!card) return;
    skipped.current.push(card.id);
    setQueue((q) => (q ?? []).slice(1));
  }
  async function undo() {
    const last = history.at(-1);
    if (!last) return;
    setHistory((h) => h.slice(0, -1));
    try {
      if (last.kind === 'card') {
        await api.sortUndo([last.card.id]);
        setQueue((q) => [last.card, ...(q ?? [])]);
        setLeft((n) => n + 1);
        setMode('keep');
      } else {
        if (last.thrown.length) await api.sortUndo(last.thrown);
        else await api.undoLookAlikesOk(last.group.map((c) => c.id));
        setGroups((g) => [last.group, ...(g ?? [])]);
        setMode('look');
      }
    } catch (e) {
      fail(e);
    }
  }
  async function decideGroup(group: SortCard[], keep: string[]) {
    try {
      const r = await api.decideLookAlikes(
        group.map((c) => c.id),
        keep,
      );
      setGroups((g) => (g ?? []).filter((x) => x !== group));
      setHistory((h) => [...h, { kind: 'look', group, thrown: r.thrown }]);
      // A thrown-away copy may be waiting in the other round
      if (r.thrown.length) setQueue((q) => (q ?? []).filter((c) => !r.thrown.includes(c.id)));
    } catch (e) {
      fail(e);
    }
  }

  // Keys: ← throw away, → keep, ↓ skip, Ctrl+Z undo, Esc close (not while typing a word, except Esc)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.tagName === 'INPUT';
      if (e.key === 'Escape') return close();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) return (e.preventDefault(), void undo());
      if (typing || mode !== 'keep') return;
      if (e.key === 'ArrowRight') decide(true);
      else if (e.key === 'ArrowLeft') decide(false);
      else if (e.key === 'ArrowDown') skip();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const done = total - left;
  const lean = Math.max(-1, Math.min(1, dx / SWIPE));
  const offset = fly ? fly * 700 : dx;

  return (
    <div className="sorter" role="dialog" aria-label="Sort stickers">
      <header className="sorter-head">
        <button className="icon-btn" onClick={close} aria-label="Close">
          <Icon name="close" />
        </button>
        <h2>Sort stickers</h2>
        <nav className="sorter-tabs">
          <button className={mode === 'keep' ? 'on' : undefined} onClick={() => setMode('keep')}>
            Keep or throw away{queue ? ` · ${left.toLocaleString()} left` : ''}
          </button>
          <button className={mode === 'look' ? 'on' : undefined} onClick={() => setMode('look')}>
            Look-alikes{groups ? ` · ${groups.length.toLocaleString()}` : ''}
          </button>
        </nav>
        <button className="btn sorter-undo" onClick={() => void undo()} disabled={!history.length} title="Undo (Ctrl+Z)">
          ↶ Undo
        </button>
      </header>
      {error && <p className="form-error pad">{error}</p>}

      {mode === 'keep' && (
        <div className="sorter-body">
          {!queue && <div className="spinner" aria-label="Loading" />}
          {queue && total > 0 && (
            <div className="sorter-progress" aria-label={`${done} of ${total} sorted`}>
              <span style={{ width: `${(100 * done) / total}%` }} />
              <small>
                {done.toLocaleString()} of {total.toLocaleString()} sorted
              </small>
            </div>
          )}
          {queue && !card && (
            <p className="sorter-empty">{skipped.current.length ? 'Only stickers you skipped are left. Open this again later to see them.' : 'All your stickers are sorted. New ones show up here as they come in.'}</p>
          )}
          {card && (
            <>
              <div className="sorter-stack">
                {queue![1] && (
                  <div className="sorter-card behind" aria-hidden="true">
                    <img src={queue![1].url} alt="" />
                  </div>
                )}
                <div
                  key={card.id}
                  className={`sorter-card${dragging ? ' dragging' : ''}`}
                  style={{ transform: `translateX(${offset}px) rotate(${offset / 18}deg)`, opacity: fly ? 0 : 1 }}
                  onPointerDown={(e) => {
                    if (fly) return;
                    drag.current = { x: e.clientX, id: e.pointerId };
                    e.currentTarget.setPointerCapture(e.pointerId);
                    setDragging(true);
                  }}
                  onPointerMove={(e) => drag.current?.id === e.pointerId && setDx(e.clientX - drag.current.x)}
                  onPointerUp={() => {
                    drag.current = null;
                    setDragging(false);
                    if (Math.abs(dx) >= SWIPE) decide(dx > 0);
                    else setDx(0);
                  }}
                  onPointerCancel={() => ((drag.current = null), setDragging(false), setDx(0))}
                >
                  <img src={card.url} alt="Sticker" draggable={false} />
                  <span className="sorter-stamp keep" style={{ opacity: Math.max(0, lean) }}>
                    Keep
                  </span>
                  <span className="sorter-stamp throw" style={{ opacity: Math.max(0, -lean) }}>
                    Throw away
                  </span>
                  <small className="sorter-meta">
                    {formatSize(card.size)}
                    {card.animated ? ' · animated' : ''}
                  </small>
                </div>
              </div>
              <div className="sorter-words">
                {tags.map((t) => (
                  <span key={t} className="sticker-tag">
                    {t}
                    <button onClick={() => setTags(tags.filter((x) => x !== t))} aria-label={`Remove ${t}`}>
                      ×
                    </button>
                  </span>
                ))}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    setTags(withWord());
                    setWord('');
                  }}
                >
                  <input value={word} onChange={(e) => setWord(e.target.value)} placeholder="Add search words (Enter)" aria-label="Add search words" />
                </form>
              </div>
              <div className="sorter-actions">
                <button className="sorter-btn throw" onClick={() => decide(false)} aria-label="Throw away" title="Throw away (←)">
                  <Icon name="close" size={30} />
                </button>
                <button className="btn" onClick={skip} title="Skip (↓)">
                  Skip
                </button>
                <button className="sorter-btn keep" onClick={() => decide(true)} aria-label="Keep" title="Keep (→)">
                  <Icon name="check" size={30} />
                </button>
              </div>
              <p className="sorter-hint muted">Swipe or drag: right keeps, left throws away · keys ← → · ↓ skip · Ctrl+Z undo. Thrown-away stickers disappear from the picker; they stay in your chats.</p>
            </>
          )}
        </div>
      )}

      {mode === 'look' && (
        <div className="sorter-body">
          {!groups && <div className="spinner" aria-label="Loading" />}
          {groups && !groups.length && <p className="sorter-empty">No look-alikes to check. (They’re found in the background, after the text in stickers is read.)</p>}
          {groups?.[0] && (
            <>
              <h3 className="sorter-question">Are these the same sticker?</h3>
              <div className="sorter-group">
                {groups[0].map((c, i) => (
                  <div key={c.id} className="sorter-twin">
                    <img src={c.url} alt="Sticker" />
                    <small className="muted">
                      {formatSize(c.size)}
                      {c.animated ? ' · animated' : ''}
                      {i === 0 ? ' · best copy' : ''}
                    </small>
                    <button className="btn primary" onClick={() => void decideGroup(groups[0], [c.id])}>
                      Keep only this one
                    </button>
                  </div>
                ))}
              </div>
              <div className="sorter-actions">
                <button
                  className="btn"
                  onClick={() =>
                    void decideGroup(
                      groups[0],
                      groups[0].map((c) => c.id),
                    )
                  }
                >
                  Not the same: keep all
                </button>
                <button className="btn" onClick={() => setGroups((g) => (g ? [...g.slice(1), g[0]] : g))}>
                  Skip
                </button>
              </div>
              <p className="sorter-hint muted">The ones you don’t keep disappear from the picker; their search words and how often you used them move to the one you keep.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
