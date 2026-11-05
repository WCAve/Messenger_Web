import { useEffect, useState } from 'react';
import type { SignalState } from '../types';

/** Shown when no Signal account is linked yet: the QR code to scan from the phone. */
export function LinkScreen({ onClose }: { onClose?: () => void } = {}) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    setSrc(null);
    setError(null);
    fetch('/api/link/qr', { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Couldn't get a QR code (${res.status})`);
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch((e) => !cancelled && setError(e.message));
    // Link codes expire after a while; fetch a fresh one every 90 seconds.
    const t = setTimeout(() => setNonce((n) => n + 1), 90_000);
    return () => {
      cancelled = true;
      clearTimeout(t);
      if (url) URL.revokeObjectURL(url);
    };
  }, [nonce]);

  return (
    <main className="gate">
      <section className="gate-card link-card">
        <div className="link-copy">
          <h1>Link Signal</h1>
          <ol>
            <li>Open Signal on your phone.</li>
            <li>
              Go to <strong>Settings → Linked devices</strong>.
            </li>
            <li>
              Tap <strong>Link new device</strong> and scan this code.
            </li>
          </ol>
          <p className="muted">
            Messenger Web becomes a linked device, like Signal Desktop. Messages from before linking stay on your phone; new ones show up here.
          </p>
          {onClose && (
            <button className="btn" onClick={onClose}>
              Back to chats
            </button>
          )}
        </div>
        <div className="qr-frame" aria-live="polite">
          {src ? <img src={src} alt="Signal device-link QR code" width={232} height={232} /> : <div className="qr-placeholder">{error ? '' : 'Getting a code…'}</div>}
          {error && (
            <div className="qr-error">
              <p>{error}</p>
              <button className="btn" onClick={() => setNonce((n) => n + 1)}>
                Try again
              </button>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

const TITLES: Partial<Record<SignalState['status'], string>> = {
  starting: 'Starting up',
  unreachable: "Can't reach the Signal API",
  wrong_mode: 'The Signal API needs json-rpc mode',
};

const HELP: Partial<Record<SignalState['status'], string>> = {
  unreachable:
    'Check that the Signal API container is running and that SIGNAL_API_URL points at it. On Unraid, both containers need to be on the same custom Docker network. Retrying every few seconds.',
  wrong_mode: 'Edit the Signal API container, set MODE to json-rpc-native, and set JSON_RPC_RECEIVE_MODE to manual. Then restart it.',
};

export function StatusScreen({ state }: { state: SignalState }) {
  return (
    <main className="gate">
      <section className="gate-card">
        <img src="/icon.svg" alt="" width={56} height={56} />
        <h1>{TITLES[state.status] ?? 'Connecting'}</h1>
        {state.error && <p className="form-error">{state.error}</p>}
        {HELP[state.status] && <p className="muted">{HELP[state.status]}</p>}
        {state.status === 'starting' && <div className="spinner" aria-label="Loading" />}
      </section>
    </main>
  );
}
