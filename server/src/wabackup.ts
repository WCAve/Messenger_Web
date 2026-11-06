/**
 * Full WhatsApp history from an Android backup: msgstore.db.crypt15 (end-to-end encrypted backup,
 * opened with your 64-digit key) or an already decrypted msgstore.db. The media folder from the phone
 * can be added afterwards; files are matched to messages by the path the backup recorded.
 *
 * File format (crypt15): <varint n><n bytes protobuf header, field 3.1 = 16-byte IV><AES-256-GCM of
 * zlib(SQLite)><16-byte tag><16-byte MD5 of everything before it>. Multi-file backups end with the tag
 * and no MD5. Key: HMAC-SHA256(HMAC-SHA256(32 zero bytes, key), "backup encryption\x01"). Same as
 * wa-crypt-tools / WhatsApp-Chat-Exporter.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { type Ctx, HttpError } from './http.js';
import { localPath } from './attachments.js';
import { config } from './config.js';
import { db } from './db.js';
import {
  type Attachment,
  type ConversationRow,
  type Reaction,
  freeTimestamp,
  getMessage,
  getOrCreateWaChat,
  insertMessage,
  nameForKey,
  renderBody,
  self,
  updateMessage,
  waNumberOf,
} from './store.js';
import {
  addSticker,
  type BackupState,
  bare,
  emitConversation,
  emitMessage,
  getWaState,
  keyFor,
  resolve,
  richFromWa,
  seedLids,
  skipChat,
  updateWaState,
} from './whatsapp.js';

type Logger = { info: (m: string) => void; warn: (m: string) => void };
let log: Logger = console;
export function setBackupLogger(l: Logger) {
  log = l;
}

/** Put msgstore.db.crypt15 (and later the Media folder) here, or upload it in Settings. */
export const backupDir = path.join(config.dataDir, 'whatsapp-backup');

let busy = false;
let stopRequested = false;

function setBackup(patch: Partial<BackupState>) {
  const cur = getWaState().backup ?? { stage: 'idle' as const };
  updateWaState({ backup: { ...cur, ...patch } });
}

// ---------- the file ----------

function readVarint(buf: Buffer, at: number): [number, number] {
  let v = 0;
  let shift = 0;
  let i = at;
  for (; i < buf.length && shift < 35; i++, shift += 7) {
    v |= (buf[i] & 0x7f) << shift;
    if (!(buf[i] & 0x80)) return [v >>> 0, i + 1];
  }
  throw new Error('bad varint');
}

/** Length-delimited and varint fields of one protobuf message (enough for the backup header). */
function protoFields(buf: Buffer): Map<number, Buffer[]> {
  const out = new Map<number, Buffer[]>();
  let i = 0;
  while (i < buf.length) {
    const [tag, a] = readVarint(buf, i);
    const field = tag >>> 3;
    const wire = tag & 7;
    i = a;
    if (wire === 0) i = readVarint(buf, i)[1];
    else if (wire === 2) {
      const [len, b] = readVarint(buf, i);
      if (b + len > buf.length) throw new Error('bad protobuf');
      const list = out.get(field) ?? [];
      list.push(buf.subarray(b, b + len));
      out.set(field, list);
      i = b + len;
    } else if (wire === 5) i += 4;
    else if (wire === 1) i += 8;
    else throw new Error('bad protobuf');
  }
  return out;
}

interface Header {
  dataStart: number;
  iv: Buffer;
  app?: string;
}

function readHeader(file: string): Header {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(4096);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    const [size, start] = readVarint(head, 0);
    if (start + size > n) throw new Error('header too large');
    const fields = protoFields(head.subarray(start, start + size));
    const e2ee = fields.get(3)?.[0];
    if (!e2ee) throw new HttpError(400, "This isn't an end-to-end encrypted backup (crypt15). Turn on end-to-end encrypted backup with a 64-digit key on your phone first.");
    const iv = protoFields(e2ee).get(1)?.[0];
    if (!iv || iv.length !== 16) throw new Error('no IV in the header');
    const meta = fields.get(4)?.[0];
    const app = meta ? protoFields(meta).get(1)?.[0]?.toString('utf8') : undefined;
    return { dataStart: start + size, iv: Buffer.from(iv), app };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, `This doesn't look like a WhatsApp backup file (${(e as Error).message})`);
  } finally {
    fs.closeSync(fd);
  }
}

function isSqlite(file: string): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(16);
    fs.readSync(fd, b, 0, 16, 0);
    return b.toString('latin1', 0, 15) === 'SQLite format 3';
  } finally {
    fs.closeSync(fd);
  }
}

function currentFile(): string | null {
  if (!fs.existsSync(backupDir)) return null;
  const files = fs
    .readdirSync(backupDir)
    .filter((f) => /^msgstore.*\.(crypt15|db)$/i.test(f) && fs.statSync(path.join(backupDir, f)).isFile())
    .map((f) => path.join(backupDir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] ?? null;
}

/** What's in the backup folder now (for Settings). */
export function backupFileInfo(): BackupState['file'] {
  const f = currentFile();
  if (!f) return null;
  const st = fs.statSync(f);
  let app: string | undefined;
  try {
    if (!isSqlite(f)) app = readHeader(f).app;
  } catch {
    /* shown when importing */
  }
  return { name: path.basename(f), size: st.size, at: st.mtimeMs, app };
}

/** Files from imported backups still waiting for the media folder (survives restarts, unlike the state). */
export function backupMediaWaiting(): number {
  return db.prepare<[], { n: number }>("SELECT count(*) AS n FROM wa_media WHERE backup_path IS NOT NULL").get()!.n;
}

export function refreshBackupInfo() {
  setBackup({ file: backupFileInfo() });
}

/** Upload of the backup file, streamed to disk (it can be hundreds of MB). */
export async function receiveBackupUpload(ctx: Ctx) {
  if (busy) throw new HttpError(409, 'A backup import is running');
  const name = String(ctx.req.headers['x-file-name'] ?? '');
  const plain = /\.db$/i.test(name);
  if (!/\.(crypt15|db)$/i.test(name)) throw new HttpError(400, 'Pick the msgstore.db.crypt15 file');
  fs.mkdirSync(backupDir, { recursive: true });
  for (const f of fs.readdirSync(backupDir)) if (/^msgstore.*\.(crypt15|db|part)$/i.test(f)) fs.rmSync(path.join(backupDir, f), { force: true });
  const dest = path.join(backupDir, plain ? 'msgstore.db' : 'msgstore.db.crypt15');
  const tmp = dest + '.part';
  try {
    await pipeline(ctx.req, fs.createWriteStream(tmp));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw new HttpError(400, `Upload failed: ${(e as Error).message}`);
  }
  fs.renameSync(tmp, dest);
  if (plain ? !isSqlite(dest) : !readHeader(dest)) throw new HttpError(400, 'Not a WhatsApp backup');
  refreshBackupInfo();
  return { file: backupFileInfo() };
}

function mainKey(hex: string): Buffer {
  const key = Buffer.from(hex.replace(/[^0-9a-f]/gi, ''), 'hex');
  if (key.length !== 32) throw new HttpError(400, 'The key is 64 characters: digits 0–9 and letters a–f');
  const inter = crypto.createHmac('sha256', Buffer.alloc(32)).update(key).digest();
  return crypto.createHmac('sha256', inter).update(Buffer.from('backup encryption\x01', 'latin1')).digest();
}

/** Decrypt to a plain SQLite file. Tries the single-file layout (tag + MD5), then multi-file (tag only). */
/** Exported for one-off checks run inside the container (e.g. what tables a backup has). */
export async function decryptBackup(file: string, out: string, keyHex: string, progress: (done: number, total: number) => void) {
  const key = mainKey(keyHex);
  const { dataStart, iv } = readHeader(file);
  const size = fs.statSync(file).size;
  if (size < dataStart + 48) throw new HttpError(400, 'The backup file is incomplete');
  const tail = Buffer.alloc(32);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, tail, 0, 32, size - 32);
  fs.closeSync(fd);
  const layouts = [
    { end: size - 32, tag: tail.subarray(0, 16) },
    { end: size - 16, tag: tail.subarray(16, 32) },
  ];
  let lastError: Error | null = null;
  for (const l of layouts) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(l.tag);
    let seen = 0;
    let first = true;
    const total = l.end - dataStart;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        seen += chunk.length;
        if (seen % (8 << 20) < chunk.length) progress(seen, total);
        cb(null, chunk);
      },
    });
    const check = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        // Decrypted data is zlib: 0x78 first. Anything else means the key is wrong.
        if (first && chunk.length) {
          first = false;
          if (chunk[0] !== 0x78) return cb(new HttpError(400, "That key doesn't open this backup. Check the 64 characters (and that it's this phone's backup)."));
        }
        cb(null, chunk);
      },
    });
    try {
      await pipeline(fs.createReadStream(file, { start: dataStart, end: l.end - 1 }), meter, decipher, check, zlib.createInflate(), fs.createWriteStream(out));
      if (!isSqlite(out)) throw new HttpError(400, 'Decrypted, but this is not a WhatsApp database');
      return;
    } catch (e) {
      fs.rmSync(out, { force: true });
      if (e instanceof HttpError) throw e;
      lastError = e as Error;
    }
  }
  throw new HttpError(400, `Couldn't decrypt the backup (${lastError?.message ?? 'unknown error'}). Is the file complete?`);
}

// ---------- reading msgstore.db ----------

interface Row {
  _id: number;
  chat_row_id: number;
  from_me: number;
  key_id: string | null;
  sender_jid_row_id: number | null;
  status: number | null;
  timestamp: number;
  message_type: number;
  text_data: string | null;
  file_path: string | null;
  mime_type: string | null;
  file_size: number | null;
  media_name: string | null;
  width: number | null;
  height: number | null;
  q_key: string | null;
  q_text: string | null;
  q_from_me: number | null;
  q_sender: number | null;
  latitude: number | null;
  longitude: number | null;
  place_name: string | null;
  action_type: number | null;
  is_me_joined: number | null;
  forward_score: number | null;
  vcard: string | null;
}

const EXT: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'application/pdf': '.pdf',
};
const TYPE_MIME: Record<number, string> = { 1: 'image/jpeg', 2: 'audio/ogg', 3: 'video/mp4', 9: 'application/octet-stream', 13: 'video/mp4', 20: 'image/webp' };
const MEDIA_TYPES = new Set([1, 2, 3, 9, 13, 20]);

export function cancelBackupImport() {
  if (busy) stopRequested = true;
}

/** Start the import (decrypt first when needed). Runs in the background; progress in the WhatsApp state. */
export function startBackupImport(keyHex: string | undefined) {
  if (busy) throw new HttpError(409, 'A backup import is already running');
  const file = currentFile();
  if (!file) throw new HttpError(400, 'Upload the backup file first');
  const plain = isSqlite(file);
  if (!plain) {
    if (!keyHex) throw new HttpError(400, 'Enter the 64-digit key');
    mainKey(keyHex); // check the format now, so the error shows straight away
    readHeader(file);
  }
  busy = true;
  stopRequested = false;
  void (async () => {
    const out = plain ? file : path.join(backupDir, 'msgstore.decrypted.db');
    try {
      if (!plain) {
        setBackup({ stage: 'decrypting', progress: { done: 0, total: fs.statSync(file).size }, error: undefined, result: undefined });
        await decryptBackup(file, out, keyHex!, (done, total) => setBackup({ progress: { done, total } }));
      }
      setBackup({ stage: 'importing', progress: { done: 0, total: 0 } });
      const result = await importDatabase(out, (done, total) => setBackup({ progress: { done, total } }));
      log.info(`whatsapp backup: ${result.messages} messages from ${result.chats} chats imported (${result.skipped} already here), ${result.reactions} reactions, ${result.files} files to add`);
      // The decrypted database holds all your chats in the clear: don't keep it. Nor the backup.
      fs.rmSync(out, { force: true });
      fs.rmSync(file, { force: true });
      setBackup({ stage: 'done', progress: undefined, result, file: backupFileInfo() });
    } catch (e) {
      if (!plain) fs.rmSync(out, { force: true });
      const msg = (e as Error).message;
      log.warn(`whatsapp backup: ${msg}`);
      setBackup({ stage: 'failed', progress: undefined, error: msg, file: backupFileInfo() });
    } finally {
      busy = false;
    }
  })();
  return { started: true };
}

function columns(src: DatabaseSync, table: string): Set<string> {
  try {
    return new Set((src.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name));
  } catch {
    return new Set();
  }
}

const SYSTEM_TEXT: Record<number, (who: string, text: string, target: string) => string | null> = {
  1: (who, text) => `${who} changed the group name to “${text}”`,
  4: (who, _t, target) => (target ? `${who} added ${target}` : `${who} joined`),
  5: (who) => `${who} left`,
  6: (who) => `${who} changed this group's icon`,
  11: (who, text) => (text ? `${who} created group “${text}”` : `${who} created this group`),
  12: (who, _t, target) => (target ? `${who} added ${target}` : `${who} added someone`),
  14: (who, _t, target) => (target ? `${who} removed ${target}` : `${who} removed someone`),
  20: (who) => `${who} joined using this group's invite link`,
  27: (who) => `${who} changed the group description`,
};

async function importDatabase(file: string, progress: (done: number, total: number) => void) {
  const src = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = new Set((src.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
    if (!tables.has('message') || !tables.has('jid') || !tables.has('chat')) {
      throw new HttpError(400, "This backup uses WhatsApp's old database layout. Update WhatsApp on your phone and make a new backup.");
    }

    // ids
    const jids = new Map<number, string>();
    for (const r of src.prepare('SELECT _id, raw_string FROM jid').iterate() as Iterable<{ _id: number; raw_string: string | null }>) {
      if (r.raw_string) jids.set(r._id, r.raw_string);
    }
    const phoneOf = new Map<number, number>(); // lid jid row → phone jid row
    if (tables.has('jid_map')) {
      const pairs: [string, string][] = [];
      for (const r of src.prepare('SELECT lid_row_id, jid_row_id FROM jid_map').iterate() as Iterable<{ lid_row_id: number; jid_row_id: number }>) {
        phoneOf.set(r.lid_row_id, r.jid_row_id);
        const lid = jids.get(r.lid_row_id);
        const pn = jids.get(r.jid_row_id);
        if (lid && pn) pairs.push([lid, pn]);
      }
      seedLids(pairs);
    }
    const jidOf = (row: number | null | undefined): string | null => {
      if (!row || row < 0) return null;
      const raw = jids.get(phoneOf.get(row) ?? row) ?? jids.get(row);
      return raw ? bare(raw) : null;
    };
    const resolved = new Map<number, string | null>();
    const jidResolved = async (row: number | null | undefined): Promise<string | null> => {
      if (!row || row < 0) return null;
      if (resolved.has(row)) return resolved.get(row)!;
      const j = jidOf(row);
      const r = j ? await resolve(j) : null;
      resolved.set(row, r);
      return r;
    };

    // chats
    const chats = new Map<number, { jid: string; conv: ConversationRow }>();
    for (const c of src.prepare('SELECT _id, jid_row_id, subject FROM chat').all() as { _id: number; jid_row_id: number; subject: string | null }[]) {
      const j = await jidResolved(c.jid_row_id);
      if (!j || skipChat(j) || !/@(c\.us|g\.us|lid)$/.test(j) || self.isWa(j)) continue;
      chats.set(c._id, { jid: j, conv: getOrCreateWaChat(j, j.endsWith('@g.us') ? c.subject : null) });
    }

    // what we can join (columns differ between WhatsApp versions)
    const mm = columns(src, 'message_media');
    const mq = columns(src, 'message_quoted');
    const ml = columns(src, 'message_location');
    const has = (t: string) => tables.has(t);
    const col = (set: Set<string>, t: string, c: string, as: string) => (set.has(c) ? `${t}.${c} AS ${as}` : `NULL AS ${as}`);
    const sql = `SELECT m._id, m.chat_row_id, m.from_me, m.key_id, m.sender_jid_row_id, m.status, m.timestamp, m.message_type, m.text_data,
        ${col(mm, 'mm', 'file_path', 'file_path')}, ${col(mm, 'mm', 'mime_type', 'mime_type')}, ${col(mm, 'mm', 'file_size', 'file_size')},
        ${col(mm, 'mm', 'media_name', 'media_name')}, ${col(mm, 'mm', 'width', 'width')}, ${col(mm, 'mm', 'height', 'height')},
        ${col(mq, 'mq', 'key_id', 'q_key')}, ${col(mq, 'mq', 'text_data', 'q_text')}, ${col(mq, 'mq', 'from_me', 'q_from_me')}, ${col(mq, 'mq', 'sender_jid_row_id', 'q_sender')},
        ${col(ml, 'ml', 'latitude', 'latitude')}, ${col(ml, 'ml', 'longitude', 'longitude')}, ${col(ml, 'ml', 'place_name', 'place_name')},
        ${has('message_system') ? 'ms.action_type' : 'NULL'} AS action_type,
        ${has('message_system_group') ? 'msg.is_me_joined' : 'NULL'} AS is_me_joined,
        ${has('message_forwarded') && columns(src, 'message_forwarded').has('forward_score') ? 'mf.forward_score' : 'NULL'} AS forward_score,
        ${has('message_vcard') && columns(src, 'message_vcard').has('vcard') ? 'mv.vcard' : 'NULL'} AS vcard
      FROM message m
        ${mm.size ? 'LEFT JOIN message_media mm ON mm.message_row_id = m._id' : ''}
        ${mq.size ? 'LEFT JOIN message_quoted mq ON mq.message_row_id = m._id' : ''}
        ${ml.size ? 'LEFT JOIN message_location ml ON ml.message_row_id = m._id' : ''}
        ${has('message_system') ? 'LEFT JOIN message_system ms ON ms.message_row_id = m._id' : ''}
        ${has('message_system_group') ? 'LEFT JOIN message_system_group msg ON msg.message_row_id = m._id' : ''}
        ${has('message_forwarded') && columns(src, 'message_forwarded').has('forward_score') ? 'LEFT JOIN message_forwarded mf ON mf.message_row_id = m._id' : ''}
        ${has('message_vcard') && columns(src, 'message_vcard').has('vcard') ? 'LEFT JOIN message_vcard mv ON mv.message_row_id = m._id' : ''}
      WHERE m.chat_row_id > 0
      GROUP BY m._id
      ORDER BY m.chat_row_id, m.timestamp, m._id`;
    const targetsOf = new Map<number, number[]>(); // system message → people it's about
    if (has('message_system_chat_participant') && columns(src, 'message_system_chat_participant').has('user_jid_row_id')) {
      for (const r of src.prepare('SELECT message_row_id, user_jid_row_id FROM message_system_chat_participant').iterate() as Iterable<{ message_row_id: number; user_jid_row_id: number }>) {
        const l = targetsOf.get(r.message_row_id) ?? [];
        l.push(r.user_jid_row_id);
        targetsOf.set(r.message_row_id, l);
      }
    }

    const total = Number((src.prepare('SELECT count(*) AS n FROM message WHERE chat_row_id > 0').get() as { n: number }).n);
    const ours = new Map<number, number>(); // backup message row → our message id
    const haveRaw = db.prepare<[string], { id: number }>('SELECT id FROM messages WHERE ext_raw = ?');
    const addMedia = db.prepare("INSERT OR IGNORE INTO wa_media (id, chat, msg, message_id, ts, state, backup_path) VALUES (?, ?, ?, ?, ?, 'pending', ?)");
    const touched = new Set<number>();
    let done = 0;
    let added = 0;
    let skipped = 0;
    let files = 0;

    const nameOf = async (row: number | null, fromMe: boolean) => {
      if (fromMe) return 'You';
      const j = await jidResolved(row);
      if (!j) return 'Someone';
      if (self.isWa(j)) return 'You';
      const n = nameForKey(keyFor(j));
      return n === 'Unknown' ? waNumberOf(j) ?? n : n;
    };

    type Pending = { insert: Parameters<typeof insertMessage>[0]; backupId: number; deleted: boolean; media?: { id: string; path: string | null; chat: string } };
    let batch: Pending[] = [];
    const flush = () => {
      if (!batch.length) return;
      const list = batch;
      batch = [];
      db.transaction(() => {
        for (const p of list) {
          const row = insertMessage(p.insert);
          if (!row) continue;
          ours.set(p.backupId, row.id);
          added++;
          touched.add(row.conversation_id);
          if (p.deleted) updateMessage(row.id, { deleted: 1 });
          if (p.media) {
            addMedia.run(p.media.id, p.media.chat, p.insert.extId!, row.id, p.insert.sentTs, p.media.path);
            files++;
          }
        }
      })();
    };

    for (const m of src.prepare(sql).iterate() as Iterable<Row>) {
      if (stopRequested) break;
      done++;
      if (done % 2000 === 0) {
        flush();
        progress(done, total);
        await new Promise((r) => setImmediate(r)); // let the server answer requests meanwhile
      }
      const chat = chats.get(m.chat_row_id);
      if (!chat || !m.key_id) continue;
      // Already here (from WAHA or an earlier import)?
      const existing = haveRaw.get(m.key_id);
      if (existing) {
        ours.set(m._id, existing.id);
        skipped++;
        continue;
      }
      const { conv, jid: chatJid } = chat;
      const group = chatJid.endsWith('@g.us');
      const fromMe = !!m.from_me;
      const senderJid = fromMe ? null : group ? await jidResolved(m.sender_jid_row_id) : chatJid;
      const author = fromMe ? 'self' : senderJid ? keyFor(senderJid) : 'unknown';
      const extId = `${fromMe}_${chatJid}_${m.key_id}${group && !fromMe && senderJid ? '_' + senderJid : ''}`;
      const ts = freeTimestamp(conv.id, Number(m.timestamp) || 0, author);
      const base = { conversationId: conv.id, sentTs: ts, author, outgoing: fromMe, read: true, extId, status: fromMe ? 'delivered' : null } as const;

      // System lines (group changes)
      if (m.status === 6 || m.message_type === 7) {
        if (!group) continue;
        const make = m.action_type !== null ? SYSTEM_TEXT[m.action_type] : undefined;
        let text: string | null = null;
        if (m.is_me_joined === 1) text = `${await nameOf(m.sender_jid_row_id, false)} added you`;
        else if (make) {
          const targets = await Promise.all((targetsOf.get(m._id) ?? []).map((r) => nameOf(r, false)));
          text = make(await nameOf(m.sender_jid_row_id, fromMe || !m.sender_jid_row_id), m.text_data ?? '', targets.join(', '));
        }
        if (!text) continue;
        batch.push({ insert: { ...base, outgoing: false, status: null, kind: 'system', body: text }, backupId: m._id, deleted: false });
        continue;
      }

      let body: string | null = m.text_data;
      let ranges = null;
      const attachments: Attachment[] = [];
      let media: { id: string; path: string | null; chat: string } | undefined;
      let deleted = false;
      const t = m.message_type;
      if (t === 15) {
        deleted = true;
        body = null;
      } else if (t === 42 || t === 43 || t === 82) {
        body = `${t === 43 ? '🎥 View-once video' : t === 82 ? '🎤 View-once voice message' : '📷 View-once photo'}: open it on your phone`;
      } else if (t === 5 || t === 16) {
        body = m.latitude != null && m.longitude != null ? `📍 ${m.place_name || (t === 16 ? 'Live location' : 'Location')} https://maps.google.com/?q=${m.latitude},${m.longitude}` : '📍 Location';
      } else if (t === 4) {
        const fn = m.vcard ? /^FN[^:]*:(.*)$/m.exec(m.vcard)?.[1]?.trim() : null;
        body = `👤 Contact: ${fn || m.text_data || 'contact card'}`;
      } else if (t === 46 || t === 66 || t === 64) {
        body = `📊 ${m.text_data || 'Poll'}`;
      } else if (MEDIA_TYPES.has(t)) {
        const mime = String(m.mime_type || TYPE_MIME[t] || 'application/octet-stream').split(';')[0].trim();
        const fileName = m.media_name || (t === 9 && m.file_path ? path.basename(m.file_path) : null);
        const ext = path.extname(fileName ?? m.file_path ?? '').replace(/[^A-Za-z0-9.]/g, '').slice(0, 10) || EXT[mime] || '';
        const id = 'wa-' + crypto.createHash('sha1').update(extId).digest('hex').slice(0, 24) + ext;
        const a: Attachment = { id, contentType: mime, filename: fileName, size: m.file_size || null };
        if (m.width && m.height) Object.assign(a, { width: m.width, height: m.height });
        if (t === 2 && /ogg|opus/i.test(mime)) a.voiceNote = true;
        if (t === 13) a.gif = true;
        if (t === 20) a.sticker = true;
        if (!fs.existsSync(localPath(id))) a.missing = !m.file_path; // no file on the phone either
        attachments.push(a);
        media = a.missing ? undefined : { id, path: m.file_path, chat: chatJid };
        if (t === 20) body = null;
      } else if (!body) continue; // calls, encryption notices, unknown types

      if (body && !deleted && t !== 5 && t !== 16) {
        const rich = await richFromWa(body, conv);
        body = rich.body;
        ranges = rich.ranges;
      }
      let quote = null;
      if (m.q_key) {
        const q = haveRaw.get(m.q_key);
        const qRow = q ? getMessage(q.id) : undefined;
        const qAuthor = qRow ? qRow.author : m.q_from_me ? 'self' : keyFor((await jidResolved(m.q_sender)) ?? (group ? 'unknown' : chatJid));
        let text = qRow ? renderBody(qRow.body, qRow.ranges)?.text ?? null : null;
        if (text === null && m.q_text) {
          const rich = await richFromWa(m.q_text, conv);
          text = renderBody(rich.body, rich.ranges ? JSON.stringify(rich.ranges) : null)?.text ?? m.q_text;
        }
        quote = { sentTs: qRow?.sent_ts ?? 0, author: qAuthor, text: text || 'Attachment' };
      }
      batch.push({
        insert: { ...base, kind: t === 20 ? 'sticker' : 'message', body, ranges, attachments, quote, forwarded: m.forward_score ? (m.forward_score >= 5 ? 2 : 1) : 0 },
        backupId: m._id,
        deleted,
        media,
      });
    }
    flush();
    progress(done, total);

    // Reactions
    let reactions = 0;
    if (has('message_add_on') && has('message_add_on_reaction')) {
      const byMsg = new Map<number, Reaction[]>();
      const q = `SELECT a.parent_message_row_id AS parent, a.from_me, a.sender_jid_row_id AS sender, r.reaction
        FROM message_add_on a JOIN message_add_on_reaction r ON r.message_add_on_row_id = a._id`;
      for (const r of src.prepare(q).iterate() as Iterable<{ parent: number; from_me: number; sender: number | null; reaction: string | null }>) {
        const id = ours.get(r.parent);
        if (!id || !r.reaction) continue;
        const who = r.from_me ? 'self' : keyFor((await jidResolved(r.sender)) ?? 'unknown');
        const list = byMsg.get(id) ?? (JSON.parse(getMessage(id)?.reactions ?? '[]') as Reaction[]);
        const next = list.filter((x) => x.author !== who);
        next.push({ emoji: r.reaction, author: who });
        byMsg.set(id, next);
      }
      db.transaction(() => {
        for (const [id, list] of byMsg) {
          updateMessage(id, { reactions: JSON.stringify(list) });
          reactions += list.length;
        }
      })();
    }

    for (const id of touched) emitConversation(id);
    return { chats: touched.size, messages: added, skipped, reactions, files };
  } finally {
    src.close();
  }
}

// ---------- media folder ----------

/**
 * Match files in the backup folder (the phone's WhatsApp/Media folder, copied over) to messages from
 * the backup, by the path the backup recorded ("Media/WhatsApp Images/IMG-….jpg").
 */
export function startMediaScan() {
  if (busy) throw new HttpError(409, 'A backup import is already running');
  if (!fs.existsSync(backupDir)) throw new HttpError(400, `Copy the phone's WhatsApp "Media" folder into ${backupDir} first`);
  busy = true;
  stopRequested = false;
  void (async () => {
    // Everything here is asynchronous and reports at least once a second: the folder can hold
    // 100,000 files on a network share, and a single video can take a while to copy.
    let lastReport = 0;
    const report = (p: { done: number; total: number; phase: 'scan' | 'copy' }, force = false) => {
      if (!force && Date.now() - lastReport < 1000) return;
      lastReport = Date.now();
      setBackup({ progress: p });
    };
    try {
      setBackup({ stage: 'media', progress: { done: 0, total: 0, phase: 'scan' }, error: undefined });
      // Index every file once: by "folder/name" and by name alone.
      const byTail = new Map<string, string>();
      const byName = new Map<string, string>();
      const folders = new Map<string, number>(); // folder name → files, for the log
      let seen = 0;
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > 8 || stopRequested) return;
        let entries: fs.Dirent[];
        try {
          entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) await walk(p, depth + 1);
          else if (e.isFile()) {
            seen++;
            byName.set(e.name.toLowerCase(), p);
            byTail.set((path.basename(dir) + '/' + e.name).toLowerCase(), p);
            folders.set(path.basename(dir), (folders.get(path.basename(dir)) ?? 0) + 1);
          }
        }
        report({ done: seen, total: 0, phase: 'scan' });
      };
      await walk(backupDir, 0);
      log.info(`whatsapp backup: ${seen} files in the media folder (${[...folders].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([f, n]) => `${f}: ${n}`).join(', ')})`);
      const rows = db.prepare<[], { id: string; message_id: number | null; backup_path: string | null }>("SELECT id, message_id, backup_path FROM wa_media WHERE backup_path IS NOT NULL AND state != 'done'").all();
      let found = 0;
      let i = 0;
      const notFound: string[] = [];
      for (const r of rows) {
        if (stopRequested) break;
        i++;
        report({ done: i, total: rows.length, phase: 'copy' });
        if (i % 50 === 0) await new Promise((res) => setImmediate(res));
        const parts = r.backup_path!.replace(/\\/g, '/').split('/');
        const name = parts.pop()!.toLowerCase();
        const tail = ((parts.pop() ?? '') + '/' + name).toLowerCase();
        const srcFile = byTail.get(tail) ?? byName.get(name);
        if (!srcFile) {
          if (notFound.length < 10) notFound.push(r.backup_path!);
          continue;
        }
        const dest = localPath(r.id);
        try {
          if (!fs.existsSync(dest)) {
            await fs.promises.copyFile(srcFile, dest + '.part');
            await fs.promises.rename(dest + '.part', dest);
          }
        } catch (e) {
          if (notFound.length < 10) notFound.push(`${r.backup_path} (copy failed: ${(e as Error).message})`);
          continue;
        }
        found++;
        db.prepare('DELETE FROM wa_media WHERE id = ?').run(r.id);
        const m = r.message_id ? getMessage(r.message_id) : undefined;
        if (m?.attachments) {
          const atts = (JSON.parse(m.attachments) as Attachment[]).map((a) => {
            if (a.id !== r.id) return a;
            if (a.sticker) addSticker(a.id);
            const b = { ...a, size: fs.statSync(dest).size };
            delete b.missing;
            return b;
          });
          emitMessage(updateMessage(m.id, { attachments: JSON.stringify(atts) }));
        }
      }
      const missing = i - found;
      log.info(`whatsapp backup: matched ${found} of ${rows.length} files from the media folder${stopRequested ? ' (stopped)' : ''}`);
      if (notFound.length) log.info(`whatsapp backup: not in the folder, for example: ${notFound.join(' | ')}`);
      const prev = getWaState().backup?.result ?? { chats: 0, messages: 0, reactions: 0, files: 0, skipped: 0 };
      setBackup({ stage: 'done', progress: undefined, result: { ...prev, mediaFound: found, mediaMissing: missing } });
    } catch (e) {
      log.warn(`whatsapp backup: media: ${(e as Error).message}`);
      setBackup({ stage: 'failed', progress: undefined, error: (e as Error).message });
    } finally {
      busy = false;
    }
  })();
  return { started: true };
}

/**
 * Stickers from the phone: the "WhatsApp Stickers" folder in the media folder you copied over. Each
 * one is added to the stickers you can send (Messenger Web keeps a copy).
 */
export async function importStickersFromFolder() {
  if (!fs.existsSync(backupDir)) throw new HttpError(400, `Copy the phone's WhatsApp "Media" folder into ${backupDir} first`);
  const files: string[] = [];
  const walk = async (dir: string, depth: number, inStickers: boolean): Promise<void> => {
    if (depth > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1, inStickers || /^whatsapp stickers$/i.test(e.name));
      else if (inStickers && e.isFile() && /\.webp$/i.test(e.name)) files.push(p);
    }
  };
  await walk(backupDir, 0, false);
  if (!files.length) throw new HttpError(400, 'No "WhatsApp Stickers" folder with stickers found in the backup folder');
  let added = 0;
  // Oldest first, so the newest end up at the front of the list.
  files.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
  for (const f of files) {
    const buf = await fs.promises.readFile(f);
    const id = 'stk-' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 24) + '.webp';
    if (!fs.existsSync(localPath(id))) {
      await fs.promises.writeFile(localPath(id), buf);
      added++;
    }
    addSticker(id);
  }
  log.info(`whatsapp backup: ${files.length} stickers from the media folder (${added} new)`);
  return { found: files.length, added };
}
