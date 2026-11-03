import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { db, kvGet, kvSet } from './db.js';
import { sendFile, sendJson } from './http.js';
import { backfillGifFlags } from './ingest.js';
import { buildRouter } from './routes.js';
import { recomputeGroupReadStatuses } from './store.js';
import { startSignal, stopSignal } from './signal.js';

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
  '.map': 'application/json',
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!webDist || (req.method !== 'GET' && req.method !== 'HEAD')) return sendJson(res, 404, { error: 'Not found' });
  const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname);
  let file = path.join(webDist, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(webDist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (urlPath.startsWith('/api/') || path.extname(urlPath)) return sendJson(res, 404, { error: 'Not found' });
    file = path.join(webDist, 'index.html'); // SPA fallback
  }
  const isIndex = file.endsWith('index.html');
  sendFile(
    res,
    file,
    {
      'content-type': STATIC_MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': isIndex ? 'no-cache' : urlPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    },
    req.method === 'HEAD',
  );
}

const server = http.createServer(async (req, res) => {
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
});
server.requestTimeout = 10 * 60_000; // large uploads
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
  try {
    backfillGifFlags();
  } catch (e) {
    log('warn', `GIF backfill failed: ${(e as Error).message}`);
  }
}, 2000);

startSignal({
  info: (m) => log('info', m),
  warn: (m) => log('warn', m),
  error: (m) => log('error', m),
  debug: (m) => log('debug', m),
});

server.listen(config.port, config.host, () => log('info', `Signal Web listening on http://${config.host}:${config.port}`));

const shutdown = () => {
  log('info', 'shutting down');
  stopSignal();
  server.close();
  server.closeAllConnections();
  db.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
