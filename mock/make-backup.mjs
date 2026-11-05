/**
 * Test fixture: a small msgstore.db in WhatsApp for Android's layout (the tables Messenger Web reads),
 * encrypted like an end-to-end encrypted backup (crypt15).
 *   node mock/make-backup.mjs <out.crypt15> <64 hex key> '<json: {"existingRaw": "..."}>'
 * "existingRaw" is the id of a message WAHA already has, to check it isn't imported twice.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const [out, keyHex, specJson] = process.argv.slice(2);
const spec = JSON.parse(specJson || '{}');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'msgstore-')), 'msgstore.db');
const db = new DatabaseSync(tmp);
db.exec(`
CREATE TABLE jid (_id INTEGER PRIMARY KEY, user TEXT, server TEXT, agent INTEGER, device INTEGER, type INTEGER, raw_string TEXT);
CREATE TABLE jid_map (lid_row_id INTEGER PRIMARY KEY, jid_row_id INTEGER);
CREATE TABLE chat (_id INTEGER PRIMARY KEY, jid_row_id INTEGER UNIQUE, hidden INTEGER, subject TEXT, created_timestamp INTEGER, archived INTEGER);
CREATE TABLE message (_id INTEGER PRIMARY KEY, chat_row_id INTEGER, from_me INTEGER, key_id TEXT, sender_jid_row_id INTEGER, status INTEGER,
  broadcast INTEGER, recipient_count INTEGER, participant_hash TEXT, origination_flags INTEGER, origin INTEGER, timestamp INTEGER,
  received_timestamp INTEGER, receipt_server_timestamp INTEGER, message_type INTEGER, text_data TEXT, starred INTEGER, lookup_tables INTEGER, sort_id INTEGER);
CREATE TABLE message_media (message_row_id INTEGER PRIMARY KEY, chat_row_id INTEGER, file_path TEXT, file_size INTEGER, mime_type TEXT,
  media_name TEXT, width INTEGER, height INTEGER, media_duration INTEGER, file_hash TEXT);
CREATE TABLE message_quoted (message_row_id INTEGER PRIMARY KEY, chat_row_id INTEGER, parent_message_chat_row_id INTEGER, from_me INTEGER,
  sender_jid_row_id INTEGER, key_id TEXT, timestamp INTEGER, message_type INTEGER, text_data TEXT);
CREATE TABLE message_location (message_row_id INTEGER PRIMARY KEY, chat_row_id INTEGER, latitude REAL, longitude REAL, place_name TEXT);
CREATE TABLE message_system (message_row_id INTEGER PRIMARY KEY, action_type INTEGER);
CREATE TABLE message_system_group (message_row_id INTEGER PRIMARY KEY, is_me_joined INTEGER);
CREATE TABLE message_system_chat_participant (message_row_id INTEGER, user_jid_row_id INTEGER);
CREATE TABLE message_add_on (_id INTEGER PRIMARY KEY, chat_row_id INTEGER, from_me INTEGER, key_id TEXT, sender_jid_row_id INTEGER,
  parent_message_row_id INTEGER, timestamp INTEGER, message_add_on_type INTEGER);
CREATE TABLE message_add_on_reaction (message_add_on_row_id INTEGER PRIMARY KEY, reaction TEXT, sender_timestamp INTEGER);
`);
const jid = db.prepare('INSERT INTO jid (_id, user, server, type, raw_string) VALUES (?, ?, ?, ?, ?)');
jid.run(1, '31655500001', 's.whatsapp.net', 0, '31655500001@s.whatsapp.net'); // Jan
jid.run(2, '120363000000000001', 'g.us', 1, '120363000000000001@g.us'); // Familie
jid.run(3, '31655500002', 's.whatsapp.net', 0, '31655500002@s.whatsapp.net'); // Sanne
jid.run(4, '77777777777777', 'lid', 0, '77777777777777@lid'); // Kees, by privacy id…
jid.run(5, '31655500077', 's.whatsapp.net', 0, '31655500077@s.whatsapp.net'); // …and his number
jid.run(6, 'status', 'broadcast', 11, 'status@broadcast');
db.prepare('INSERT INTO jid_map VALUES (4, 5)').run();
const chat = db.prepare('INSERT INTO chat (_id, jid_row_id, subject) VALUES (?, ?, ?)');
chat.run(1, 1, null);
chat.run(2, 2, 'Familie');
chat.run(3, 4, null);
chat.run(4, 6, null);

const day = Date.parse('2024-03-01T10:00:00Z');
let id = 0;
const msg = (chatRow, o) => {
  id++;
  db.prepare(
    'INSERT INTO message (_id, chat_row_id, from_me, key_id, sender_jid_row_id, status, timestamp, message_type, text_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, chatRow, o.fromMe ? 1 : 0, o.key, o.sender ?? 0, o.status ?? (o.fromMe ? 13 : 0), o.ts, o.type ?? 0, o.text ?? null);
  return id;
};
// Jan
const old = msg(1, { key: 'OLDJAN000001', text: 'Heel oud bericht', ts: day });
msg(1, { key: 'OLDJAN000002', fromMe: true, text: 'Klopt, *heel* oud', ts: day + 60_000 });
const reply = msg(1, { key: 'OLDJAN000003', text: 'Antwoord op het oude', ts: day + 120_000 });
db.prepare('INSERT INTO message_quoted (message_row_id, chat_row_id, from_me, sender_jid_row_id, key_id, text_data) VALUES (?, 1, 0, 1, ?, ?)').run(reply, 'OLDJAN000001', 'Heel oud bericht');
const photo = msg(1, { key: 'OLDJAN000004', type: 1, text: 'Foto uit 2024', ts: day + 180_000 });
db.prepare('INSERT INTO message_media (message_row_id, chat_row_id, file_path, file_size, mime_type, width, height) VALUES (?, 1, ?, 1234, ?, 320, 200)').run(photo, 'Media/WhatsApp Images/IMG-20240301-WA0001.jpg', 'image/jpeg');
msg(1, { key: 'OLDJAN000005', type: 15, ts: day + 240_000 });
const loc = msg(1, { key: 'OLDJAN000006', type: 5, ts: day + 300_000 });
db.prepare('INSERT INTO message_location VALUES (?, 1, 52.37, 4.89, ?)').run(loc, 'Dam');
if (spec.existingRaw) msg(1, { key: spec.existingRaw, text: 'Hoi! Kom je zaterdag ook?', ts: Date.now() - 30 * 3600_000 });
db.prepare('INSERT INTO message_add_on VALUES (1, 1, 0, ?, 1, ?, ?, 56)').run('REACT0001', old, day + 30_000);
db.prepare('INSERT INTO message_add_on_reaction VALUES (1, ?, ?)').run('❤️', day + 30_000);
// Familie
const sys = msg(2, { key: 'OLDFAM000001', sender: 3, status: 6, type: 7, text: 'Familie 2024', ts: day + 1000 });
db.prepare('INSERT INTO message_system VALUES (?, 1)').run(sys);
const add = msg(2, { key: 'OLDFAM000002', sender: 3, status: 6, type: 7, ts: day + 2000 });
db.prepare('INSERT INTO message_system VALUES (?, 12)').run(add);
db.prepare('INSERT INTO message_system_chat_participant VALUES (?, 1)').run(add);
msg(2, { key: 'OLDFAM000003', sender: 3, text: 'Groepsbericht uit 2024 @31655500001', ts: day + 3000 });
// Kees (chat by privacy id, number known through jid_map)
msg(3, { key: 'OLDKEES00001', text: 'Hallo van Kees', ts: day + 4000 });
// status updates: not a chat
msg(4, { key: 'STATUS000001', text: 'mijn status', ts: day + 5000 });
db.close();

// crypt15: <varint len><BackupPrefix {3: {1: iv}, 4: {1: app version}}><AES-GCM(zlib(db))><tag><md5>
const keyBytes = Buffer.from(keyHex, 'hex');
const inter = crypto.createHmac('sha256', Buffer.alloc(32)).update(keyBytes).digest();
const mainKey = crypto.createHmac('sha256', inter).update(Buffer.from('backup encryption\x01', 'latin1')).digest();
const iv = crypto.randomBytes(16);
// Like a real msgstore header: key_type, the IV, then metadata long enough that the size takes two bytes.
const str = (field, v) => Buffer.concat([Buffer.from([(field << 3) | 2, Buffer.byteLength(v)]), Buffer.from(v)]);
const flags = Buffer.concat(Array.from({ length: 40 }, (_, i) => Buffer.from([((i + 5) << 3) | 0, 1].length === 2 && i + 5 < 16 ? [((i + 5) << 3) | 0, 1] : [(((i + 5) << 3) & 0x7f) | 0x80, (i + 5) >> 4, 1])));
const meta = Buffer.concat([str(1, '2.26.10.70'), str(2, 'Pixel 9'), str(3, '09'), Buffer.from([0x20, 1]), flags]);
const header = Buffer.concat([Buffer.from([0x08, 0x01, 0x1a, 18, 0x0a, 16]), iv, Buffer.from([0x22]), varint(meta.length), meta]);
const prefix = Buffer.concat([varint(header.length), header]);
function varint(n) {
  const out = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}
const cipher = crypto.createCipheriv('aes-256-gcm', mainKey, iv);
const enc = Buffer.concat([cipher.update(zlib.deflateSync(fs.readFileSync(tmp))), cipher.final()]);
const tag = cipher.getAuthTag();
const md5 = crypto.createHash('md5').update(Buffer.concat([prefix, enc, tag])).digest();
fs.writeFileSync(out, Buffer.concat([prefix, enc, tag, md5]));
fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
console.log(JSON.stringify({ out, bytes: fs.statSync(out).size }));
