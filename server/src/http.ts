/** Minimal HTTP router on top of node:http — just what Signal Web needs. */
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

export interface Ctx<B = any> {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: B;
  ip: string;
  cookies: Record<string, string>;
  status: number;
}

export type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  auth: boolean;
  handler: Handler;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        out[k] = part.slice(i + 1).trim();
      }
    }
  }
  return out;
}

export function setCookie(
  res: ServerResponse,
  name: string,
  value: string,
  opts: { expires?: Date; httpOnly?: boolean; secure?: boolean; sameSite?: 'Strict' | 'Lax'; path?: string },
) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? '/'}`];
  if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  const prev = res.getHeader('set-cookie');
  res.setHeader('set-cookie', [...(Array.isArray(prev) ? prev : prev ? [String(prev)] : []), parts.join('; ')]);
}

async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const type = req.headers['content-type'] ?? '';
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Request too large');
    chunks.push(chunk as Buffer);
  }
  if (!size) return undefined;
  // Only JSON bodies are accepted. This also blocks cross-site form posts (CSRF).
  if (!type.startsWith('application/json')) throw new HttpError(415, 'Expected application/json');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

/**
 * Send a file without ever crashing the process: the file is opened before the headers go out (so a
 * file deleted mid-request becomes a 404), and read errors just end the response.
 */
export function sendFile(res: ServerResponse, file: string, headers: Record<string, string | number>, headOnly = false) {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    if (!res.headersSent) sendJson(res, 404, { error: 'Not found' });
    else res.end();
    return;
  }
  const size = fs.fstatSync(fd).size;
  res.writeHead(200, { ...headers, 'content-length': size });
  if (headOnly) {
    fs.closeSync(fd);
    return res.end();
  }
  const stream = fs.createReadStream('', { fd });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

export function sendJson(res: ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

export class Router {
  private routes: Route[] = [];

  constructor(
    private opts: {
      bodyLimit: number;
      isAuthed: (ctx: Ctx) => boolean;
      log: (level: 'info' | 'warn' | 'error', msg: string) => void;
      trustProxy: boolean;
    },
  ) {}

  add(method: string, path: string, handler: Handler, auth = true) {
    const keys: string[] = [];
    const re = new RegExp(
      '^' +
        path.replace(/:(\w+)/g, (_m, k) => {
          keys.push(k);
          return '([^/]+)';
        }) +
        '/?$',
    );
    this.routes.push({ method, re, keys, auth, handler });
  }
  get(p: string, h: Handler, auth = true) {
    this.add('GET', p, h, auth);
  }
  post(p: string, h: Handler, auth = true) {
    this.add('POST', p, h, auth);
  }
  delete(p: string, h: Handler, auth = true) {
    this.add('DELETE', p, h, auth);
  }

  /** Returns false when no route matched (so the caller can serve static files). */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://local');
    const pathMatches = this.routes.filter((r) => r.re.test(url.pathname));
    if (!pathMatches.length) return false;
    const route = pathMatches.find((r) => r.method === req.method || (req.method === 'HEAD' && r.method === 'GET'));
    if (!route) {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }
    const m = url.pathname.match(route.re)!;
    const params: Record<string, string> = {};
    route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    const fwd = this.opts.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
    const ctx: Ctx = {
      req,
      res,
      params,
      query: url.searchParams,
      body: undefined,
      ip: fwd || req.socket.remoteAddress || 'unknown',
      cookies: parseCookies(req.headers.cookie),
      status: 200,
    };
    try {
      if (route.auth && !this.opts.isAuthed(ctx)) throw new HttpError(401, 'Not logged in');
      ctx.body = await readBody(req, this.opts.bodyLimit);
      const result = await route.handler(ctx);
      if (res.writableEnded || res.headersSent) return true;
      if (Buffer.isBuffer(result)) {
        res.statusCode = ctx.status;
        res.end(result);
      } else {
        sendJson(res, ctx.status, result ?? { ok: true });
      }
    } catch (e) {
      const status = (e as HttpError).statusCode ?? 500;
      if (status >= 500) this.opts.log('error', `${req.method} ${url.pathname}: ${(e as Error).stack ?? e}`);
      if (!res.headersSent) sendJson(res, status, { error: (e as Error).message });
      else res.end();
    }
    return true;
  }
}
