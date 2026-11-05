#!/usr/bin/env node
/**
 * A small fake WAHA (WhatsApp HTTP API) for development and tests. No WhatsApp involved.
 * It answers the way WAHA's WEBJS engine does (raw ids in quotes and edits, per-member group acks,
 * typing only for chats you subscribed to, wwebjs-shaped chats and groups).
 *
 *   node mock/mock-waha.mjs            # port 8090, API key "test-waha-key"
 *   MOCK_WA_LINKED=1 …                 # start already linked
 *
 * Test hooks:
 *   POST /mock/incoming {"from":"jan","text":"hi","group":false,"extra":{…}}   incoming message
 *   POST /mock/event {"event":"message.reaction","payload":{…}}                any raw event
 *   GET  /mock/sent                                                             everything Messenger Web sent
 */
import crypto from 'node:crypto';
import http from 'node:http';
import zlib from 'node:zlib';

const PORT = Number(process.env.MOCK_WAHA_PORT ?? 8090);
const KEY = process.env.MOCK_WAHA_KEY ?? 'test-waha-key';
const SESSION = 'default';
const ME = { id: '31600000009@c.us', pushName: 'Wouter', lid: '99999999999999@lid' };
const PEOPLE = {
  jan: { id: '31655500001@c.us', name: 'Jan Bakker', pushname: 'Jan' },
  sanne: { id: '31655500002@c.us', name: null, pushname: 'Sanne' },
  lid: { id: '88888888888888@lid', name: null, pushname: 'Privé Pieter' },
};
const GROUP = { id: '120363000000000001@g.us', name: 'Familie' };
const GROUP2 = { id: '120363000000000002@g.us', name: 'Buren' }; // no history: first seen through a new message

let status = process.env.MOCK_WA_LINKED === '1' ? 'WORKING' : 'SCAN_QR_CODE';
const sent = [];
const sockets = new Set();
const history = new Map(); // chatId → messages

// ---------- tiny PNG ----------
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, pixel) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PHOTO = png(320, 200, (x, y) => (y > 130 ? [40, 140, 70] : [80 + x / 4, 150, 230]));
const AVATAR = png(96, 96, (x, y) => ((x - 48) ** 2 + (y - 40) ** 2 < 500 ? [250, 220, 180] : [37, 211, 102]));
const QR = png(160, 160, (x, y) => ((Math.floor(x / 10) + Math.floor(y / 10)) % 2 ? [0, 0, 0] : [255, 255, 255]));

// ---------- websocket ----------
function wsAccept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => sockets.delete(socket));
  socket.on('data', () => {}); // ignore client frames
}
function wsSend(socket, text) {
  const payload = Buffer.from(text);
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  socket.write(Buffer.concat([header, payload]));
}
function emit(event, payload) {
  const msg = JSON.stringify({ id: crypto.randomUUID(), timestamp: Date.now(), session: SESSION, engine: 'WEBJS', event, payload, me: status === 'WORKING' ? ME : null });
  for (const s of sockets) wsSend(s, msg);
}

// ---------- messages ----------
const rid = () => crypto.randomBytes(10).toString('hex').toUpperCase();
function msg({ chat, fromMe = false, author, body = '', ts, media, replyTo, data, ack = fromMe ? 3 : 0 }) {
  const raw = rid();
  const id = `${fromMe}_${chat}_${raw}${chat.endsWith('@g.us') && !fromMe && author ? '_' + author : ''}`;
  const group = chat.endsWith('@g.us');
  return {
    id,
    timestamp: Math.floor((ts ?? Date.now()) / 1000),
    from: fromMe ? ME.id : chat,
    fromMe,
    to: fromMe ? chat : ME.id,
    participant: group && !fromMe ? author : undefined,
    body,
    hasMedia: !!media,
    media: media ? { url: `http://localhost:3000/api/files/${SESSION}/${id}.png`, mimetype: media, filename: null } : undefined,
    ack,
    replyTo: replyTo ?? undefined,
    // wwebjs rawData: the short id, the sender's own name, the message type
    _data: {
      id: { fromMe, remote: chat, id: raw, _serialized: id },
      notifyName: author ? Object.values(PEOPLE).find((p) => p.id === author)?.pushname : undefined,
      type: media ? (media.startsWith('image/') ? 'image' : media.startsWith('video/') ? 'video' : media.startsWith('audio/') ? 'ptt' : 'document') : 'chat',
      ...(media ? { mimetype: media, size: 4321 } : {}),
      ...(data ?? {}),
    },
  };
}
function addHistory(m) {
  const chat = m.fromMe ? m.to : m.from;
  if (!history.has(chat)) history.set(chat, []);
  history.get(chat).push(m);
  return m;
}
// Like a real phone after linking, the group's history only reaches WAHA a few seconds later.
let groupHistoryLoaded = false;
function lateHistory() {
  if (groupHistoryLoaded) return;
  groupHistoryLoaded = true;
  const now = Date.now();
  const H = 3600_000;
  addHistory(msg({ chat: GROUP.id, author: PEOPLE.sanne.id, body: 'Taartfoto', ts: now - 5.5 * H, media: 'image/jpeg' }));
  addHistory(msg({ chat: GROUP.id, author: PEOPLE.sanne.id, body: 'Wie neemt er taart mee?', ts: now - 5 * H }));
  addHistory(msg({ chat: GROUP.id, author: PEOPLE.jan.id, body: '@31655500002 jij toch? 🎂', ts: now - 4 * H }));
  addHistory(msg({ chat: GROUP.id, author: PEOPLE.sanne.id, body: 'Hoe laat?', ts: now - 3.5 * H, data: { type: 'poll_creation', pollName: 'Hoe laat?', pollOptions: [{ name: '14:00' }, { name: '15:00' }], pollSelectableOptionsCount: 1 } }));
}
setInterval(() => status === 'WORKING' && setTimeout(lateHistory, 4000), 1000);

function seed() {
  const now = Date.now();
  const H = 3600_000;
  const j = PEOPLE.jan.id;
  const a = addHistory(msg({ chat: j, body: 'Hoi! Kom je zaterdag ook?', ts: now - 30 * H }));
  addHistory(msg({ chat: j, fromMe: true, body: 'Ja, zeker 👍', ts: now - 29 * H, replyTo: { id: a.id, participant: j, body: a.body } }));
  addHistory(msg({ chat: j, body: 'Dit is *vet* en dit _schuin_', ts: now - 3 * H }));
  addHistory(msg({ chat: j, body: 'Kijk eens', ts: now - 2 * H, media: 'image/png' }));
  addHistory(msg({ chat: PEOPLE.lid.id, body: 'Oude foto', ts: now - 9 * H, media: 'image/jpeg', data: { gone: true } })); // WhatsApp no longer has the file
  addHistory(msg({ chat: PEOPLE.lid.id, body: '', ts: now - 8 * H, media: 'audio/ogg; codecs=opus' }));
  addHistory(msg({ chat: PEOPLE.lid.id, body: 'Nog een foto', ts: now - 7 * H, media: 'image/png' }));
  addHistory(msg({ chat: PEOPLE.lid.id, body: 'Hallo via een privé-id', ts: now - 6 * H }));
  addHistory(msg({ chat: '0@c.us', body: 'WhatsApp system chat', ts: now - 50 * H }));
}
seed();

function overview() {
  return [...history.entries()]
    // GOWS leaves group names out of the overview: they come from the groups endpoints.
    .map(([id, list]) => ({ id, name: id === GROUP.id ? null : Object.values(PEOPLE).find((p) => p.id === id)?.pushname ?? null, picture: null, lastMessage: list[list.length - 1], _chat: { unreadCount: id === PEOPLE.jan.id ? 2 : 0 } }))
    .sort((x, y) => y.lastMessage.timestamp - x.lastMessage.timestamp);
}

// ---------- http ----------
function json(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(data === undefined ? '' : JSON.stringify(data));
}
async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString();
  return s ? JSON.parse(s) : {};
}
function authed(req, url) {
  return req.headers['x-api-key'] === KEY || url.searchParams.get('x-api-key') === KEY;
}

const blocked = new Set();
const mockConfig = { messagesDelayMs: 0, mediaDelayMs: 0 }; // POST /mock/config
const stats = { singleFetches: 0 }; // GET /mock/stats
const pinnedOnPhone = new Set(); // POST /mock/pin {"jid":…,"pinned":true} changes it
const markedUnread = new Set([PEOPLE.lid.id]); // "Mark as unread" on the phone (WEBJS: unreadCount -1)
const ABOUT = { [PEOPLE.jan.id]: 'Aan het fietsen 🚲' };
const DESC = { [GROUP.id]: 'De familie-app 🏡\nWees lief voor elkaar' };
const subscribed = new Set(); // presence: WEBJS only reports typing for chats you subscribed to
function presence(chatId, who, state) {
  if (subscribed.has(chatId)) emit('presence.update', { id: chatId, presences: [{ participant: who, lastKnownPresence: state }] });
}

function afterSend(chatId, m, text) {
  emit('message.any', { ...m, source: 'api' }); // WAHA echoes your own sends
  const group = chatId.endsWith('@g.us');
  const ack = (event, who, n, delay) =>
    setTimeout(() => emit(event, { id: m.id, from: chatId, to: chatId, ...(who ? { participant: who } : {}), fromMe: true, ack: n, ackName: n === 2 ? 'DEVICE' : 'READ' }), delay);
  if (group) {
    // WEBJS: one message.ack.group per member; read for everyone only after both have read it
    ack('message.ack.group', PEOPLE.jan.id, 2, 400);
    ack('message.ack.group', PEOPLE.sanne.id, 2, 700);
    ack('message.ack.group', PEOPLE.jan.id, 3, 1200);
    ack('message.ack.group', PEOPLE.sanne.id, 3, 2400);
  } else {
    ack('message.ack', null, 2, 500);
    ack('message.ack', null, 3, 1800);
  }
  if (String(text).includes('noreply')) return;
  const replier = group ? PEOPLE.jan : Object.values(PEOPLE).find((p) => p.id === chatId);
  if (!replier) return;
  setTimeout(() => presence(chatId, replier.id, 'typing'), 2200);
  setTimeout(() => {
    presence(chatId, replier.id, 'paused');
    emit('message.any', msg({ chat: chatId, author: group ? replier.id : undefined, body: `Ontvangen: “${String(text || 'bestand').slice(0, 40)}”` }));
  }, 4000);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = req.method;
  try {
    if (p.startsWith('/mock/')) {
      if (p === '/mock/sent') return json(res, 200, sent);
      if (p === '/mock/incoming') {
        const b = await body(req);
        const person = PEOPLE[b.from ?? 'jan'];
        const chat = b.group === 'buren' ? GROUP2.id : b.group ? GROUP.id : person.id;
        const mm = msg({ chat, author: b.group ? person.id : undefined, body: b.text ?? 'Hallo!', media: b.media, ...(b.extra ?? {}) });
        emit('message.any', { ...mm, ...(b.payload ?? {}) });
        return json(res, 200, mm);
      }
      if (p === '/mock/event') {
        const b = await body(req);
        emit(b.event, b.payload);
        return json(res, 200, { ok: true });
      }
      if (p === '/mock/stats') return json(res, 200, stats);
      if (p === '/mock/config') {
        Object.assign(mockConfig, await body(req));
        return json(res, 200, mockConfig);
      }
      if (p === '/mock/pin') {
        const b = await body(req);
        if (b.pinned) pinnedOnPhone.add(b.jid);
        else pinnedOnPhone.delete(b.jid);
        return json(res, 200, { ok: true });
      }
      if (p === '/mock/status') {
        const b = await body(req);
        status = b.status;
        emit('session.status', { name: SESSION, status });
        return json(res, 200, { ok: true });
      }
    }
    if (p.startsWith('/pic/')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(AVATAR);
    }
    if (!authed(req, url)) return json(res, 401, { message: 'Unauthorized' });

    if (p === '/api/server/version') return json(res, 200, { version: '2026.10.1-mock', engine: 'WEBJS', tier: 'CORE' });
    if (p === `/api/sessions/${SESSION}` && m === 'GET') {
      return json(res, 200, { name: SESSION, status, me: status === 'WORKING' ? ME : null, engine: { engine: 'WEBJS' } });
    }
    if (p === '/api/sessions' && m === 'POST') return json(res, 201, { name: SESSION, status });
    if (p === `/api/sessions/${SESSION}/start`) return json(res, 201, { name: SESSION, status });
    if (p === `/api/sessions/${SESSION}/logout`) {
      status = 'SCAN_QR_CODE';
      sent.push({ path: p, method: m });
      emit('session.status', { name: SESSION, status });
      return json(res, 201, { name: SESSION, status });
    }
    if (p === `/api/${SESSION}/auth/qr`) {
      if (status !== 'SCAN_QR_CODE') return json(res, 422, { message: 'Session is not in SCAN_QR_CODE status' });
      setTimeout(() => {
        status = 'WORKING';
        emit('session.status', { name: SESSION, status });
      }, 3000);
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(QR);
    }
    if (status !== 'WORKING' && p.startsWith(`/api/${SESSION}/`)) return json(res, 422, { message: 'Session status is not as expected' });

    // Like WEBJS: chats carry isMuted / muteExpiration (seconds, -1 = always). Familie is muted on the phone.
    if (p === `/api/${SESSION}/chats`) {
      // wwebjs Chat objects, newest first; groups carry groupMetadata (WEBJS's group list is this list, filtered)
      const list = [...history.entries()]
        .sort(([, a], [, b]) => b[b.length - 1].timestamp - a[a.length - 1].timestamp)
        .map(([id]) => ({
          id: { _serialized: id },
          name: id === GROUP.id ? GROUP.name : Object.values(PEOPLE).find((x) => x.id === id)?.pushname ?? null,
          isGroup: id.endsWith('@g.us'),
          ...(id === GROUP.id ? { groupMetadata: { subject: GROUP.name, desc: DESC[GROUP.id] } } : {}),
          timestamp: history.get(id).at(-1).timestamp,
          isMuted: id === GROUP.id,
          muteExpiration: id === GROUP.id ? -1 : 0,
          unreadCount: markedUnread.has(id) ? -1 : id === PEOPLE.jan.id ? 2 : 0,
          pinned: pinnedOnPhone.has(id),
        }));
      return json(res, 200, list.slice(0, Number(url.searchParams.get('limit') ?? 100)));
    }
    const unread = p.match(new RegExp(`^/api/${SESSION}/chats/([^/]+)/unread$`));
    if (unread && m === 'POST') {
      markedUnread.add(decodeURIComponent(unread[1]));
      sent.push({ path: p, method: m });
      return json(res, 200, { ok: true });
    }
    if (p === '/api/contacts/about') {
      sent.push({ path: p, method: m, contactId: url.searchParams.get('contactId') });
      return json(res, 200, { about: ABOUT[url.searchParams.get('contactId')] ?? null });
    }
    if (p === `/api/${SESSION}/chats/overview`) sent.push({ path: p, method: m });
    if (p === `/api/${SESSION}/chats/overview`) return json(res, 200, overview().slice(0, Number(url.searchParams.get('limit') ?? 20)));
    const msgs = p.match(new RegExp(`^/api/${SESSION}/chats/([^/]+)/messages(?:/([^/]+))?$`));
    if (msgs && m === 'GET') {
      const chat = decodeURIComponent(msgs[1]);
      const list = history.get(chat) ?? [];
      if (msgs[2]) {
        stats.singleFetches++;
        if (mockConfig.mediaDelayMs) await new Promise((r) => setTimeout(r, mockConfig.mediaDelayMs));
        const x = list.find((y) => y.id === decodeURIComponent(msgs[2])) ?? null;
        return json(res, 200, x?._data?.gone ? { ...x, media: null } : x);
      }
      const limit = Number(url.searchParams.get('limit') ?? 10);
      // downloadMedia=false: like WAHA, no file url (fetch the single message to get it)
      const noMedia = url.searchParams.get('downloadMedia') === 'false';
      if (mockConfig.messagesDelayMs) await new Promise((r) => setTimeout(r, mockConfig.messagesDelayMs));
      if (status !== 'WORKING') return json(res, 422, { message: 'Session status is not as expected' });
      return json(res, 200, [...list].reverse().slice(0, limit).map((x) => (noMedia && x.media ? { ...x, media: null } : x)));
    }
    if (msgs && m === 'PUT') {
      const b = await body(req);
      sent.push({ path: p, method: m, ...b });
      return json(res, 200, { ok: true });
    }
    if (msgs && m === 'DELETE') {
      sent.push({ path: p, method: m });
      return json(res, 200, { ok: true });
    }
    const pic = p.match(new RegExp(`^/api/${SESSION}/chats/([^/]+)/picture$`));
    if (pic) return json(res, 200, { url: decodeURIComponent(pic[1]) === PEOPLE.jan.id ? `http://127.0.0.1:${PORT}/pic/jan.png` : null });
    if (p === '/api/contacts/all') {
      return json(res, 200, Object.values(PEOPLE).map((x) => ({ id: x.id, name: x.name, pushname: x.pushname, number: x.id.endsWith('@c.us') ? x.id.split('@')[0] : undefined, isBlocked: blocked.has(x.id) })));
    }
    // Numbers ending in 0000 aren't on WhatsApp.
    if (p === '/api/contacts/check-exists') {
      const phone = String(url.searchParams.get('phone') ?? '').replace(/\D/g, '');
      sent.push({ path: p, method: m, phone });
      return json(res, 200, phone.endsWith('0000') ? { numberExists: false } : { numberExists: true, chatId: `${phone}@c.us` });
    }
    if ((p === '/api/contacts/block' || p === '/api/contacts/unblock') && m === 'POST') {
      const b = await body(req);
      sent.push({ path: p, method: m, ...b });
      if (p.endsWith('/block')) blocked.add(b.contactId);
      else blocked.delete(b.contactId);
      return json(res, 201, { ok: true });
    }
    const parts = p.match(new RegExp(`^/api/${SESSION}/groups/([^/]+)/participants/v2$`));
    if (parts) return json(res, 200, [{ id: ME.id, role: 'admin' }, { id: PEOPLE.jan.id, role: 'participant' }, { id: PEOPLE.sanne.id, role: 'superadmin' }]);
    // WEBJS: groups are wwebjs GroupChat objects
    const groupChat = (g) => ({ id: { server: 'g.us', user: g.id.split('@')[0], _serialized: g.id }, name: g.name, isGroup: true, groupMetadata: { subject: g.name, desc: DESC[g.id] ?? undefined } });
    if (p === `/api/${SESSION}/groups`) return json(res, 200, [GROUP, GROUP2].map(groupChat));
    const one = p.match(new RegExp(`^/api/${SESSION}/groups/([^/]+)$`));
    if (one) {
      const g = [GROUP, GROUP2].find((x) => x.id === decodeURIComponent(one[1]));
      return g ? json(res, 200, groupChat(g)) : json(res, 404, { message: 'not found' });
    }
    const lid = p.match(new RegExp(`^/api/${SESSION}/lids/([^/]+)$`));
    if (lid) {
      const l = decodeURIComponent(lid[1]);
      return json(res, 200, { lid: l, pn: l === ME.lid ? ME.id : null });
    }
    if (p.startsWith('/api/files/')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PHOTO);
    }

    const sub = p.match(new RegExp(`^/api/${SESSION}/presence/([^/]+)/subscribe$`));
    if (sub) {
      subscribed.add(decodeURIComponent(sub[1]));
      sent.push({ path: p, method: m });
      return json(res, 201, { ok: true });
    }
    if (m === 'POST' || m === 'PUT') {
      const b = await body(req);
      const chatId = b.chatId;
      const record = { path: p, method: m, ...b, file: b.file ? { ...b.file, data: String(b.file.data ?? '').slice(0, 40) + '…' } : undefined, preview: b.preview ? { ...b.preview, image: b.preview.image ? { mimetype: b.preview.image.mimetype, bytes: b.preview.image.data?.length } : undefined } : undefined };
      sent.push(record);
      if (p === '/api/sendSeen') markedUnread.delete(chatId);
      if (['/api/sendText', '/api/sendImage', '/api/sendFile', '/api/sendVideo', '/api/sendVoice', '/api/send/link-custom-preview', '/api/sendPoll'].includes(p)) {
        if (String(b.text ?? b.caption ?? '').includes('fail')) return json(res, 500, { message: 'Mock failure' });
        const text = b.text ?? b.caption ?? '';
        const out = msg({ chat: chatId, fromMe: true, body: p === '/api/sendPoll' ? b.poll.name : text, media: b.file?.mimetype, ack: 1 });
        afterSend(chatId, out, text);
        return json(res, 201, out);
      }
      return json(res, 201, { ok: true });
    }
    json(res, 404, { message: 'mock: not implemented ' + m + ' ' + p });
  } catch (e) {
    json(res, 500, { message: String(e) });
  }
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/ws') || url.searchParams.get('x-api-key') !== KEY) return socket.destroy();
  wsAccept(req, socket);
});

server.listen(PORT, () => console.log(`mock WAHA on http://localhost:${PORT} (status: ${status})`));
