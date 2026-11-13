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
const archivedOnPhone = new Set(); // POST /mock/archive {"jid":…,"archived":true}
const profile = { name: 'Wouter', status: 'Hallo daar', picture: null };
const mockConfig = { messagesDelayMs: 0, mediaDelayMs: 0, fileDelayMs: 0 }; // POST /mock/config
const stats = { singleFetches: 0, pages: [], restarts: 0 }; // GET /mock/stats
const pinnedOnPhone = new Set(); // POST /mock/pin {"jid":…,"pinned":true} changes it
const markedUnread = new Set([PEOPLE.lid.id]); // "Mark as unread" on the phone (WEBJS: unreadCount -1)
const ABOUT = { [PEOPLE.jan.id]: 'Aan het fietsen 🚲' };
const SANNE_LID = '22222222222222@lid';
// Group state: the two seeded groups start with you (admin), Jan and Sanne (superadmin).
const groups = new Map();
function groupState(id) {
  if (!groups.has(id) && [GROUP.id, GROUP2.id].includes(id)) {
    const base = id === GROUP.id ? GROUP : GROUP2;
    groups.set(id, { id, name: base.name, parts: [{ id: ME.id, role: 'admin' }, { id: PEOPLE.jan.id, role: 'participant' }, { id: PEOPLE.sanne.id, role: 'superadmin' }], msgAdmins: false, infoAdmins: false, addAll: false, approval: false, invite: 'FamilieInvite1234567' + (id === GROUP.id ? 'A' : 'B'), requests: [], tags: id === GROUP.id ? { [SANNE_LID]: 'Organiser', [ME.lid]: 'Papa' } : {} });
  }
  return groups.get(id) ?? null;
}
groupState(GROUP.id); groupState(GROUP2.id);
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
    // Tests: WAHA can't be reached (every API call fails like a stopped container behind a proxy)
    if (mockConfig.down && p.startsWith('/api/')) return json(res, 502, { message: 'Bad gateway' });
    if (p.startsWith('/mock/')) {
      if (p === '/mock/sent') return json(res, 200, sent);
      // Tests: someone extra in the WhatsApp contact list
      if (p === '/mock/contact') {
        const b = await body(req);
        PEOPLE[b.key] = { id: b.id, name: b.name ?? null, pushname: b.pushname ?? null };
        return json(res, 200, { ok: true });
      }
      if (p === '/mock/incoming') {
        const b = await body(req);
        const person = PEOPLE[b.from ?? 'jan'];
        const chat = b.group === 'buren' ? GROUP2.id : b.group ? GROUP.id : person.id;
        const mm = msg({ chat, author: b.group ? person.id : undefined, body: b.text ?? 'Hallo!', media: b.media, ...(b.extra ?? {}) });
        emit('message.any', { ...mm, ...(b.payload ?? {}) });
        // WAHA also sends a separate "message" event for the same message (WEBJS), straight after.
        for (const ev of b.alsoAs ?? []) emit(ev, { ...mm, ...(b.payload ?? {}) });
        return json(res, 200, mm);
      }
      if (p === '/mock/event') {
        const b = await body(req);
        emit(b.event, b.payload);
        return json(res, 200, { ok: true });
      }
      if (p === '/mock/stats') return json(res, 200, stats);
      if (p === '/mock/history') {
        const b = await body(req); // {"chat":…,"id":…,"body":…}: a message WhatsApp Web has, with exactly this id
        const mm = b.message ?? msg({ chat: b.chat, body: b.body ?? '' });
        if (b.id) mm.id = b.id;
        addHistory(mm);
        return json(res, 200, mm);
      }
      if (p === '/mock/bulk') {
        const b = await body(req); // {"from":"sanne","n":2500}: that many old messages in a direct chat
        const who = PEOPLE[b.from ?? 'sanne'];
        const base = Date.now() - 400 * 3600_000;
        for (let k = 0; k < b.n; k++) addHistory(msg({ chat: who.id, body: `Oud bericht ${k + 1}`, ts: base + k * 60_000 }));
        history.get(who.id).sort((x, y) => x.timestamp - y.timestamp);
        return json(res, 200, { ok: true, total: history.get(who.id).length });
      }
      if (p === '/mock/config') {
        Object.assign(mockConfig, await body(req));
        return json(res, 200, mockConfig);
      }
      if (p === '/mock/archive') {
        const b = await body(req);
        if (b.archived) archivedOnPhone.add(b.jid);
        else archivedOnPhone.delete(b.jid);
        return json(res, 200, { ok: true });
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
    // Like WAHA: a failed session only comes back when someone restarts it
    if (p === `/api/sessions/${SESSION}/restart` && m === 'POST') {
      stats.restarts++;
      status = 'STARTING';
      emit('session.status', { name: SESSION, status });
      setTimeout(() => {
        status = 'WORKING';
        emit('session.status', { name: SESSION, status });
      }, 1500);
      return json(res, 201, { name: SESSION, status });
    }
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
          archived: archivedOnPhone.has(id),
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
        // WhatsApp Web finds a message by its id alone, whichever chat the URL names
        const want = decodeURIComponent(msgs[2]);
        const x = [...history.values()].flat().find((y) => y.id === want) ?? null;
        return json(res, 200, x?._data?.gone ? { ...x, media: null } : x);
      }
      const limit = Number(url.searchParams.get('limit') ?? 10);
      // downloadMedia=false: like WAHA, no file url (fetch the single message to get it)
      const noMedia = url.searchParams.get('downloadMedia') === 'false';
      if (mockConfig.messagesDelayMs) await new Promise((r) => setTimeout(r, mockConfig.messagesDelayMs));
      if (status !== 'WORKING') return json(res, 422, { message: 'Session status is not as expected' });
      const offset = Number(url.searchParams.get('offset') ?? 0);
      stats.pages.push({ chat, limit, offset });
      return json(res, 200, [...list].reverse().slice(offset, offset + limit).map((x) => (noMedia && x.media ? { ...x, media: null } : x)));
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
    // ---------- groups (stateful: management calls change them) ----------
    const groupChat = (g) => ({ id: { server: 'g.us', user: g.id.split('@')[0], _serialized: g.id }, name: g.name, isGroup: true, groupMetadata: { subject: g.name, desc: DESC[g.id] ?? undefined, announce: g.msgAdmins, restrict: g.infoAdmins, size: g.parts.length } });
    const gm = p.match(new RegExp(`^/api/${SESSION}/groups/([^/?]+)(/.*)?$`));
    const gid = gm && gm[1] !== 'join-info' && gm[1] !== 'join' && gm[1] !== 'count' && gm[1] !== 'refresh' ? decodeURIComponent(gm[1]) : null;
    const g = gid ? groupState(gid) : null;
    const rest = gm?.[2] ?? '';
    const amAdmin = (x) => x.parts.some((q) => q.id === ME.id && q.role !== 'participant');
    const ids = (b) => (b.participants ?? []).map((q) => q.id);
    if (p === `/api/${SESSION}/groups` && m === 'GET') return json(res, 200, [...groups.values()].filter((x) => x.parts.some((q) => q.id === ME.id)).map(groupChat));
    if (p === `/api/${SESSION}/groups` && m === 'POST') {
      const b = await body(req);
      sent.push({ path: p, method: m, ...b });
      const id = `1203630${String(Date.now()).slice(-8)}${groups.size}@g.us`;
      groups.set(id, { id, name: b.name, parts: [{ id: ME.id, role: 'superadmin' }, ...ids(b).map((x) => ({ id: x, role: 'participant' }))], msgAdmins: false, infoAdmins: false, addAll: true, approval: false, invite: rid(), requests: [], tags: {} });
      setTimeout(() => emit('group.v2.join', { group: { id, subject: b.name } }), 100);
      return json(res, 201, { gid: { server: 'g.us', user: id.split('@')[0], _serialized: id }, participants: {} });
    }
    if (p === `/api/${SESSION}/groups/join-info`) {
      const code = new URL(req.url, 'http://x').searchParams.get('code');
      const found = [...groups.values()].find((x) => x.invite === code);
      return found ? json(res, 200, { id: found.id, subject: found.name, desc: DESC[found.id] ?? '', size: found.parts.length, membershipApprovalMode: found.approval }) : json(res, 404, { message: 'invite code not found' });
    }
    if (p === `/api/${SESSION}/groups/join` && m === 'POST') {
      const b = await body(req);
      sent.push({ path: p, method: m, ...b });
      const found = [...groups.values()].find((x) => x.invite === b.code);
      if (!found) return json(res, 404, { message: 'invite code not found' });
      if (found.approval) return json(res, 201, {});
      found.parts.push({ id: ME.id, role: 'participant' });
      setTimeout(() => emit('group.v2.join', { group: { id: found.id, subject: found.name } }), 100);
      return json(res, 201, { id: found.id });
    }
    if (g) {
      if (rest === '' && m === 'GET') return json(res, 200, groupChat(g));
      if (rest === '/participants/v2' && m === 'GET') return json(res, 200, g.parts.some((q) => q.id === ME.id) ? g.parts : []);
      if (m !== 'GET') {
        const b = m === 'DELETE' ? {} : await body(req);
        sent.push({ path: p, method: m, ...b, file: b.file ? { mimetype: b.file.mimetype } : undefined });
        const adminOnly = ['/subject', '/description', '/picture'].includes(rest) ? g.infoAdmins : !['/leave', '/participants/v2/tags/my', '/participants/add'].includes(rest);
        if (adminOnly && !amAdmin(g) && !(rest === '/participants/add' && g.addAll)) return json(res, 403, { message: 'not admin' });
        const changed = (type, participants) => setTimeout(() => emit(type ? 'group.v2.participants' : 'group.v2.update', { group: { id: g.id, subject: g.name, desc: DESC[g.id] }, type, participants: (participants ?? []).map((id) => ({ id })) }), 50);
        switch (rest) {
          case '/subject': g.name = b.subject; changed(); break;
          case '/description': DESC[g.id] = b.description; changed(); break;
          case '/picture': g.picture = m === 'PUT'; changed(); break;
          case '/participants/add': for (const x of ids(b)) if (!g.parts.some((q) => q.id === x)) g.parts.push({ id: x, role: 'participant' }); changed('add', ids(b)); break;
          case '/participants/remove': g.parts = g.parts.filter((q) => !ids(b).includes(q.id)); changed('remove', ids(b)); break;
          case '/admin/promote': for (const q of g.parts) if (ids(b).includes(q.id)) q.role = 'admin'; changed('promote', ids(b)); break;
          case '/admin/demote': for (const q of g.parts) if (ids(b).includes(q.id)) q.role = 'participant'; changed('demote', ids(b)); break;
          case '/settings/security/info-admin-only': g.infoAdmins = b.adminsOnly; changed(); break;
          case '/settings/security/messages-admin-only': g.msgAdmins = b.adminsOnly; changed(); break;
          case '/settings/security/member-add-mode': g.addAll = b.membersCanAddNewMember; changed(); break;
          case '/settings/security/membership-approval': g.approval = b.newMembersApprovalRequired; changed(); break;
          case '/invite-code/revoke': g.invite = rid(); break;
          case '/participants/join-requests/approve': for (const x of ids(b)) { g.requests = g.requests.filter((r) => r !== x); g.parts.push({ id: x, role: 'participant' }); } changed('add', ids(b)); return json(res, 201, ids(b).map((x) => ({ requesterId: x, success: true })));
          case '/participants/join-requests/reject': g.requests = g.requests.filter((r) => !ids(b).includes(r)); return json(res, 201, ids(b).map((x) => ({ requesterId: x, success: true })));
          case '/leave': g.parts = g.parts.filter((q) => q.id !== ME.id); setTimeout(() => emit('group.v2.leave', { group: { id: g.id } }), 50); break;
          case '/participants/v2/tags/my': if (b.tag) g.tags[ME.lid] = b.tag; else delete g.tags[ME.lid]; setTimeout(() => emit('group.v2.participants.tag', { group: { id: g.id }, participant: { id: ME.lid, pn: ME.id }, tag: b.tag ?? null, timestamp: Math.floor(Date.now() / 1000) }), 50); break;
          default: return json(res, 404, { message: 'mock: unknown group call ' + rest });
        }
        return json(res, 200, { success: true });
      }
      const setting = rest.match(/^\/settings\/security\/(.+)$/);
      if (setting) return json(res, 200, { 'info-admin-only': { adminsOnly: g.infoAdmins }, 'messages-admin-only': { adminsOnly: g.msgAdmins }, 'member-add-mode': { membersCanAddNewMember: g.addAll }, 'membership-approval': { newMembersApprovalRequired: g.approval } }[setting[1]] ?? {});
      if (rest === '/invite-code') return amAdmin(g) ? json(res, 200, `https://chat.whatsapp.com/${g.invite}`) : json(res, 403, { message: 'not admin' });
      if (rest === '/participants/join-requests') return json(res, 200, g.requests.map((id) => ({ id: { _serialized: id }, requestMethod: 'InviteLink', t: Math.floor(Date.now() / 1000) })));
      if (rest === '/participants/v2/tags') return json(res, 200, Object.entries(g.tags).map(([id, tag]) => ({ id, tag, timestamp: 1700000000 })));
      if (rest === '/participants/v2/tags/my') return json(res, 200, { id: ME.lid, tag: g.tags[ME.lid] ?? null, timestamp: 1700000000 });
      if (rest === '/picture') return json(res, 200, { url: null });
    }
    if (gid && !g) return json(res, 404, { message: 'group not found' });
    if (p === '/mock/join-request' && m === 'POST') {
      const b = await body(req); // {group, who}
      const x = groupState(b.group);
      x.requests.push(b.who);
      emit('group.join-request', { groupId: b.group, requester: b.who, action: 'created' });
      return json(res, 201, {});
    }
    if (p === '/mock/groups') return json(res, 200, Object.fromEntries(groups));
    // Someone changes their label on their phone; WhatsApp Web's own list doesn't pick it up (like WEBJS with unsynced labels).
    if (p === '/mock/label-event' && m === 'POST') {
      const b = await body(req); // {group, id, pn, tag}
      emit('group.v2.participants.tag', { group: { id: b.group }, participant: { id: b.id, pn: b.pn ?? null }, tag: b.tag, timestamp: Math.floor(Date.now() / 1000) });
      return json(res, 201, {});
    }
    if (p === '/mock/group-set' && m === 'POST') {
      const b = await body(req); // {group, patch: {msgAdmins…}, myRole}
      const x = groupState(b.group);
      Object.assign(x, b.patch ?? {});
      if (b.myRole) for (const q of x.parts) if (q.id === ME.id) q.role = b.myRole;
      emit('group.v2.update', { group: { id: x.id, subject: x.name } });
      return json(res, 201, {});
    }
    const bypn = p.match(new RegExp(`^/api/${SESSION}/lids/pn/([^/]+)$`));
    if (bypn) {
      const pn = decodeURIComponent(bypn[1]);
      return json(res, 200, { pn, lid: pn === PEOPLE.sanne.id ? SANNE_LID : pn === ME.id ? ME.lid : null });
    }
    const lid = p.match(new RegExp(`^/api/${SESSION}/lids/([^/]+)$`));
    if (lid) {
      const l = decodeURIComponent(lid[1]);
      return json(res, 200, { lid: l, pn: l === ME.lid ? ME.id : null });
    }
    if (p.startsWith('/api/files/')) {
      if (mockConfig.fileDelayMs) await new Promise((r) => setTimeout(r, mockConfig.fileDelayMs));
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PHOTO);
    }

    // Jan was last seen an hour ago; Sanne hides it
    const pres = p.match(new RegExp(`^/api/${SESSION}/presence/([^/]+)$`));
    if (pres && m === 'GET') {
      const chat = decodeURIComponent(pres[1]);
      return json(res, 200, { id: chat, presences: [{ participant: chat, lastKnownPresence: 'offline', lastSeen: chat === PEOPLE.jan.id ? Math.floor(Date.now() / 1000) - 3600 : null }] });
    }
    if (p === `/api/${SESSION}/profile` && m === 'GET') return json(res, 200, { id: ME.id, ...profile });
    if (p.startsWith(`/api/${SESSION}/profile/`) && (m === 'PUT' || m === 'DELETE')) {
      const b = m === 'PUT' ? await body(req) : {};
      sent.push({ path: p, method: m, ...b, file: b.file ? { mimetype: b.file.mimetype } : undefined });
      if (p.endsWith('/name')) profile.name = b.name;
      if (p.endsWith('/status')) profile.status = b.status;
      return json(res, 200, { success: true });
    }
    const arch = p.match(new RegExp(`^/api/${SESSION}/chats/([^/]+)/(archive|unarchive)$`));
    if (arch && m === 'POST') {
      const id = decodeURIComponent(arch[1]);
      if (arch[2] === 'archive') archivedOnPhone.add(id);
      else archivedOnPhone.delete(id);
      sent.push({ path: p, method: m });
      return json(res, 200, { ok: true });
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
      if (p === '/api/sendVoice' && mockConfig.noVoice) return json(res, 500, { message: 'ffmpeg not available' }); // tests: conversion fails
      if (p === '/api/send/link-custom-preview' && mockConfig.webjs) // like WAHA's WEBJS engine
        return json(res, 501, { statusCode: 501, message: "The method is not implemented by 'WEBJS' engine. Check the docs and try another engine: https://waha.devlike.pro/" });
      if (['/api/sendText', '/api/sendImage', '/api/sendFile', '/api/sendVideo', '/api/sendVoice', '/api/send/link-custom-preview', '/api/sendPoll', '/api/sendSticker'].includes(p)) {
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
