import { type ReactNode, useEffect, useState } from 'react';
import { type ServerSettings, api } from '../api';
import { type Prefs, setPrefs, usePrefs } from '../prefs';
import { Icon } from './ui';

function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className={`setting-row${disabled ? ' disabled' : ''}`}>
      <span className="setting-text">
        <strong>{label}</strong>
        {hint && <small>{hint}</small>}
      </span>
      <input type="checkbox" role="switch" className="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

const THEMES: { value: Prefs['theme']; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function SettingsView({ onClose, onLogout }: { onClose: () => void; onLogout: () => void }) {
  const prefs = usePrefs();
  const [server, setServer] = useState<ServerSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [permission, setPermission] = useState(() => ('Notification' in window ? Notification.permission : 'unsupported'));

  useEffect(() => {
    api.settings().then(setServer, (e) => setError(e.message));
  }, []);

  async function saveServer(patch: Parameters<typeof api.updateSettings>[0]) {
    setError(null);
    const before = server;
    if (server) setServer({ ...server, ...patch }); // optimistic
    try {
      setServer(await api.updateSettings(patch));
    } catch (e) {
      setServer(before);
      setError((e as Error).message);
    }
  }

  async function enableNotifications(on: boolean) {
    if (on && 'Notification' in window && Notification.permission === 'default') {
      const p = await Notification.requestPermission();
      setPermission(p);
      if (p !== 'granted') return;
    }
    setPrefs({ notifications: on });
  }

  async function refreshDirectory() {
    setNotice(null);
    try {
      const d = await api.refreshDirectory();
      setNotice(`Updated ${d.contacts.length} contacts and ${d.groups.length} groups.`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function logoutAll() {
    if (!confirm('Sign out of Signal Web in every browser, including this one?')) return;
    await api.logoutAll().catch(() => {});
    location.reload();
  }

  const blocked = permission === 'denied';

  return (
    <aside className="sidebar settings">
      <header className="side-head">
        <button className="icon-btn" onClick={onClose} aria-label="Back to chats">
          <Icon name="back" />
        </button>
        <h2>Settings</h2>
      </header>
      <div className="settings-body">
        {error && <p className="form-error pad">{error}</p>}

        <Section title="Appearance">
          <div className="setting-row">
            <span className="setting-text">
              <strong>Theme</strong>
              <small>Applies to this browser.</small>
            </span>
            <div className="segmented" role="radiogroup" aria-label="Theme">
              {THEMES.map((t) => (
                <button key={t.value} role="radio" aria-checked={prefs.theme === t.value} className={prefs.theme === t.value ? 'on' : undefined} onClick={() => setPrefs({ theme: t.value })}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </Section>

        <Section title="Chats">
          <Toggle
            label="Enter sends the message"
            hint={prefs.enterToSend ? 'Shift+Enter starts a new line.' : 'Enter starts a new line; Ctrl+Enter sends.'}
            checked={prefs.enterToSend}
            onChange={(v) => setPrefs({ enterToSend: v })}
          />
        </Section>

        <Section title="Notifications">
          {permission === 'unsupported' ? (
            <p className="muted setting-note">This browser doesn't support notifications.</p>
          ) : (
            <>
              <Toggle
                label="Desktop notifications"
                hint={blocked ? 'Blocked in your browser’s site settings for this page. Allow notifications there first.' : 'For new messages while this tab is in the background.'}
                checked={prefs.notifications && permission === 'granted'}
                disabled={blocked}
                onChange={(v) => void enableNotifications(v)}
              />
              <Toggle
                label="Show message text"
                hint="Off shows only who sent something."
                checked={prefs.notificationPreview}
                disabled={!prefs.notifications || permission !== 'granted'}
                onChange={(v) => setPrefs({ notificationPreview: v })}
              />
            </>
          )}
        </Section>

        <Section title="Privacy">
          <Toggle
            label="Send read receipts"
            hint="Others see when you've read their messages in Signal Web. Applies to every browser."
            checked={!!server?.sendReadReceipts}
            disabled={!server}
            onChange={(v) => void saveServer({ sendReadReceipts: v })}
          />
          <Toggle
            label="Send typing indicators"
            hint="Others see when you're typing. Applies to every browser."
            checked={!!server?.sendTypingIndicators}
            disabled={!server}
            onChange={(v) => void saveServer({ sendTypingIndicators: v })}
          />
        </Section>

        <Section title="Account">
          <dl className="setting-facts">
            <dt>Signal number</dt>
            <dd>{server?.account ?? '…'}</dd>
            <dt>Linked as</dt>
            <dd>{server?.deviceName ?? '…'}</dd>
            <dt>Signal API</dt>
            <dd>{server ? `${server.apiVersion ?? 'unknown version'} (${server.status})` : '…'}</dd>
            <dt>GIF search</dt>
            <dd>{server ? (server.giphyConfigured ? 'Giphy key set' : 'No Giphy key set') : '…'}</dd>
            <dt>Signed-in browsers</dt>
            <dd>{server?.sessions ?? '…'}</dd>
          </dl>
          {notice && <p className="muted setting-note">{notice}</p>}
          <div className="setting-actions">
            <button className="btn" onClick={refreshDirectory}>
              Refresh contacts and groups
            </button>
            <button className="btn" onClick={onLogout}>
              Sign out
            </button>
            <button className="btn danger" onClick={logoutAll}>
              Sign out everywhere
            </button>
          </div>
        </Section>
      </div>
    </aside>
  );
}
