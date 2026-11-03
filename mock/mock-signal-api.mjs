#!/usr/bin/env node
/**
 * A fake signal-cli-rest-api (json-rpc mode) for developing Signal Web without a phone.
 * Zero dependencies.  Usage:  node mock/mock-signal-api.mjs   (listens on :8080)
 *
 *   MOCK_PORT=8080      port to listen on
 *   MOCK_LINKED=1       start already linked (otherwise the QR code "links" 4s after it's fetched)
 *
 * Extra endpoints for poking it:
 *   POST /mock/incoming {"from":"alice","text":"hi"}           incoming direct message (alice|bob|carol)
 *   POST /mock/incoming {"from":"bob","text":"hi","group":true} incoming group message
 *   GET  /mock/sent                                             everything Signal Web sent
 */
import crypto from 'node:crypto';
import http from 'node:http';
import zlib from 'node:zlib';

const PORT = Number(process.env.MOCK_PORT ?? 8080);
const SELF = { number: '+31600000001', uuid: '00000000-0000-4000-8000-000000000001' };
const PEOPLE = {
  alice: { number: '+31611111111', uuid: 'aaaaaaaa-0000-4000-8000-00000000000a', name: 'Alice de Vries', profile: 'Alice' },
  bob: { number: '+31622222222', uuid: 'bbbbbbbb-0000-4000-8000-00000000000b', name: 'Bob Jansen', profile: 'Bobby' },
  carol: { number: '+31633333333', uuid: 'cccccccc-0000-4000-8000-00000000000c', name: '', profile: 'Carol' },
};
const GROUP = { internal_id: 'bW9ja2dyb3VwaWQxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=', name: 'Weekend plans' };
const GROUP_REST_ID = 'group.' + Buffer.from(GROUP.internal_id).toString('base64');

let linked = process.env.MOCK_LINKED === '1';
const sockets = new Set();
const sent = [];
let seeded = false;

// ---------- tiny PNG generator ----------
function crc32(buf) {
  let c,
    crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const qrSeed = crypto.randomBytes(64);
const QR = png(232, 232, (x, y) => {
  const cx = Math.floor((x - 12) / 8), cy = Math.floor((y - 12) / 8);
  if (x < 12 || y < 12 || cx > 25 || cy > 25) return [255, 255, 255];
  const finder = (a, b) => cx >= a && cx < a + 7 && cy >= b && cy < b + 7 && (cx === a || cx === a + 6 || cy === b || cy === b + 6 || (cx >= a + 2 && cx <= a + 4 && cy >= b + 2 && cy <= b + 4));
  if ([[0, 0], [19, 0], [0, 19]].some(([a, b]) => cx >= a && cx < a + 7 && cy >= b && cy < b + 7)) return finder(0, 0) || finder(19, 0) || finder(0, 19) ? [0, 0, 0] : [255, 255, 255];
  return (qrSeed[(cx * 26 + cy) % 64] >> (cx % 8)) & 1 ? [0, 0, 0] : [255, 255, 255];
});
const PHOTO = png(640, 420, (x, y) => {
  const sky = y < 260;
  if (Math.hypot(x - 470, y - 110) < 50) return [255, 214, 120];
  if (!sky) return [40 + (y % 7), 110 + ((x * y) % 30), 70];
  return [90 + y / 4, 150 + y / 6, 230];
});

// ---------- minimal websocket server (server → client text frames only) ----------
function wsAccept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sockets.add(socket);
  socket.on('data', (buf) => {
    const op = buf[0] & 0x0f;
    if (op === 0x8) socket.end(Buffer.from([0x88, 0]));
  });
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => sockets.delete(socket));
}
function wsSend(socket, text) {
  const payload = Buffer.from(text);
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}
function push(envelope) {
  const msg = JSON.stringify({ envelope, account: SELF.number });
  for (const s of sockets) wsSend(s, msg);
}

// ---------- envelope builders ----------
const from = (p) => ({ source: p.number, sourceNumber: p.number, sourceUuid: p.uuid, sourceName: p.profile, sourceDevice: 1 });
function incoming(p, text, opts = {}) {
  const ts = opts.ts ?? Date.now();
  push({
    ...from(p),
    timestamp: ts,
    dataMessage: {
      timestamp: ts,
      message: text,
      expiresInSeconds: 0,
      viewOnce: false,
      ...(opts.group ? { groupInfo: { groupId: GROUP.internal_id, groupName: GROUP.name, type: 'DELIVER' } } : {}),
      ...(opts.attachments ? { attachments: opts.attachments } : {}),
      ...(opts.quote ? { quote: opts.quote } : {}),
      ...(opts.reaction ? { reaction: opts.reaction, message: undefined } : {}),
    },
  });
  return ts;
}
function typing(p, started, group) {
  push({ ...from(p), timestamp: Date.now(), typingMessage: { action: started ? 'STARTED' : 'STOPPED', timestamp: Date.now(), ...(group ? { groupId: GROUP.internal_id } : {}) } });
}
function receipt(p, ts, kind) {
  push({ ...from(p), timestamp: Date.now(), receiptMessage: { when: Date.now(), isDelivery: kind === 'delivery', isRead: kind === 'read', isViewed: false, timestamps: [ts] } });
}
function syncSent(toP, text, ts) {
  push({
    source: SELF.number, sourceNumber: SELF.number, sourceUuid: SELF.uuid, sourceName: 'Me', sourceDevice: 1, timestamp: ts,
    syncMessage: { sentMessage: { destination: toP.number, destinationNumber: toP.number, destinationUuid: toP.uuid, timestamp: ts, message: text, expiresInSeconds: 0, viewOnce: false } },
  });
}

function seed() {
  if (seeded) return;
  seeded = true;
  const now = Date.now();
  const H = 3600_000;
  const t1 = incoming(PEOPLE.alice, 'Hey! Are we still on for Saturday?', { ts: now - 26 * H });
  syncSent(PEOPLE.alice, 'Yes! 10am at the market?', now - 25.9 * H);
  incoming(PEOPLE.alice, 'Perfect 👌', { ts: now - 25.8 * H, quote: { id: now - 25.9 * H, author: SELF.number, authorNumber: SELF.number, authorUuid: SELF.uuid, text: 'Yes! 10am at the market?' } });
  incoming(PEOPLE.alice, '', { ts: now - 2 * H, attachments: [{ contentType: 'image/png', filename: 'view.png', id: 'mockphoto1.png', size: PHOTO.length, width: 640, height: 420 }] });
  incoming(PEOPLE.alice, 'View from the hike this morning', { ts: now - 2 * H + 1000 });
  incoming(PEOPLE.bob, 'Who is bringing snacks? 🍿', { ts: now - 5 * H, group: true });
  incoming(PEOPLE.carol, 'I can do snacks', { ts: now - 4.5 * H, group: true });
  incoming(PEOPLE.bob, '', { ts: now - 4.4 * H, group: true, reaction: { emoji: '🙏', targetAuthor: PEOPLE.carol.number, targetAuthorNumber: PEOPLE.carol.number, targetAuthorUuid: PEOPLE.carol.uuid, targetSentTimestamp: now - 4.5 * H, isRemove: false } });
  incoming(PEOPLE.carol, 'Did you get my email about the invoice?', { ts: now - 40 * 60_000 });
  void t1;
}

// ---------- http ----------
function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(data === undefined ? '' : JSON.stringify(data));
}
async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString();
  return s ? JSON.parse(s) : {};
}
function personFor(recipient) {
  return Object.values(PEOPLE).find((p) => p.number === recipient || p.uuid === recipient);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = req.method;
  try {
    if (p === '/v1/about') return json(res, 200, { versions: ['v1', 'v2'], build: 2, mode: 'json-rpc', version: '0.0.0-mock', capabilities: {} });
    if (p === '/v1/accounts') return json(res, 200, linked ? [SELF.number] : []);
    if (p === '/v1/qrcodelink') {
      setTimeout(() => (linked = true), 4000);
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(QR);
    }
    if (p.startsWith('/v1/contacts/'))
      return json(res, 200, Object.values(PEOPLE).map((x) => ({ number: x.number, uuid: x.uuid, name: x.name, profile_name: x.profile, username: '', blocked: false, given_name: '', profile: { given_name: x.profile, lastname: '' }, nickname: { name: '', given_name: '', family_name: '' } })));
    if (p.startsWith('/v1/groups/'))
      return json(res, 200, [{ name: GROUP.name, description: '', id: GROUP_REST_ID, internal_id: GROUP.internal_id, members: [SELF.number, PEOPLE.alice.number, PEOPLE.bob.number, PEOPLE.carol.number], blocked: false, member: true, admins: [] }]);
    if (p.startsWith('/v1/attachments/')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PHOTO);
    }
    if (p === '/v2/send' && m === 'POST') {
      const b = await body(req);
      const ts = Date.now();
      sent.push({ ...b, base64_attachments: b.base64_attachments?.map((a) => a.slice(0, 60) + '…'), ts });
      if (String(b.message).includes('fail')) return json(res, 400, { error: 'Mock failure: recipient unreachable' });
      const recipient = b.recipients?.[0];
      const person = personFor(recipient);
      const isGroup = recipient === GROUP_REST_ID;
      setTimeout(() => (person ? receipt(person, ts, 'delivery') : isGroup && receipt(PEOPLE.bob, ts, 'delivery')), 700);
      setTimeout(() => (person ? receipt(person, ts, 'read') : isGroup && receipt(PEOPLE.carol, ts, 'read')), 2500);
      const replier = person ?? (isGroup ? PEOPLE.bob : null);
      if (replier) {
        setTimeout(() => typing(replier, true, isGroup), 3000);
        setTimeout(() => {
          typing(replier, false, isGroup);
          incoming(replier, `Got it: “${String(b.message || 'your attachment').slice(0, 40)}”`, { group: isGroup });
        }, 5500);
      }
      return json(res, 201, { timestamp: String(ts) });
    }
    if (p.startsWith('/v1/reactions/') || p.startsWith('/v1/receipts/') || p.startsWith('/v1/typing-indicator/')) {
      const b = m === 'GET' ? {} : await body(req);
      sent.push({ path: p, method: m, ...b });
      return json(res, 204);
    }
    if (p.startsWith('/v1/remote-delete/')) {
      const b = await body(req);
      sent.push({ path: p, method: m, ...b });
      return json(res, 201, { timestamp: String(Date.now()) });
    }
    if (p === '/mock/sent') return json(res, 200, sent);
    if (p === '/mock/incoming' && m === 'POST') {
      const b = await body(req);
      const person = PEOPLE[b.from ?? 'alice'];
      return json(res, 200, { timestamp: incoming(person, b.text ?? 'Hello!', { group: !!b.group }) });
    }
    json(res, 404, { error: 'mock: not implemented ' + m + ' ' + p });
  } catch (e) {
    json(res, 500, { error: String(e) });
  }
});

server.on('upgrade', (req, socket) => {
  if (!req.url.startsWith('/v1/receive/')) return socket.destroy();
  wsAccept(req, socket);
  setTimeout(seed, 300);
});

server.listen(PORT, () => console.log(`mock signal-cli-rest-api on http://localhost:${PORT} (linked: ${linked})`));
