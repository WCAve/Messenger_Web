/**
 * The "What's new" window: after an update it shows what changed since this browser last looked
 * (entries from changelog.ts), and from ⋮ → What's new it shows everything. `whatsNew` in the store
 * opens it: 'unseen' or 'all'.
 */
import { useEffect, useState } from 'react';
import { CHANGELOG, type ChangelogEntry, markChangesSeen, unseenChanges } from '../changelog';
import { setState, useStore } from '../store';
import { Dialog } from './Extras';

/** Once at start-up: open the window when this browser hasn't seen the newest changes. */
export function useWhatsNewAfterUpdate() {
  useEffect(() => {
    if (unseenChanges().length) setState({ whatsNew: 'unseen' });
  }, []);
}

export function WhatsNew() {
  const mode = useStore((s) => s.whatsNew);
  const [entries, setEntries] = useState<ChangelogEntry[]>([]);
  useEffect(() => {
    if (mode) setEntries(mode === 'all' ? CHANGELOG : unseenChanges());
  }, [mode]);
  if (!mode || !entries.length) return null;
  const close = () => {
    markChangesSeen();
    setState({ whatsNew: null });
  };
  return (
    <Dialog title="What’s new" onClose={close}>
      <div className="dialog-body whats-new">
        {entries.map((e) => (
          <section key={e.id}>
            <h3>{e.date}</h3>
            <ul>
              {e.items.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          </section>
        ))}
        <div className="dialog-actions">
          {mode === 'unseen' && (
            <button className="link-btn muted" onClick={() => setState({ whatsNew: 'all' })}>
              Earlier changes
            </button>
          )}
          <button className="btn primary" onClick={close} autoFocus>
            Got it
          </button>
        </div>
      </div>
    </Dialog>
  );
}
