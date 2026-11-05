import { type ReactNode, useEffect, useRef, useState } from 'react';
import { type Profile, type ServerSettings, type WaProfile, api, uploadBackup } from '../api';
import type { BackupFile } from '../types';
import { type NotifyState, notifyState, requestNotifications, testNotification } from '../notifications';
import { formatSize, squareAvatar } from '../util';
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

/** Your WhatsApp profile: name, about and picture. Changes go to your phone and contacts. */
function WaProfileSection() {
  const [profile, setProfile] = useState<WaProfile | null>(null);
  const [name, setName] = useState('');
  const [about, setAbout] = useState('');
  const [photo, setPhoto] = useState<{ data: string; preview: string } | 'remove' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [rev, setRev] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    api.waProfile().then(
      (p) => {
        setProfile(p);
        setName(p.name);
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
    if (!profile) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const p = await api.updateWaProfile({
        ...(name !== profile.name ? { name } : {}),
        ...(about !== profile.about ? { about } : {}),
        ...(photo === 'remove' ? { picture: null } : photo ? { picture: `data:image/jpeg;base64,${photo.data}` } : {}),
      });
      setProfile(p);
      setPhoto(null);
      setSaved(true);
      setRev((r) => r + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const own = profile?.number ? `/api/avatars/wa/${encodeURIComponent(profile.number.replace(/\D/g, '') + '@c.us')}.jpg?r=${rev}` : null;
  const shown = photo === 'remove' ? null : photo ? photo.preview : own;
  const dirty = !!profile && (name !== profile.name || about !== profile.about || photo !== null);
  return (
    <Section title="WhatsApp profile">
      <div className="profile-edit">
        <button className="profile-photo" onClick={() => fileInput.current?.click()} title="Change profile picture" aria-label="Change WhatsApp profile picture">
          <Avatar key={shown ?? 'none'} name={name || 'You'} seed="self-wa" size={88} src={shown} />
          <span className="photo-overlay">
            <Icon name="camera" size={22} />
          </span>
        </button>
        <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => (void choose(e.target.files?.[0]), (e.target.value = ''))} />
        <div className="profile-fields">
          <label className="field">
            <span>Name</span>
            <input value={name} maxLength={25} onChange={(e) => (setName(e.target.value), setSaved(false))} disabled={!profile} aria-label="WhatsApp name" />
          </label>
          <label className="field">
            <span>About</span>
            <input value={about} maxLength={139} placeholder="Hey there! I am using WhatsApp." onChange={(e) => (setAbout(e.target.value), setSaved(false))} disabled={!profile} aria-label="WhatsApp about" />
          </label>
        </div>
      </div>
      {error && <p className="form-error setting-note">{error}</p>}
      {saved && <p className="setting-note">Saved. Your phone and contacts see it within a minute.</p>}
      <div className="setting-actions">
        <button className="btn primary" onClick={save} disabled={busy || !dirty || !name.trim()}>
          {busy ? 'Saving…' : 'Save WhatsApp profile'}
        </button>
        {photo !== 'remove' && !photo && (
          <button className="btn" onClick={() => (setPhoto('remove'), setSaved(false))} disabled={busy || !profile}>
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

function plural(n: number, one: string, many?: string) {
  if (many) return `${n.toLocaleString()} ${n === 1 ? one : many}`;
  return `${n.toLocaleString()} ${one}${n === 1 ? '' : 's'}`;
}

/** Full history from an Android backup (msgstore.db.crypt15 + the 64-digit key), then the media folder. */
function BackupImport() {
  const b = useStore((s) => s.whatsapp.backup);
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<{ file: BackupFile | null; folder: string; mediaWaiting?: number } | null>(null);
  const [key, setKey] = useState('');
  const [upload, setUpload] = useState<number | null>(null);
  const [stickerNote, setStickerNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const running = b?.stage === 'decrypting' || b?.stage === 'importing' || b?.stage === 'media';
  useEffect(() => {
    if (open) api.backupInfo().then(setInfo, (e) => setError(e.message));
  }, [open, b?.stage]);
  // Whichever knows about a file: the live state, or the answer to our own upload / question.
  const file = b?.file ?? info?.file ?? null;
  const plain = !!file && /\.db$/i.test(file.name);
  const digits = key.replace(/[^0-9a-f]/gi, '').length;

  async function pick(f: File | undefined) {
    if (!f) return;
    setError(null);
    setUpload(0);
    try {
      const r = await uploadBackup(f, setUpload);
      setInfo((i) => ({ ...i, folder: i?.folder ?? '', file: r.file }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUpload(null);
    }
  }
  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!open) {
    return (
      <div className="backup-import">
        <button className="link-btn" onClick={() => setOpen(true)}>
          Import full history from an Android backup…
        </button>
      </div>
    );
  }
  const pct = (p?: { done: number; total: number }) => (p && p.total ? ` ${Math.min(100, Math.round((p.done / p.total) * 100))}%` : '');
  return (
    <div className="backup-import">
      <h4>Full history from an Android backup</h4>
      <ol className="setting-note">
        <li>
          On your phone: WhatsApp → Settings → Chats → Chat backup → <strong>End-to-end encrypted backup</strong> → turn it on and choose <strong>Use 64-digit encryption key</strong>. Write the key down,
          then tap <strong>Back up</strong>.
        </li>
        <li>
          Copy <code>Android/media/com.whatsapp/WhatsApp/Databases/msgstore.db.crypt15</code> from the phone and upload it below. Large file or slow connection? Put it in the
          <code>whatsapp-backup</code> folder inside Messenger Web's data folder instead (in the container: <code>{info?.folder ?? '/data/whatsapp-backup'}</code>).
        </li>
        <li>Enter the key and import. Messages already here are skipped.</li>
      </ol>
      <p className="muted setting-note">
        Keep the key safe: it also opens your Google Drive backups, and without it you can't restore them. Messenger Web doesn't store it. The backup file and its decrypted copy are deleted after the import.
      </p>

      <div className="setting-actions">
        <input ref={fileInput} type="file" accept=".crypt15,.db" hidden onChange={(e) => (void pick(e.target.files?.[0]), (e.target.value = ''))} />
        <button className="btn" disabled={running || upload !== null} onClick={() => fileInput.current?.click()}>
          {upload !== null ? `Uploading… ${Math.round(upload * 100)}%` : file ? 'Choose another file' : 'Choose backup file'}
        </button>
      </div>
      {file && (
        <p className="setting-note">
          {file.name} · {formatSize(file.size)}
          {file.app ? ` · WhatsApp ${file.app}` : ''}
        </p>
      )}
      {file && !plain && (
        <label className="backup-key">
          <span>64-digit key</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="1a2b 3c4d …"
            aria-label="64-digit backup key"
          />
          <small className="muted">{digits}/64</small>
        </label>
      )}
      {file && (
        <div className="setting-actions">
          <button className="btn primary" disabled={running || (!plain && digits !== 64)} onClick={() => void run(async () => (await api.backupImport(plain ? undefined : key), setKey('')))}>
            Import backup
          </button>
        </div>
      )}

      {running && (
        <p className="setting-note">
          <span className="spinner small" />{' '}
          {b?.stage === 'decrypting'
            ? `Decrypting the backup…${pct(b.progress)}`
            : b?.stage === 'importing'
              ? `Importing messages…${b.progress?.total ? ` ${b.progress.done.toLocaleString()} of ${b.progress.total.toLocaleString()}` : ''}`
              : b?.progress?.phase === 'copy'
                ? `Copying matched files… ${b.progress.done.toLocaleString()} of ${b.progress.total.toLocaleString()}`
                : `Looking through the folder…${b?.progress?.done ? ` ${b.progress.done.toLocaleString()} files so far` : ''}`}{' '}
          <button className="link-btn" onClick={() => void api.backupCancel().catch(() => {})}>
            Stop
          </button>
        </p>
      )}
      {b?.stage === 'failed' && b.error && <p className="form-error setting-note">{b.error}</p>}
      {b?.stage === 'done' && b.result && (
        <p className="muted setting-note">
          Imported {b.result.messages.toLocaleString()} messages from {b.result.chats} chats
          {b.result.skipped ? ` (${plural(b.result.skipped, 'was', 'were')} here already)` : ''}
          {b.result.reactions ? `, ${plural(b.result.reactions, 'reaction')}` : ''}.
          {b.result.mediaFound !== undefined ? ` Media: matched ${plural(b.result.mediaFound, 'file')}${b.result.mediaMissing ? `, ${b.result.mediaMissing.toLocaleString()} not in the folder` : ''}.` : ''}
        </p>
      )}

      {(b?.result || !!info?.mediaWaiting) && (
        <>
          <h4>Photos, videos and files</h4>
          {!!info?.mediaWaiting && <p className="setting-note">{plural(info.mediaWaiting, 'file')} from the backup still to add.</p>}
          <p className="setting-note">
            Copy the phone's <code>Android/media/com.whatsapp/WhatsApp/Media</code> folder (or just the folders you want, like <em>WhatsApp Images</em>) into the <code>whatsapp-backup</code>
            folder in Messenger Web's data folder (in the container: <code>{info?.folder ?? '/data/whatsapp-backup'}</code>), then:
          </p>
          <div className="setting-actions">
            <button className="btn" disabled={running} onClick={() => void run(() => api.backupMedia())}>
              Add media from the folder
            </button>
          </div>
          <div className="setting-actions">
            <button className="btn" disabled={running} onClick={() => void run(async () => {
              const r = await api.importWaStickers();
              setStickerNote(`${r.found.toLocaleString()} stickers found, ${r.added.toLocaleString()} new. They're in the sticker tab of WhatsApp chats.`);
            })}>
              Import stickers from the folder
            </button>
          </div>
          {stickerNote && <p className="muted setting-note">{stickerNote}</p>}
          <p className="muted setting-note">Files are copied into Messenger Web; you can delete the folder afterwards. Files not in the folder are still fetched from WhatsApp when you open them, if it has them.</p>
        </>
      )}
      {error && <p className="form-error setting-note">{error}</p>}
    </div>
  );
}

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
      <BackupImport />
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
  const waConnected = useStore((s) => s.whatsapp.status === 'connected');

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
        {waConnected && <WaProfileSection />}

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
              label="Show when people are online"
              hint="WhatsApp: “online” or “last seen …” under the name in a chat (if they share it). Applies to this browser."
              checked={prefs.showPresence}
              onChange={(v) => setPrefs({ showPresence: v })}
            />
          )}
          {waOn && (
            <Toggle
              label="Show me as online on WhatsApp"
              hint="While Messenger Web is open and in front in a browser. Off: you never show as online from here (your phone still does when you use it)."
              checked={!!server?.waShowOnline}
              disabled={!server}
              onChange={(v) => void saveServer({ waShowOnline: v })}
            />
          )}
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
