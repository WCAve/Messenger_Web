/** Live events to every open browser tab, over Server-Sent Events. */
import type { IncomingMessage, ServerResponse } from 'node:http';

export type ServerEvent =
  | { type: 'state'; state: unknown }
  | { type: 'wastate'; state: unknown } // WhatsApp connection
  | { type: 'conversation'; conversation: unknown }
  | { type: 'message'; message: unknown }
  | { type: 'typing'; conversationId: number; author: string; authorName: string; started: boolean; recording?: boolean }
  | { type: 'presence'; conversationId: number; online: boolean; lastSeen: number | null }
  | { type: 'receipt'; messageId: number } // per-recipient receipt changed (overall status didn't)
  | { type: 'remove'; conversationId: number; messageId: number } // disappeared
  | { type: 'group'; conversationId: number } // group details changed: open group info reloads
  | { type: 'ping' }; // every 25 s: a page that hears nothing for a minute knows its connection is dead

const clients = new Set<ServerResponse>();
const stalled = new WeakSet<ServerResponse>(); // tests only: connections that silently stop getting anything

export function addClient(req: IncomingMessage, res: ServerResponse, initial: ServerEvent[]) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // don't let nginx-style proxies buffer the stream
  });
  res.write('retry: 3000\n\n');
  for (const e of initial) res.write(`data: ${JSON.stringify(e)}\n\n`);
  clients.add(res);
  const drop = () => clients.delete(res);
  req.on('close', drop);
  res.on('error', drop);
}

/** A tab that stopped reading (asleep, bad network) would otherwise pile events up in memory. */
const MAX_QUEUED = 4 * 1024 * 1024;

function send(res: ServerResponse, data: string) {
  if (stalled.has(res)) return;
  if (res.writableLength > MAX_QUEUED) {
    clients.delete(res);
    res.destroy(); // the browser reconnects and reloads what it missed
    return;
  }
  res.write(data);
}

export function broadcast(event: ServerEvent) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) send(res, data);
}

// Keep idle connections (and any proxy in between) from timing out, and let pages see the connection is
// alive: a connection can die without either side noticing (sleep, network change, a proxy), and then
// the page would wait forever. This is a real event (not an SSE comment) so the page can see it.
const PING_MS = Number(process.env.EVENTS_PING_MS) || 25_000;
setInterval(() => {
  for (const res of clients) send(res, `data: {"type":"ping"}\n\n`);
}, PING_MS).unref();

/** Tests only (E2E_HOOKS=1): every open connection goes silent without closing, like a dead network. */
export function stallAllClients() {
  for (const res of clients) stalled.add(res);
}

/** Drop every live connection (after "sign out everywhere"); browsers reconnect and hit the login page. */
export function closeAllClients() {
  for (const res of clients) res.end();
  clients.clear();
}

export function clientCount() {
  return clients.size;
}
