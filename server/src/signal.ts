/**
 * Keeps one long-lived websocket subscription to signal-cli-rest-api and tracks
 * whether the Signal side is reachable / linked / connected.
 */
import { config } from './config.js';
import { broadcast } from './events.js';
import { handleEnvelope, ingestHooks } from './ingest.js';
import { signalApi } from './signal-api.js';
import { conversationDto, getOrCreateGroup, listConversationRows, self, upsertContact } from './store.js';

/** Names and group details may have changed: push fresh chat-list rows to open browsers. */
function broadcastAllConversations() {
  for (const row of listConversationRows()) broadcast({ type: 'conversation', conversation: conversationDto(row) });
}

export type SignalStatus =
  | 'starting'
  | 'unreachable' // can't talk to the Signal API container
  | 'wrong_mode' // Signal API isn't in json-rpc mode
  | 'unlinked' // no account linked yet → show QR code
  | 'connecting'
  | 'connected';

export interface SignalState {
  status: SignalStatus;
  account?: string;
  apiVersion?: string;
  error?: string;
}

type Logger = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void; debug?: (m: string) => void };

let state: SignalState = { status: 'starting' };
let log: Logger = console;
let ws: WebSocket | undefined;
let reconnectDelay = 1000;
let checkTimer: ReturnType<typeof setTimeout> | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let groupRefreshDebounce: ReturnType<typeof setTimeout> | undefined;

export function getState() {
  return state;
}

function setState(next: SignalState) {
  const changed = JSON.stringify(next) !== JSON.stringify(state);
  state = next;
  if (changed) {
    log.info(`signal: ${next.status}${next.account ? ' (' + next.account + ')' : ''}${next.error ? ' — ' + next.error : ''}`);
    broadcast({ type: 'state', state: next });
  }
}

/** Probe the Signal API and (re)start the receiver as appropriate. */
async function check() {
  clearTimeout(checkTimer);
  try {
    const about = await signalApi.about();
    if (about.mode !== 'json-rpc') {
      setState({
        status: 'wrong_mode',
        apiVersion: about.version,
        error: `Signal API is running in "${about.mode}" mode. Set MODE=json-rpc-native (or json-rpc) on the Signal API container.`,
      });
      return schedule(30_000);
    }
    const accounts = await signalApi.accounts();
    const account = config.signalNumber ? accounts.find((a) => a === config.signalNumber) : accounts[0];
    if (!account) {
      setState({
        status: 'unlinked',
        apiVersion: about.version,
        error: config.signalNumber && accounts.length ? `SIGNAL_NUMBER ${config.signalNumber} is not linked in the Signal API` : undefined,
      });
      return schedule(state.status === 'unlinked' ? 3000 : 5000);
    }
    if (self.number && self.number !== account) log.warn(`signal: account changed from ${self.number} to ${account}`);
    self.number = account;
    if (!ws) {
      setState({ status: 'connecting', account, apiVersion: about.version });
      connect(account);
      refreshDirectory().catch((e) => log.warn('signal: directory refresh failed: ' + e.message));
      clearInterval(refreshTimer);
      refreshTimer = setInterval(() => refreshDirectory().catch(() => {}), 15 * 60_000);
    }
  } catch (e) {
    if (!ws) setState({ status: 'unreachable', error: `Can't reach the Signal API at ${config.signalApiUrl}: ${(e as Error).message}` });
    return schedule(5000);
  }
}

function schedule(ms: number) {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(check, ms);
}

function connect(account: string) {
  const url = signalApi.receiveUrl(account);
  const sock = new WebSocket(url); // Node 22 built-in client (answers server pings itself)
  ws = sock;

  // Health probe: if the API stops answering while the socket looks open, force a reconnect.
  const probe = setInterval(async () => {
    try {
      await signalApi.about();
    } catch {
      log.warn('signal: API not answering, reconnecting receive socket');
      sock.close();
    }
  }, 60_000);

  sock.addEventListener('open', () => {
    reconnectDelay = 1000;
    setState({ ...state, status: 'connected', account, error: undefined });
  });
  sock.addEventListener('message', (ev) => {
    let payload: unknown;
    try {
      payload = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString('utf8'));
    } catch {
      return log.warn('signal: non-JSON message on receive socket');
    }
    handleEnvelope(payload);
  });
  sock.addEventListener('error', () => log.warn('signal: receive socket error (is the Signal API in json-rpc mode?)'));
  sock.addEventListener('close', () => {
    clearInterval(probe);
    if (ws !== sock) return;
    ws = undefined;
    setState({ ...state, status: 'connecting', error: 'Connection to Signal API lost, reconnecting…' });
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    schedule(delay);
  });
}

/** Pull contacts and groups so names and group lists are current. */
export async function refreshDirectory() {
  const account = self.number;
  if (!account) return;
  const [contacts, groups] = await Promise.all([
    // all_recipients needs a recent signal-cli-rest-api; fall back to address-book contacts only.
    signalApi.contacts(account, true).catch(() => signalApi.contacts(account)),
    signalApi.groups(account),
  ]);
  for (const c of contacts) {
    const nick = c.nickname?.name || [c.nickname?.given_name, c.nickname?.family_name].filter(Boolean).join(' ');
    const profile = c.profile_name || [c.profile?.given_name, c.profile?.lastname].filter(Boolean).join(' ');
    upsertContact({
      uuid: c.uuid || null,
      number: c.number || null,
      name: nick || c.name || null,
      profile_name: profile || null,
      username: c.username || null,
      blocked: c.blocked,
      about: c.profile?.about || null,
      has_avatar: !!c.profile?.has_avatar,
    });
  }
  for (const g of groups) {
    if (g.blocked || g.member === false) continue;
    getOrCreateGroup(g.internal_id, g.name, g.members, { description: g.description || null, admins: g.admins ?? [] });
  }
  broadcastAllConversations();
  log.info(`signal: directory refreshed (${contacts.length} contacts, ${groups.length} groups)`);
}

export function startSignal(logger: Logger) {
  log = logger;
  ingestHooks.log = (m, err) => log.warn(`ingest: ${m}${err ? ': ' + (err as Error).message : ''}`);
  ingestHooks.debug = (m) => log.debug?.(`ingest: ${m}`);
  ingestHooks.onGroupChanged = () => {
    clearTimeout(groupRefreshDebounce);
    groupRefreshDebounce = setTimeout(() => refreshDirectory().catch(() => {}), 3000);
  };
  check();
}

/** Called after the user scanned the QR code, to pick up the new account quickly. */
export function recheckSoon() {
  schedule(500);
}

export function stopSignal() {
  clearTimeout(checkTimer);
  clearInterval(refreshTimer);
  const s = ws;
  ws = undefined;
  s?.close();
}
