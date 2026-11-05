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
 *   POST /mock/receipt {"from":"alice","ts":<sent ts>,"kind":"read"}  a delivery/read receipt
 *   POST /mock/incoming {..., "extra": {dataMessage fields}}    e.g. textStyles, mentions, previews, expiresInSeconds
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const GIF_MP4 = fs.readFileSync(path.join(FIXTURES, 'gif.mp4')); // no sound track → shown as a GIF
const CLIP_MP4 = fs.readFileSync(path.join(FIXTURES, 'clip.mp4')); // has sound → normal video

const PORT = Number(process.env.MOCK_PORT ?? 8080);
const SELF = { number: '+31600000001', uuid: '00000000-0000-4000-8000-000000000001' };
const PEOPLE = {
  alice: { number: '+31611111111', uuid: 'aaaaaaaa-0000-4000-8000-00000000000a', name: 'Alice de Vries', profile: 'Alice' },
  bob: { number: '+31622222222', uuid: 'bbbbbbbb-0000-4000-8000-00000000000b', name: 'Bob Jansen', profile: 'Bobby' },
  carol: { number: '+31633333333', uuid: 'cccccccc-0000-4000-8000-00000000000c', name: '', profile: 'Carol' },
};
// Group members who aren't in your address book: one with a profile name, one Signal knows nothing about.
const DAVE = { number: '', uuid: 'dddddddd-0000-4000-8000-00000000000d', profile: 'Dave Bakker' };
const STRANGER_UUID = 'eeeeeeee-0000-4000-8000-00000000000e';
const GROUP = {
  internal_id: 'bW9ja2dyb3VwaWQxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=',
  name: 'Weekend plans',
  description: 'Planning for Saturday at the market.\n\nBirthdays:\n3 jan Alice\n12 feb Bob\n24 mar Carol\n9 apr Dave\n17 jun You',
};
const SEND_DELAY_MS = 1200; // like a real group send: receipts start arriving before it returns
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
const AVATAR_ALICE = png(96, 96, (x, y) => (Math.hypot(x - 48, y - 40) < 22 ? [250, 210, 180] : y > 70 ? [60, 90, 160] : [230, 120, 90]));
let selfProfile = { given: 'Wouter', family: 'Tester', about: 'Testing Signal Web' };
let selfAvatar = null; // like Signal: a profile update without a picture removes it
let groupAvatar = null;
const AVATAR_GROUP = png(96, 96, (x, y) => ((Math.floor(x / 24) + Math.floor(y / 24)) % 2 ? [255, 190, 60] : [70, 160, 120]));
// ---------- sticker packs, encrypted exactly like Signal's CDN serves them ----------
function varint(n) {
  const out = [];
  while (n > 127) {
    out.push((n & 127) | 128);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}
const pbField = (num, buf) => Buffer.concat([varint((num << 3) | 2), varint(buf.length), buf]);
const pbVarint = (num, n) => Buffer.concat([varint(num << 3), varint(n)]);
const pbSticker = (id, emoji) => Buffer.concat([pbVarint(1, id), pbField(2, Buffer.from(emoji))]);
function stickerEncrypt(plain, packKeyHex) {
  const keys = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(packKeyHex, 'hex'), Buffer.alloc(32), Buffer.from('Sticker Pack'), 64));
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-256-cbc', keys.subarray(0, 32), iv);
  const body = Buffer.concat([iv, c.update(plain), c.final()]);
  return Buffer.concat([body, crypto.createHmac('sha256', keys.subarray(32)).update(body).digest()]);
}
function stickerFace(hue, mood) {
  const [r, g, b] = [Math.round(128 + 120 * Math.cos(hue)), Math.round(128 + 120 * Math.cos(hue + 2.1)), Math.round(128 + 120 * Math.cos(hue + 4.2))];
  return png(160, 160, (x, y) => {
    const d = Math.hypot(x - 80, y - 80);
    if (d > 70) return [255, 255, 255];
    if (d > 64) return [40, 40, 60];
    if (Math.hypot(x - 56, y - 64) < 9 || Math.hypot(x - 104, y - 64) < 9) return [40, 40, 60];
    const smile = mood === 'happy' ? Math.abs(Math.hypot(x - 80, y - 82) - 34) < 4 && y > 92 : Math.abs(Math.hypot(x - 80, y - 140) - 34) < 4 && y < 112 && y > 100;
    if (smile) return [40, 40, 60];
    return [r, g, b];
  });
}
const STICKER_PACKS = [
  { id: '0123456789abcdef0123456789abcdef', key: 'a'.repeat(64), title: 'Blob faces', author: 'Signal Web mock', installed: true,
    stickers: [[0, '😀', 0.2, 'happy'], [1, '😢', 3.6, 'sad'], [2, '🥳', 1.4, 'happy'], [3, '😡', 0.0, 'sad'], [4, '😎', 4.8, 'happy'], [5, '🙃', 2.4, 'happy']] },
  { id: 'fedcba9876543210fedcba9876543210', key: 'b'.repeat(64), title: 'Moods', author: 'Mock artist', installed: false,
    stickers: [[0, '😴', 5.5, 'sad'], [1, '🤩', 1.0, 'happy'], [2, '😬', 3.0, 'sad']] },
];
const EXTRA_PACK = { id: '00112233445566778899aabbccddeeff', key: 'c'.repeat(64), title: 'Added from a link', author: 'signalstickers.org', installed: true,
  stickers: [[0, '👍', 2.0, 'happy'], [1, '🎉', 0.7, 'happy']] };
const knownPacks = [...STICKER_PACKS];
function manifestFor(pack) {
  return Buffer.concat([
    pbField(1, Buffer.from(pack.title)),
    pbField(2, Buffer.from(pack.author)),
    pbField(3, pbSticker(pack.stickers[0][0], pack.stickers[0][1])),
    ...pack.stickers.map(([id, emoji]) => pbField(4, pbSticker(id, emoji))),
  ]);
}

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
const from = (p) => ({ source: p.number || p.uuid, sourceNumber: p.number || null, sourceUuid: p.uuid, sourceName: p.profile, sourceDevice: 1 });
const timers = {}; // disappearing-message timer per chat ('group' or a number), set via PUT
// Signal uses the timestamp as a message's id, so two messages from one sender never share one.
let lastTs = 0;
function incoming(p, text, opts = {}) {
  const ts = opts.ts ?? (lastTs = Math.max(Date.now(), lastTs + 1));
  const timer = timers[opts.group ? 'group' : p.number] ?? 0;
  push({
    ...from(p),
    timestamp: ts,
    dataMessage: {
      timestamp: ts,
      message: text,
      expiresInSeconds: timer,
      viewOnce: false,
      ...(opts.group ? { groupInfo: { groupId: GROUP.internal_id, groupName: GROUP.name, type: 'DELIVER' } } : {}),
      ...(opts.attachments ? { attachments: opts.attachments } : {}),
      ...(opts.quote ? { quote: opts.quote } : {}),
      ...(opts.reaction ? { reaction: opts.reaction, message: undefined } : {}),
      ...(opts.extra ?? {}),
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
  // signal-cli puts the phone number in the mention's "name" field
  push({
    ...from(PEOPLE.carol),
    timestamp: now - 30 * 60_000,
    dataMessage: {
      timestamp: now - 30 * 60_000,
      message: 'De overstap naar signal nadert \uFFFC 🤩',
      mentions: [{ name: PEOPLE.bob.number, number: PEOPLE.bob.number, uuid: PEOPLE.bob.uuid, start: 31, length: 1 }],
      groupInfo: { groupId: GROUP.internal_id, groupName: GROUP.name, type: 'DELIVER' },
    },
  });
  push({ ...from(PEOPLE.alice), timestamp: now - 90 * 60_000, dataMessage: { timestamp: now - 90 * 60_000, sticker: { packId: STICKER_PACKS[1].id, stickerId: 1 } } });
  incoming(PEOPLE.bob, '', { ts: now - 29 * 60_000, group: true, attachments: [{ contentType: 'video/mp4', filename: null, id: 'mockgif1.mp4', size: GIF_MP4.length, width: 240, height: 180 }] });
  push({ source: DAVE.uuid, sourceUuid: DAVE.uuid, sourceName: DAVE.profile, sourceDevice: 1, timestamp: now - 28 * 60_000,
    dataMessage: { timestamp: now - 28 * 60_000, message: 'Haha 😂 and here is the video from last time', groupInfo: { groupId: GROUP.internal_id, groupName: GROUP.name, type: 'DELIVER' },
      attachments: [{ contentType: 'video/mp4', filename: 'clip.mp4', id: 'mockclip1.mp4', size: CLIP_MP4.length, width: 160, height: 120 }] } });
  incoming(PEOPLE.alice, 'This is bold, this is italic and this is a secret', {
    ts: now - 80 * 60_000,
    extra: { textStyles: [{ style: 'BOLD', start: 8, length: 4 }, { style: 'ITALIC', start: 22, length: 6 }, { style: 'SPOILER', start: 43, length: 6 }] },
  });
  incoming(PEOPLE.carol, 'Look at this https://example.org/trail-guide', {
    ts: now - 35 * 60_000,
    extra: { previews: [{ url: 'https://example.org/trail-guide', title: 'The best trails near the market', description: 'Ten walks of under two hours, with maps and where to get coffee after.', image: { contentType: 'image/png', filename: null, id: 'mockpreview1.png', size: PHOTO.length, width: 640, height: 420 } }] },
  });
  const pollTs = now - 20 * 60_000;
  incoming(PEOPLE.bob, '', { ts: pollTs, group: true, extra: { message: null, pollCreate: { question: 'Where do we meet?', allowMultiple: false, options: ['Market', 'Station', 'Café Noord'] } } });
  incoming(PEOPLE.carol, '', { ts: pollTs + 60_000, group: true, extra: { message: null, pollVote: { authorNumber: PEOPLE.bob.number, authorUuid: PEOPLE.bob.uuid, targetSentTimestamp: pollTs, optionIndexes: [2], voteCount: 1 } } });
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
    const avatarMatch = p.match(/^\/v1\/(contacts|groups)\/[^/]+\/([^/]+)\/avatar$/);
    if (avatarMatch) {
      const id = decodeURIComponent(avatarMatch[2]);
      const img =
        avatarMatch[1] === 'groups'
          ? id === GROUP_REST_ID ? groupAvatar ?? AVATAR_GROUP : null
          : id === PEOPLE.alice.uuid ? AVATAR_ALICE : id === SELF.uuid || id === SELF.number ? selfAvatar : null;
      if (!img) return json(res, 404, { error: 'No avatar found.' });
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(img);
    }
    if (p.startsWith('/v1/sticker-packs/')) {
      if (m === 'POST') {
        const b = await body(req);
        if (b.pack_id !== EXTRA_PACK.id || b.pack_key !== EXTRA_PACK.key) return json(res, 400, { error: 'Unknown sticker pack' });
        if (!knownPacks.includes(EXTRA_PACK)) knownPacks.push(EXTRA_PACK);
        return json(res, 204);
      }
      return json(res, 200, knownPacks.map((x) => ({ pack_id: x.id, url: `https://signal.art/addstickers/#pack_id=${x.id}&pack_key=${x.key}`, installed: x.installed, title: x.title, author: x.author })));
    }
    const cdn = p.match(/^\/stickers\/([0-9a-f]{32})\/(manifest\.proto|full\/(\d+))$/);
    if (cdn) {
      const pack = [...STICKER_PACKS, EXTRA_PACK].find((x) => x.id === cdn[1]);
      if (!pack) return json(res, 404, { error: 'no such pack' });
      let plain;
      if (cdn[2] === 'manifest.proto') plain = manifestFor(pack);
      else {
        const st = pack.stickers.find(([id]) => id === Number(cdn[3]));
        if (!st) return json(res, 404, { error: 'no such sticker' });
        plain = stickerFace(st[2], st[3]);
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(stickerEncrypt(plain, pack.key));
    }
    if (p.startsWith('/v1/contacts/') && m === 'PUT') {
      const b = await body(req);
      if (b.expiration_in_seconds) timers[b.recipient] = b.expiration_in_seconds;
      sent.push({ path: p, method: m, ...b });
      return json(res, 204);
    }
    if (p.startsWith('/v1/attachments/') && m === 'DELETE') {
      sent.push({ path: p, method: m });
      return json(res, 204);
    }
    if (p.startsWith('/v1/contacts/')) {
      const all = url.searchParams.get('all_recipients') === 'true';
      const list = Object.values(PEOPLE).map((x) => ({ number: x.number, uuid: x.uuid, name: x.name, profile_name: x.profile, username: '', blocked: false, given_name: '',
        profile: { given_name: x.profile, lastname: '', about: x === PEOPLE.alice ? 'Hiking whenever I can 🥾' : '', has_avatar: x === PEOPLE.alice }, nickname: { name: '', given_name: '', family_name: '' } }));
      if (all) list.push({ number: SELF.number, uuid: SELF.uuid, name: '', profile_name: `${selfProfile.given} ${selfProfile.family}`, username: '', blocked: false, given_name: selfProfile.given,
        profile: { given_name: selfProfile.given, lastname: selfProfile.family, about: selfProfile.about, has_avatar: !!selfAvatar }, nickname: {} });
      if (all) list.push({ number: '', uuid: DAVE.uuid, name: '', profile_name: DAVE.profile, username: '', blocked: false, given_name: '', profile: { given_name: 'Dave', lastname: 'Bakker', about: '', has_avatar: false }, nickname: {} });
      return json(res, 200, list);
    }
    if (p.startsWith('/v1/profiles/') && m === 'PUT') {
      const b = await body(req);
      if (!b.name) return json(res, 400, { error: "Couldn't process request - profile name missing" });
      selfProfile = { ...selfProfile, given: b.name, about: b.about ?? selfProfile.about };
      selfAvatar = b.base64_avatar ? Buffer.from(b.base64_avatar, 'base64') : null;
      sent.push({ path: p, method: m, name: b.name, about: b.about, avatarBytes: selfAvatar?.length ?? 0 });
      return json(res, 204);
    }
    if (p.startsWith('/v1/groups/') && m === 'PUT') {
      const b = await body(req);
      if (b.base64_avatar) groupAvatar = Buffer.from(b.base64_avatar, 'base64');
      if (b.expiration_time) timers.group = b.expiration_time;
      sent.push({ path: p, method: m, avatarBytes: b.base64_avatar ? groupAvatar.length : 0, expiration_time: b.expiration_time });
      return json(res, 204);
    }
    if (p.startsWith('/v1/groups/'))
      return json(res, 200, [{ name: GROUP.name, description: GROUP.description, id: GROUP_REST_ID, internal_id: GROUP.internal_id,
        members: [SELF.number, PEOPLE.alice.number, PEOPLE.bob.number, PEOPLE.carol.number, DAVE.uuid, STRANGER_UUID], blocked: false, member: true, admins: [SELF.number, PEOPLE.bob.number] }]);
    if (p.startsWith('/v1/attachments/')) {
      const id = decodeURIComponent(p.split('/').pop());
      const [type, body] = id === 'mockgif1.mp4' ? ['video/mp4', GIF_MP4] : id === 'mockclip1.mp4' ? ['video/mp4', CLIP_MP4] : ['image/png', PHOTO];
      res.writeHead(200, { 'content-type': type });
      return res.end(body);
    }
    if (p === '/v2/send' && m === 'POST') {
      const b = await body(req);
      await new Promise((r) => setTimeout(r, 150)); // signal-cli assigns the timestamp a moment after the request
      const ts = Date.now();
      sent.push({ ...b, base64_attachments: b.base64_attachments?.map((a) => a.slice(0, 60) + '…'), ts });
      if (String(b.message).includes('fail')) return json(res, 400, { error: 'Mock failure: recipient unreachable' });
      if (b.edit_timestamp) return json(res, 201, [{ timestamp: String(ts) }]); // edits: no receipts or auto-reply
      const recipient = b.recipients?.[0];
      const person = personFor(recipient);
      const isGroup = recipient === GROUP_REST_ID;
      if (person) {
        setTimeout(() => receipt(person, ts, 'delivery'), 700);
        setTimeout(() => receipt(person, ts, 'read'), 2500);
      } else if (isGroup) {
        // Delivery receipts from everyone, the first ones *before* the send call returns.
        [PEOPLE.alice, PEOPLE.bob, PEOPLE.carol, DAVE].forEach((x, i) => setTimeout(() => receipt(x, ts, 'delivery'), 300 + i * 500));
        setTimeout(() => receipt(PEOPLE.carol, ts, 'read'), 2800);
        setTimeout(() => receipt(PEOPLE.alice, ts, 'read'), 3600);
      }
      const replier = person ?? (isGroup ? PEOPLE.bob : null);
      if (replier) {
        setTimeout(() => typing(replier, true, isGroup), 3000);
        setTimeout(() => {
          typing(replier, false, isGroup);
          incoming(replier, `Got it: “${String(b.message || 'your attachment').slice(0, 40)}”`, { group: isGroup });
        }, 5500);
      }
      if (isGroup) await new Promise((r) => setTimeout(r, SEND_DELAY_MS));
      // signal-cli-rest-api answers with a list since Oct 2026 (one entry per send); MOCK_OLD_SEND=1 for the old shape.
      return json(res, 201, process.env.MOCK_OLD_SEND === '1' ? { timestamp: String(ts) } : [{ timestamp: String(ts) }]);
    }
    if (p.startsWith('/v1/polls/')) {
      const b = await body(req);
      const ts = Date.now();
      sent.push({ path: p, method: m, ...b, ts });
      if (m === 'POST' && !p.endsWith('/vote')) {
        const isGroup = b.recipient === GROUP_REST_ID;
        const voter = isGroup ? PEOPLE.carol : personFor(b.recipient);
        if (voter) setTimeout(() => incoming(voter, '', { group: isGroup, extra: { message: null, pollVote: { authorNumber: SELF.number, authorUuid: SELF.uuid, targetSentTimestamp: ts, optionIndexes: [1], voteCount: 1 } } }), 1500);
        return json(res, 201, { timestamp: String(ts) });
      }
      return json(res, 204);
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
    if (p === '/mock/receipt' && m === 'POST') {
      const b = await body(req); // {"from":"alice","ts":123,"kind":"read"|"delivery"}
      const who = b.from === 'dave' ? DAVE : b.from === 'stranger' ? { number: '', uuid: STRANGER_UUID, profile: '' } : PEOPLE[b.from ?? 'alice'];
      receipt(who, Number(b.ts), b.kind ?? 'read');
      return json(res, 200, { ok: true });
    }
    if (p === '/mock/incoming' && m === 'POST') {
      const b = await body(req);
      const person = b.from === 'dave' ? DAVE : PEOPLE[b.from ?? 'alice'];
      return json(res, 200, { timestamp: incoming(person, b.text ?? 'Hello!', { group: !!b.group, extra: b.extra, ts: b.ts }) });
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
