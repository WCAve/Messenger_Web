/**
 * Start-up: refuses to run without APP_PASSWORD, opens the database (migrations), runs one-off
 * clean-ups (each guarded by a kv flag), starts Signal (signal.ts) and WhatsApp (whatsapp.ts), and
 * serves the API (routes.ts) and the built web app (web/dist) with security headers (CSP: no inline
 * scripts, so no eval either). Logs go to stdout: `docker logs signal-web`.
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { db, kvGet, kvSet } from './db.js';
import { sendFile, sendJson } from './http.js';
import { backfillGifFlags } from './ingest.js';
import { buildRouter } from './routes.js';
import { backfillExtRaw, cleanPreviewText, recomputeGroupReadStatuses, removeDuplicateWaMessages } from './store.js';
import { startSignal, stopSignal } from './signal.js';
import { startExpiry, stopExpiry } from './expiry.js';
import { seedWaReadMarks, startWhatsApp, stopWhatsApp } from './whatsapp.js';
import { refreshBackupInfo, setBackupLogger } from './wabackup.js';
import { clearUploads } from './uploads.js';
import { videoChip } from './convert.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
const minLevel = LEVELS[(config.logLevel as keyof typeof LEVELS) ?? 'info'] ?? 20;
function log(level: keyof typeof LEVELS, msg: string) {
  if (LEVELS[level] < minLevel) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

if (!config.password || config.password.length < 8) {
  log('error', 'APP_PASSWORD must be set (at least 8 characters). Refusing to start without a password.');
  process.exit(1);
}

const router = buildRouter(log);
clearUploads(); // half-finished uploads from before a restart can't be finished
void videoChip((m) => log('info', m)); // checked once at start, so the log says which is used

// ---------- static web UI ----------
const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = [process.env.WEB_DIST, path.resolve(here, '../../web/dist'), path.resolve(here, '../public')].find(
  (p): p is string => !!p && fs.existsSync(path.join(p, 'index.html')),
);
if (!webDist) log('warn', 'web UI build not found — only the API is served');

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!webDist || (req.method !== 'GET' && req.method !== 'HEAD')) return sendJson(res, 404, { error: 'Not found' });
  let urlPath: string;
  try {
    urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname);
  } catch {
    return sendJson(res, 400, { error: 'Bad address' });
  }
  let file = path.join(webDist, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(webDist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (urlPath.startsWith('/api/') || path.extname(urlPath)) return sendJson(res, 404, { error: 'Not found' });
    file = path.join(webDist, 'index.html'); // SPA fallback
  }
  const isIndex = file.endsWith('index.html');
  const headers: Record<string, string> = {
    'content-type': STATIC_MIME[path.extname(file)] ?? 'application/octet-stream',
    // Emoji files never change under the same name; a new set gets new names.
    'cache-control': isIndex ? 'no-cache' : urlPath.startsWith('/assets/') || urlPath.startsWith('/emoji/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    vary: 'accept-encoding',
  };
  // Pre-compressed copies made at build time (the emoji font is 5 MB, 2.4 MB compressed).
  const accept = String(req.headers['accept-encoding'] ?? '');
  if (/\bbr\b/.test(accept) && fs.existsSync(file + '.br')) {
    headers['content-encoding'] = 'br';
    file += '.br';
  }
  sendFile(res, file, headers, req.method === 'HEAD');
}

const handler: http.RequestListener = async (req, res) => {
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader(
    'content-security-policy',
    "default-src 'self'; img-src 'self' blob: data: https://*.giphy.com; media-src 'self' blob: https://*.giphy.com; style-src 'self' 'unsafe-inline'; connect-src 'self' https://api.giphy.com https://*.giphy.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  try {
    if (!(await router.handle(req, res))) serveStatic(req, res);
  } catch (e) {
    log('error', `unhandled: ${(e as Error).stack}`);
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
  }
};

let tls: { cert: Buffer; key: Buffer } | null = null;
if (config.tlsCertFile || config.tlsKeyFile) {
  try {
    tls = { cert: fs.readFileSync(config.tlsCertFile ?? ''), key: fs.readFileSync(config.tlsKeyFile ?? '') };
  } catch (e) {
    log('error', `TLS_CERT_FILE and TLS_KEY_FILE must both point to readable PEM files: ${(e as Error).message}`);
    process.exit(1);
  }
}
const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
server.requestTimeout = 2 * 3600_000; // large uploads (a WhatsApp backup can be gigabytes)
server.keepAliveTimeout = 65_000;

setTimeout(() => {
  try {
    if (kvGet('fix_group_read_v1') !== 'done') {
      const n = recomputeGroupReadStatuses();
      kvSet('fix_group_read_v1', 'done');
      if (n) log('info', `ticks: ${n} group messages no longer show as read (not everyone has read them)`);
    }
  } catch (e) {
    log('warn', `tick fix failed: ${(e as Error).message}`);
  }
  // One-off fixes for older data: once each (with a big history they take a while).
  try {
    if (kvGet('ext_raw_v1') !== 'done') {
      const n = backfillExtRaw();
      kvSet('ext_raw_v1', 'done');
      if (n) log('info', `indexed ${n} WhatsApp message ids`);
    }
  } catch (e) {
    log('warn', `id backfill failed: ${(e as Error).message}`);
  }
  try {
    if (!kvGet('wa_preview_text_v1')) {
      const fixed = cleanPreviewText();
      kvSet('wa_preview_text_v1', '1');
      if (fixed) log('info', `replies showing a photo's preview data as text: fixed ${fixed}`);
    }
    const seeded = seedWaReadMarks();
    if (seeded) log('info', `noted what's read in ${seeded} WhatsApp chats (old messages coming in again stay read)`);
  } catch (e) {
    log('warn', `noting read chats failed: ${(e as Error).message}`);
  }
  try {
    if (kvGet('wa_dupes_v1') !== 'done') {
      const n = removeDuplicateWaMessages();
      kvSet('wa_dupes_v1', 'done');
      if (n) log('info', `removed ${n} WhatsApp messages that were stored twice`);
    }
  } catch (e) {
    log('warn', `duplicate clean-up failed: ${(e as Error).message}`);
  }
  try {
    if (kvGet('gif_backfill_v1') !== 'done') {
      backfillGifFlags();
      kvSet('gif_backfill_v1', 'done'); // later videos get their flag when they're downloaded
    }
  } catch (e) {
    log('warn', `GIF backfill failed: ${(e as Error).message}`);
  }
}, 2000);

startExpiry((m) => log('info', m));

startWhatsApp({
  info: (m) => log('info', m),
  warn: (m) => log('warn', m),
  debug: (m) => log('debug', m),
});

setBackupLogger({ info: (m) => log('info', m), warn: (m) => log('warn', m) });
try {
  refreshBackupInfo();
} catch {
  /* no backup folder */
}

startSignal({
  info: (m) => log('info', m),
  warn: (m) => log('warn', m),
  error: (m) => log('error', m),
  debug: (m) => log('debug', m),
});

server.listen(config.port, config.host, () =>
  log('info', `Messenger Web listening on ${tls ? 'https' : 'http'}://${config.host}:${config.port}`),
);

const shutdown = () => {
  log('info', 'shutting down');
  stopSignal();
  stopExpiry();
  stopWhatsApp();
  server.close();
  server.closeAllConnections();
  db.close();
  process.exit(0);
};
// A forgotten .catch() somewhere shouldn't take the whole server down (Node exits on these by default).
process.on('unhandledRejection', (e) => log('error', `unhandled error (kept running): ${(e as Error)?.stack ?? String(e)}`));
process.on('uncaughtException', (e) => log('error', `uncaught exception (kept running): ${e.stack ?? String(e)}`));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
