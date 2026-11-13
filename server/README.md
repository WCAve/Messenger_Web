# Server (`server/src`)

Node 22, TypeScript, **no runtime dependencies** (node:sqlite, built-in fetch/WebSocket/http). Built
with `tsc` into `server/dist`. Every file starts with a comment saying what it does; this is the map.
How it all fits together: [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

| Module | What it does |
|---|---|
| `index.ts` | Start-up, one-off clean-ups, static files, security headers, crash safety |
| `config.ts` | Environment variables (list with explanations: README.md) |
| `settings.ts` | Settings changed in the app (stored in kv, the environment gives defaults) |
| `db.ts` | SQLite, the schema (`MIGRATIONS`, commented), `kvGet`/`kvSet` |
| `http.ts` | The router: routes, auth, JSON/raw bodies, cookies, file sending, client address |
| `auth.ts` | Password check, sessions, sign-in rate limit |
| `events.ts` | Server-Sent Events to open tabs (`broadcast`) and the event types |
| `routes.ts` | The HTTP API (see its header for the conventions) |
| `store.ts` | Data access and the JSON shapes sent to the browser; people's keys; names |
| `richtext.ts` | Mentions and styles as Signal stores them (U+FFFC placeholders + UTF-16 ranges) |
| **Signal** | |
| `signal-api.ts` | Thin client for signal-cli-rest-api |
| `signal.ts` | The receive websocket and the Signal connection state; contacts/groups directory |
| `ingest.ts` | Signal envelopes → messages, receipts, reactions, edits, calls, typing |
| `attachments.ts` | Files: copied out of signal-cli into DATA_DIR/attachments, served by id |
| `convert.ts` | Making files sendable with ffmpeg (in the Docker image): HEIC/TIFF → JPEG, odd video → MP4/H.264, huge photos |
| `avatars.ts` | Signal profile and group pictures, cached on disk |
| `stickers.ts` | Signal sticker packs: download and decrypt from Signal's CDN (`signal-ca.ts` = its root cert) |
| `expiry.ts` | Disappearing messages |
| **WhatsApp** | |
| `waha-api.ts` | Thin client for WAHA (every endpoint we use) |
| `whatsapp.ts` | Everything else WhatsApp: connection, events, history import, sending, presence, avatars… (section map in its header) |
| `groups.ts` | Group management for both networks (create, members, admins, settings, link, requests, labels) |
| `wabackup.ts` | Android backup import (crypt15 decrypt, msgstore → messages, media folder, stickers, member labels) |
| **Both** | |
| `stickerpacks.ts` | Your own sticker packs (sticker manager) |
| `linkpreview.ts` | Link previews for messages you send (public addresses only) |
| `emojiusage.ts` | Emoji usage counts for "frequently used" |

## Conventions

- **Add a column or table**: append to `MIGRATIONS` in db.ts (never edit an old entry), comment it,
  add the field to the row type in store.ts and, if the browser needs it, to the DTO and
  web/src/types.ts.
- **A one-off fix of existing data**: run it in index.ts (or `afterConnect` in whatsapp.ts when it
  needs WhatsApp) behind a kv flag `<name>_v1`; log what it did. Don't mark it done if it couldn't
  finish. Bump the version to run it again.
- **WAHA calls**: WhatsApp Web is slow and fragile with many requests. Batch nothing big; one at a
  time with pauses; cache answers in kv when they don't change.
- **Push every change** to open tabs: `emitConversation(id)`, `emitMessage(row)`, `broadcast(...)`.
- **Errors for the user**: throw `new HttpError(status, 'Plain sentence.')`; the browser shows the
  message as is.
- **Logging**: `log.info/warn` in whatsapp.ts and wabackup.ts, `log(level, msg)` elsewhere; lines a user
  may be asked to send start with `whatsapp:` / `whatsapp backup:`.
