/**
 * Link previews for messages you send: fetch the page, read its title/description/image (Open Graph
 * tags), the way Signal Desktop does. Only public addresses are fetched, so a pasted link can't make
 * the server talk to things on your own network.
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { config } from './config.js';

export interface FetchedPreview {
  url: string;
  title: string;
  description: string | null;
  image: { data: string; type: string } | null; // base64
}

const PAGE_LIMIT = 768 * 1024;
const IMAGE_LIMIT = 2 * 1024 * 1024;
const TIMEOUT_MS = 6000;
const UA = 'Mozilla/5.0 (compatible; SignalWeb link preview)';

function v4Private(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 0)
  );
}

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return v4Private(ip);
  const x = ip.toLowerCase();
  const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return v4Private(mapped[1]);
  return x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb') || x.startsWith('ff');
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

function safeLookup(hostname: string, options: dns.LookupOptions, cb: LookupCb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err, '');
    const ok = (addrs as dns.LookupAddress[]).filter((a) => config.linkPreviewInsecure || !isPrivateAddress(a.address));
    if (!ok.length) return cb(Object.assign(new Error('Private address'), { code: 'EBLOCKED' }), '');
    if (options.all) cb(null, ok);
    else cb(null, ok[0].address, ok[0].family);
  });
}

interface Got {
  status: number;
  type: string;
  body: Buffer;
  url: string;
}

function getOnce(url: URL, limit: number, accept: string): Promise<Got & { location?: string }> {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && !config.linkPreviewInsecure && isPrivateAddress(host)) return reject(new Error('Private address'));
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      {
        method: 'GET',
        headers: { 'user-agent': UA, accept, 'accept-language': 'en,*;q=0.5' },
        lookup: safeLookup as unknown as typeof dns.lookup,
        timeout: TIMEOUT_MS,
        rejectUnauthorized: !config.linkPreviewInsecure,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ status, type: '', body: Buffer.alloc(0), url: url.href, location: res.headers.location });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > limit) {
            chunks.push(c.subarray(0, Math.max(0, limit - (size - c.length))));
            res.destroy(); // enough: we only need the start of a page; images over the limit are dropped below
            resolve({ status, type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks), url: url.href, location: undefined });
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status, type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks), url: url.href }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    // The timeout above is for silence only; a page that keeps dripping bytes is cut off here.
    const deadline = setTimeout(() => req.destroy(new Error('Timed out')), TIMEOUT_MS * 3);
    req.on('close', () => clearTimeout(deadline));
    req.on('error', reject);
    req.end();
  });
}

async function get(start: string, limit: number, accept: string): Promise<Got & { truncated: boolean }> {
  let url = new URL(start);
  for (let hop = 0; hop < 5; hop++) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Unsupported link');
    const r = await getOnce(url, limit, accept);
    if (r.location) {
      url = new URL(r.location, url);
      continue;
    }
    return { ...r, truncated: r.body.length >= limit };
  }
  throw new Error('Too many redirects');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function clean(s: string | undefined | null, max: number) {
  if (!s) return null;
  const t = decodeEntities(s).replace(/\s+/g, ' ').trim();
  return t ? (t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t) : null;
}

/** Content of <meta property|name="key" content="…"> in either attribute order. */
function meta(html: string, keys: string[]): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = /\b(?:property|name)\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1]?.toLowerCase();
    if (!name || !keys.includes(name)) continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const v = content?.[1] ?? content?.[2] ?? content?.[3];
    if (v) return v;
  }
  return null;
}

function decodeHtml(body: Buffer, type: string): string {
  const charset = /charset=([\w-]+)/i.exec(type)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.toString('latin1', 0, 2048))?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return body.toString('utf8');
  }
}

export function parsePage(html: string, pageUrl: string) {
  const head = html.slice(0, 300_000);
  const title = clean(meta(head, ['og:title', 'twitter:title']) ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1], 200);
  const description = clean(meta(head, ['og:description', 'twitter:description', 'description']), 300);
  const img = meta(head, ['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src']);
  let image: string | null = null;
  if (img) {
    try {
      image = new URL(decodeEntities(img), pageUrl).href;
    } catch {
      /* bad url */
    }
  }
  return { title, description, image };
}

const cache = new Map<string, { at: number; value: FetchedPreview | null }>();
const inflight = new Map<string, Promise<FetchedPreview | null>>();

async function build(url: string): Promise<FetchedPreview | null> {
  const page = await get(url, PAGE_LIMIT, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5');
  if (page.status >= 400 || !/html|xml/i.test(page.type)) return null;
  const { title, description, image } = parsePage(decodeHtml(page.body, page.type), page.url);
  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    /* keep */
  }
  if (!title && !description && !image) return null;
  let picture: FetchedPreview['image'] = null;
  if (image) {
    try {
      const r = await get(image, IMAGE_LIMIT + 1, 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8');
      const type = r.type.split(';')[0].trim().toLowerCase();
      if (r.status < 400 && !r.truncated && /^image\/(jpeg|png|webp|gif)$/.test(type) && r.body.length > 0) picture = { data: r.body.toString('base64'), type };
    } catch {
      /* preview without a picture */
    }
  }
  return { url, title: title || host, description: description && description !== title ? description : null, image: picture };
}

/** Preview for an https link, or null when there's nothing to show. Results are cached for 30 minutes. */
export async function linkPreview(url: string): Promise<FetchedPreview | null> {
  if (!/^https:\/\/[^\s/]+/i.test(url) || url.length > 2000) return null;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.value;
  let p = inflight.get(url);
  if (!p) {
    p = build(url).catch(() => null);
    inflight.set(url, p);
  }
  try {
    const value = await p;
    cache.set(url, { at: Date.now(), value });
    if (cache.size > 300) cache.delete(cache.keys().next().value!);
    return value;
  } finally {
    inflight.delete(url);
  }
}
