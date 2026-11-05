import { type ReactNode, useEffect, useRef, useState } from 'react';
import { type Profile, type ServerSettings, api } from '../api';
import { type NotifyState, notifyState, requestNotifications, testNotification } from '../notifications';
import { squareAvatar } from '../util';
import { type Prefs, setPrefs, usePrefs } from '../prefs';
import { Avatar, Icon } from './ui';
import { useStore } from '../store';

/** Why notifications can't work on plain http://, and how to fix it. */
export function InsecureHelp() {
  const host = location.hostname;
  return (
    <div className="setting-note insecure-help">
      <p>
        <strong>Browsers only allow notifications on HTTPS pages.</strong> You opened Messenger Web over plain http ({location.origin}), so the browser
        blocks them without asking.
      </p>
      <p>Ways to fix it:</p>
      <ul>
        <li>
          <strong>Unraid 7 with Tailscale:</strong> edit the signal-web container, turn on <em>Use Tailscale</em>, enable <em>Serve</em>, and open
          the https://….ts.net address it gives you.
        </li>
        <li>
          <strong>Reverse proxy</strong> (Nginx Proxy Manager, SWAG, Caddy) with a certificate, or give signal-web a certificate directly with{' '}
          <code>TLS_CERT_FILE</code> and <code>TLS_KEY_FILE</code>.
        </li>
        <li>
          <strong>Just this browser:</strong> in Firefox, open <code>about:config</code> and add <code>{host}</code> to{' '}
          <code>dom.securecontext.allowlist</code>. In Chrome or Edge, open <code>chrome://flags/#unsafely-treat-insecure-origin-as-secure</code> and
          add <code>{location.origin}</code>. Restart the browser afterwards.
        </li>
      </ul>
    </div>
  );
}

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

function EmojiSample({ set }: { set: 'fluent' | 'twemoji' }) {
  const ext = set === 'fluent' ? 'webp' : 'png';
  return (
    <>
      {['1f602', '1f44d', '2764'].map((k) => (
        <img key={k} className="emoji" src={`/emoji/${set}/${k}.${ext}`} alt="" />
      ))}
    </>
  );
}

/** Your Signal profile: picture, first name, about. Changes sync to your phone and contacts. */
function ProfileSection() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [givenName, setGivenName] = useState('');
  const [about, setAbout] = useState('');
  const [photo, setPhoto] = useState<{ data: string; preview: string } | 'remove' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.profile().then(
      (p) => {
        setProfile(p);
        setGivenName(p.givenName);
        setAbout(p.about);
      },
      (e) => setError(e.message),
    );
  }, []);

  async function choose(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      const data = await squareAvatar(file);
      setPhoto({ data, preview: `data:image/jpeg;base64,${data}` });
      setSaved(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const p = await api.updateProfile({
        givenName,
        about,
        ...(photo === 'remove' ? { avatar: null } : photo ? { avatar: photo.data } : {}),
      });
      setProfile(p);
      setPhoto(null);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const shown = photo === 'remove' ? null : photo ? photo.preview : profile?.avatar ?? null;
  const dirty = !!profile && (givenName !== profile.givenName || about !== profile.about || photo !== null);
  const fullName = [givenName, profile?.familyName].filter(Boolean).join(' ') || 'You';

  return (
    <Section title="Signal profile">
      <div className="profile-edit">
        <button className="profile-photo" onClick={() => fileInput.current?.click()} title="Change profile picture" aria-label="Change profile picture">
          <Avatar key={shown ?? 'none'} name={fullName} seed="self" size={88} src={shown} />
          <span className="photo-overlay">
            <Icon name="camera" size={22} />
          </span>
        </button>
        <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => (void choose(e.target.files?.[0]), (e.target.value = ''))} />
        <div className="profile-fields">
          <label className="field">
            <span>First name</span>
            <input value={givenName} maxLength={26} onChange={(e) => (setGivenName(e.target.value), setSaved(false))} disabled={!profile} />
          </label>
          {profile?.familyName && <p className="setting-note">Last name “{profile.familyName}” stays as it is; change it on your phone.</p>}
          <label className="field">
            <span>About</span>
            <input value={about} maxLength={140} placeholder="A few words about yourself" onChange={(e) => (setAbout(e.target.value), setSaved(false))} disabled={!profile} />
          </label>
        </div>
      </div>
      {error && <p className="form-error setting-note">{error}</p>}
      {saved && <p className="setting-note">Saved. Your phone and contacts get the new profile within a few minutes.</p>}
      <div className="setting-actions">
        <button className="btn primary" onClick={save} disabled={busy || !dirty || !givenName.trim()}>
          {busy ? 'Saving…' : 'Save profile'}
        </button>
        {(profile?.avatar || (photo && photo !== 'remove')) && photo !== 'remove' && (
          <button className="btn" onClick={() => (setPhoto('remove'), setSaved(false))} disabled={busy}>
            Remove picture
          </button>
        )}
        {photo && (
          <button className="btn" onClick={() => setPhoto(null)} disabled={busy}>
            Undo picture change
          </button>
        )}
      </div>
    </Section>
  );
}

/** Linking and status of WhatsApp (through WAHA). */
const HISTORY_CHATS = [[40, '40 chats'], [100, '100 chats'], [250, '250 chats'], [0, 'All chats']] as const;
const HISTORY_MESSAGES = [[40, '40 messages'], [200, '200 messages'], [1000, '1,000 messages'], [0, 'As many as possible (up to 20,000)']] as const;

/** How much history "Import history now" fetches (and the automatic import after linking). */
function HistorySettings() {
  const [s, setS] = useState<ServerSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.settings().then(setS, (e) => setError(e.message));
  }, []);
  if (!s) return error ? <p className="form-error setting-note">{error}</p> : null;
  async function save(patch: { waHistoryChats?: number; waHistoryMessages?: number; waHistoryMedia?: boolean }) {
    try {
      setS(await api.updateSettings(patch));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const pick = <T extends readonly (readonly [number, string])[]>(opts: T, v: number) => (opts.some(([n]) => n === v) ? opts : [...opts, [v, String(v)] as const]);
  return (
    <div className="history-settings">
      <label>
        <span>History to import</span>
        <span className="history-pickers">
          <select value={s.waHistoryChats} onChange={(e) => void save({ waHistoryChats: Number(e.target.value) })}>
            {pick(HISTORY_CHATS, s.waHistoryChats).map(([n, label]) => (
              <option key={n} value={n}>
                {label}
              </option>
            ))}
          </select>
          <span className="muted">×</span>
          <select value={s.waHistoryMessages} onChange={(e) => void save({ waHistoryMessages: Number(e.target.value) })}>
            {pick(HISTORY_MESSAGES, s.waHistoryMessages).map(([n, label]) => (
              <option key={n} value={n}>
                {n === 0 ? label : `${label} each`}
              </option>
            ))}
          </select>
        </span>
      </label>
      <p className="muted setting-note">
        Counted from the newest. Messages you already have are skipped. Photos, videos and files are fetched when you open them: old ones can take WhatsApp a while, and some it no longer has.
      </p>
      <Toggle
        label="Download files from imported history"
        hint="Fetches them one at a time in the background after an import, newest first, so they're on the server before you open them. Uses disk space; old files can take up to a minute each."
        checked={s.waHistoryMedia}
        onChange={(v) => void save({ waHistoryMedia: v })}
      />
      {error && <p className="form-error setting-note">{error}</p>}
    </div>
  );
}

function WhatsAppSection() {
  const wa = useStore((s) => s.whatsapp);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [importAsked, setImportAsked] = useState(false);

  // QR codes expire after about 20 seconds: fetch a fresh one.
  useEffect(() => {
    if (wa.status !== 'scan_qr') return;
    const t = setInterval(() => setNonce((n) => n + 1), 18_000);
    return () => clearInterval(t);
  }, [wa.status]);

  async function run(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (done) setNotice(done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (wa.status === 'disabled') {
    return (
      <Section title="WhatsApp">
        <p className="muted setting-note">
          Not set up. Run WAHA next to Messenger Web and set <code>WAHA_URL</code> and <code>WAHA_API_KEY</code> on the Messenger Web container.
        </p>
      </Section>
    );
  }
  return (
    <Section title="WhatsApp">
      {wa.status === 'connected' && (
        <dl className="setting-facts">
          <dt>Linked number</dt>
          <dd>
            {wa.me ?? '…'}
            {wa.name ? ` (${wa.name})` : ''}
          </dd>
          <dt>WAHA</dt>
          <dd>{[wa.version, wa.engine].filter(Boolean).join(', ') || '…'}</dd>
        </dl>
      )}
      {wa.importing && (
        <p className="setting-note">
          <span className="spinner small" />{' '}
          {wa.importProgress?.waiting
            ? `WhatsApp Web restarted. The import continues at chat ${wa.importProgress.done + 1} of ${wa.importProgress.total} once it's back…`
            : wa.importProgress
              ? `Importing history from WhatsApp (chat ${Math.min(wa.importProgress.done + 1, wa.importProgress.total)} of ${wa.importProgress.total})…`
              : 'Getting the chat list from WhatsApp…'}{' '}
          <button className="link-btn" onClick={() => void api.whatsappImportCancel().catch(() => {})}>
            Stop
          </button>
        </p>
      )}
      {!wa.importing && wa.lastImport && importAsked && (
        <p className={wa.lastImport.error ? 'form-error setting-note' : 'muted setting-note'}>
          {wa.lastImport.error
            ? `Import failed: ${wa.lastImport.error}`
            : (wa.lastImport.messages
                ? `Imported ${wa.lastImport.messages} messages from ${wa.lastImport.chats} chats.`
                : 'No older messages found that weren’t here already.') +
              (wa.lastImport.skipped ? ` Skipped ${wa.lastImport.skipped} chat${wa.lastImport.skipped === 1 ? '' : 's'} that made WhatsApp Web crash.` : '')}
        </p>
      )}
      {wa.status === 'connected' && <HistorySettings />}
      {wa.status === 'scan_qr' && (
        <div className="wa-link">
          <ol>
            <li>Open WhatsApp on your phone.</li>
            <li>
              Go to <strong>Settings → Linked devices</strong>.
            </li>
            <li>
              Tap <strong>Link a device</strong> and scan this code.
            </li>
          </ol>
          <img className="wa-qr" src={`/api/whatsapp/qr?n=${nonce}`} alt="WhatsApp link QR code" width={220} height={220} />
          <p className="muted setting-note">
            Using an unofficial client is against WhatsApp's terms. Personal use rarely causes problems, but your account could be banned.
          </p>
        </div>
      )}
      {(wa.status === 'starting' || wa.status === 'stopped') && (
        <p className="setting-note">
          <span className="spinner small" /> Starting the WhatsApp session…
        </p>
      )}
      {(wa.status === 'unreachable' || wa.status === 'failed') && <p className="form-error setting-note">{wa.error}</p>}
      {error && <p className="form-error setting-note">{error}</p>}
      {notice && <p className="muted setting-note">{notice}</p>}
      <div className="setting-actions">
        {wa.status === 'connected' && (
          <button className="btn" disabled={busy} onClick={() => void run(() => api.whatsappRefresh(), 'Contacts and groups updated.')}>
            Refresh contacts and groups
          </button>
        )}
        {wa.status === 'connected' && (
          <button
            className="btn"
            disabled={busy || wa.importing}
            onClick={() =>
              void run(async () => {
                setImportAsked(true);
                await api.whatsappImport();
              })
            }
          >
            Import history now
          </button>
        )}
        {wa.status === 'failed' && (
          <button className="btn" disabled={busy} onClick={() => void run(() => api.whatsappRestart())}>
            Restart session
          </button>
        )}
        {wa.status === 'connected' && (
          <button
            className="btn danger"
            disabled={busy}
            onClick={() => confirm('Unlink WhatsApp? Messenger Web stops receiving WhatsApp messages until you link again.') && void run(() => api.whatsappLogout())}
          >
            Unlink WhatsApp
          </button>
        )}
      </div>
    </Section>
  );
}

const EMOJI_STYLES: { value: Prefs['emoji']; label: string; sample: string }[] = [
  { value: 'noto', label: 'Google Noto', sample: '😂' },
  { value: 'fluent', label: 'Fluent 3D', sample: '😂' },
  { value: 'twemoji', label: 'Twemoji', sample: '😂' },
  { value: 'system', label: 'System', sample: '😂' },
];

const THEMES: { value: Prefs['theme']; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark blue' },
  { value: 'dark-green', label: 'Dark green' },
];

export function SettingsView({ onClose, onLogout }: { onClose: () => void; onLogout: () => void }) {
  const prefs = usePrefs();
  const [server, setServer] = useState<ServerSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [permission, setPermission] = useState<NotifyState>(notifyState);
  const signalOn = useStore((s) => s.signal.status !== 'disabled');
  const waOn = useStore((s) => s.whatsapp.status !== 'disabled');

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
    if (on && permission === 'default') {
      const p = await requestNotifications();
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
    if (!confirm('Sign out of Messenger Web in every browser, including this one?')) return;
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

        {signalOn && <ProfileSection />}

        <WhatsAppSection />

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

        <Section title="Emoji">
          <div className="setting-row">
            <span className="setting-text">
              <strong>Emoji style</strong>
              <small>Applies to this browser. Fluent and Twemoji show in messages and lists; the message box uses Noto while you type.</small>
            </span>
          </div>
          <div className="emoji-styles" role="radiogroup" aria-label="Emoji style">
            {EMOJI_STYLES.map((s) => (
              <button key={s.value} role="radio" aria-checked={prefs.emoji === s.value} className={prefs.emoji === s.value ? 'on' : undefined} onClick={() => setPrefs({ emoji: s.value })}>
                <span className="emoji-sample" data-style={s.value}>
                  {s.value === 'noto' || s.value === 'system' ? '😂👍❤️' : <EmojiSample set={s.value} />}
                </span>
                {s.label}
              </button>
            ))}
          </div>
          <p className="muted setting-note">
            Noto: Google, SIL Open Font License. Fluent: Microsoft, MIT. Twemoji graphics: © Twitter, Inc. and other contributors, CC-BY 4.0.
          </p>
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
          ) : permission === 'insecure' ? (
            <InsecureHelp />
          ) : (
            <>
              <Toggle
                label="Desktop notifications"
                hint={
                  blocked
                    ? 'Blocked for this site. Click the lock or site-settings icon left of the address, allow notifications, and reload.'
                    : 'For new messages while a Messenger Web tab is open in the background.'
                }
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
              {permission === 'granted' && prefs.notifications && (
                <div className="setting-actions">
                  <button className="btn" onClick={testNotification}>
                    Send a test notification
                  </button>
                </div>
              )}
            </>
          )}
        </Section>

        <Section title="Privacy">
          <Toggle
            label="Send read receipts"
            hint="Others see when you've read their messages in Messenger Web. Applies to every browser."
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
          <Toggle
            label="Send link previews"
            hint="When you type a link, the Messenger Web server fetches that page to show its title and picture, like Signal Desktop does. The site sees your server's address."
            checked={!!server?.sendLinkPreviews}
            disabled={!server}
            onChange={(v) => void saveServer({ sendLinkPreviews: v })}
          />
          {waOn && (
            <Toggle
              label="Forward WhatsApp messages natively"
              hint="Forwarding between WhatsApp chats works like on your phone: the message shows as “Forwarded”. Off: a copy is sent instead. Forwards between Signal and WhatsApp are always copies."
              checked={!!server?.waNativeForward}
              disabled={!server}
              onChange={(v) => void saveServer({ waNativeForward: v })}
            />
          )}
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
