import fs from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.attachmentsDir, { recursive: true });

const sqlite = new DatabaseSync(config.dbPath);
sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

type Params = SQLInputValue[] | [Record<string, SQLInputValue>];

/** Tiny typed wrapper around node:sqlite so call sites read like better-sqlite3. */
export interface Stmt<P extends Params, R> {
  get(...params: P): R | undefined;
  all(...params: P): R[];
  run(...params: P): { changes: number; lastInsertRowid: number };
}

const cache = new Map<string, ReturnType<DatabaseSync['prepare']>>();

export const db = {
  prepare<P extends Params = Params, R = Record<string, unknown>>(sql: string): Stmt<P, R> {
    let s = cache.get(sql);
    if (!s) {
      s = sqlite.prepare(sql);
      cache.set(sql, s);
    }
    const stmt = s;
    return {
      get: (...p) => stmt.get(...(p as SQLInputValue[])) as R | undefined,
      all: (...p) => stmt.all(...(p as SQLInputValue[])) as R[],
      run: (...p) => {
        const r = stmt.run(...(p as SQLInputValue[]));
        return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
      },
    };
  },
  exec(sql: string) {
    sqlite.exec(sql);
  },
  transaction<A extends unknown[], T>(fn: (...args: A) => T): (...args: A) => T {
    return (...args: A) => {
      sqlite.exec('BEGIN');
      try {
        const r = fn(...args);
        sqlite.exec('COMMIT');
        return r;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    };
  },
  close() {
    sqlite.close();
  },
};

const MIGRATIONS: string[] = [
  `
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);

  CREATE TABLE sessions (
    token TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  -- People we know about. key = uuid when known, otherwise the phone number.
  CREATE TABLE contacts (
    key TEXT PRIMARY KEY,
    uuid TEXT,
    number TEXT,
    name TEXT,          -- name from your address book / nickname
    profile_name TEXT,  -- name they set in their Signal profile
    envelope_name TEXT, -- name seen on incoming messages
    username TEXT,
    blocked INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER
  );
  CREATE INDEX contacts_uuid ON contacts(uuid);
  CREATE INDEX contacts_number ON contacts(number);

  CREATE TABLE conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
    peer_uuid TEXT,
    peer_number TEXT,
    group_id TEXT UNIQUE,      -- signal-cli internal group id (base64)
    group_name TEXT,
    group_members TEXT,        -- JSON array of numbers/uuids
    last_message_at INTEGER,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX conversations_peer_uuid ON conversations(peer_uuid);
  CREATE INDEX conversations_peer_number ON conversations(peer_number);

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sent_ts INTEGER NOT NULL,          -- Signal message timestamp (its identity on the wire)
    author TEXT NOT NULL,              -- 'self' or contact key (uuid / number)
    author_number TEXT,
    outgoing INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'message', -- message | sticker | system
    body TEXT,
    attachments TEXT,                  -- JSON
    quote TEXT,                        -- JSON {sentTs, author, text}
    reactions TEXT,                    -- JSON [{emoji, author}]
    status TEXT,                       -- outgoing: pending | sent | delivered | read | failed
    error TEXT,
    read INTEGER NOT NULL DEFAULT 1,
    edited INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    received_at INTEGER NOT NULL,
    UNIQUE (conversation_id, sent_ts, author)
  );
  CREATE INDEX messages_conv_ts ON messages(conversation_id, sent_ts);
  CREATE INDEX messages_sent_ts ON messages(sent_ts);
  CREATE INDEX messages_unread ON messages(conversation_id) WHERE read = 0;
  `,
  `
  ALTER TABLE conversations ADD COLUMN group_description TEXT;
  ALTER TABLE conversations ADD COLUMN group_admins TEXT;      -- JSON array of numbers/uuids
  ALTER TABLE contacts ADD COLUMN about TEXT;
  ALTER TABLE contacts ADD COLUMN has_avatar INTEGER NOT NULL DEFAULT 0;

  -- Delivery/read receipts per recipient, for outgoing messages.
  CREATE TABLE message_receipts (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    recipient TEXT NOT NULL,   -- contact key
    delivered_at INTEGER,
    read_at INTEGER,
    PRIMARY KEY (message_id, recipient)
  );
  `,
  `
  ALTER TABLE messages ADD COLUMN sticker TEXT;  -- JSON {packId, stickerId}
  `,
  `
  -- 0 = an outgoing message whose real Signal timestamp we never learned (sent before the fix for
  -- the new send-response format). Receipts and reactions for it are matched by closeness instead.
  ALTER TABLE messages ADD COLUMN ts_confirmed INTEGER NOT NULL DEFAULT 1;
  UPDATE messages SET ts_confirmed = 0 WHERE outgoing = 1;
  `,
  `
  -- Mentions and text styles: {"mentions":[{start,length,key}],"styles":[{start,length,style}]}
  -- over a body that has U+FFFC where each mention goes. NULL for older rows (mentions inline).
  ALTER TABLE messages ADD COLUMN ranges TEXT;
  ALTER TABLE messages ADD COLUMN preview TEXT;  -- JSON {url, title, description, image}
  ALTER TABLE messages ADD COLUMN expires_in INTEGER NOT NULL DEFAULT 0;  -- disappearing timer, seconds
  ALTER TABLE messages ADD COLUMN expires_at INTEGER;  -- ms; set once the timer starts
  CREATE INDEX messages_expires_at ON messages(expires_at) WHERE expires_at IS NOT NULL;
  ALTER TABLE conversations ADD COLUMN expire_timer INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Polls: {question, options, multiple, closed, votes: {<voter key>: {options: [0-based], count}}}
  ALTER TABLE messages ADD COLUMN poll TEXT;
  -- Chat list: pinned chats (the time they were pinned, for order) and muting (ms; 0 = not muted).
  ALTER TABLE conversations ADD COLUMN pinned_at INTEGER;
  ALTER TABLE conversations ADD COLUMN muted_until INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- WhatsApp (through WAHA). People are keyed "wa:<jid>" in messages, so they never mix with Signal contacts.
  ALTER TABLE conversations ADD COLUMN network TEXT NOT NULL DEFAULT 'signal';
  ALTER TABLE conversations ADD COLUMN wa_id TEXT;  -- chat id: …@c.us, …@g.us or …@lid
  CREATE UNIQUE INDEX conversations_wa_id ON conversations(wa_id) WHERE wa_id IS NOT NULL;
  ALTER TABLE messages ADD COLUMN ext_id TEXT;  -- WhatsApp message id
  CREATE INDEX messages_ext_id ON messages(ext_id) WHERE ext_id IS NOT NULL;
  CREATE TABLE wa_contacts (
    jid TEXT PRIMARY KEY,
    number TEXT,
    name TEXT,        -- name in your address book
    push_name TEXT,   -- name they set themselves
    updated_at INTEGER
  );
  `,
  `
  -- "Mark as unread" on a chat (cleared when you open it).
  ALTER TABLE conversations ADD COLUMN marked_unread INTEGER NOT NULL DEFAULT 0;
  -- WhatsApp "about" text, fetched when you open someone's info.
  ALTER TABLE wa_contacts ADD COLUMN about TEXT;
  ALTER TABLE wa_contacts ADD COLUMN about_at INTEGER;
  `,
];

function migrate() {
  const current = Number((sqlite.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      sqlite.exec(MIGRATIONS[v]);
      sqlite.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}
migrate();

const getKv = db.prepare<[string], { value: string }>('SELECT value FROM kv WHERE key = ?');
const setKvStmt = db.prepare<[string, string], never>(
  'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
);

export function kvGet(key: string): string | undefined {
  return getKv.get(key)?.value;
}
export function kvSet(key: string, value: string) {
  setKvStmt.run(key, value);
}
