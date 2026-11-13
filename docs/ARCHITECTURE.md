# How Messenger Web works

One container (`signal-web` on Unraid) that puts Signal and WhatsApp in one web app. It doesn't speak
either protocol itself; it drives two other containers:

```
 browser ──HTTPS/JSON + Server-Sent Events──▶ Messenger Web (Node 22, this repo) ──▶ SQLite (DATA_DIR)
                                                   │                    │
                                   REST + websocket│                    │REST + websocket
                                                   ▼                    ▼
                                signal-cli-rest-api (Signal)      WAHA, WEBJS engine (WhatsApp Web
                                bbernhard, json-rpc mode          in Chrome/Chromium inside WAHA)
```

- **Server** (`server/src`, TypeScript, no runtime dependencies: node:sqlite, built-in fetch/WebSocket).
  Everything is stored locally, so history stays when the other containers are recreated.
- **Web** (`web/src`, React 19, bundled by esbuild into `web/dist`, served by the server).
- **Live updates**: the server pushes events to every open tab over `GET /api/events` (Server-Sent
  Events). On every (re)connect the browser reloads the chat list and its open chats, so a dropped
  connection never loses anything.

## A message coming in

1. **Signal**: signal.ts holds a websocket to signal-cli-rest-api; each envelope goes to
   ingest.ts → `insertMessage` (store.ts) → `broadcast({type:'message'})`.
2. **WhatsApp**: whatsapp.ts holds WAHA's event websocket; events are handled one at a time in
   `handleEvent` → `ingestMessage` → store → broadcast. The history import uses the same
   `ingestMessage`, guarded by a per-message lock so the two never store a message twice.
3. The browser's store (web/src/store.ts) applies the event; React re-renders.

## A message going out

1. The browser posts to `/api/conversations/:id/send` (routes.ts).
2. The server stores it as `pending` right away (`queueOutgoing`) and answers, so it shows at once.
3. In the background it's delivered: Signal through signal-api.ts, WhatsApp through `deliverWa`. The
   message's status follows (sent → delivered → read) from receipts/acks.

## Identities

| What | Signal | WhatsApp |
|---|---|---|
| Person ("key") | uuid, or `+number` when that's all we know | `wa:<jid>`: `316…@c.us` (number) or `…@lid` (privacy id) |
| You | `self` | `self` |
| Chat | `conversations.peer_uuid/peer_number`, groups `group_id` | `conversations.wa_id` (`…@c.us`, `…@lid`, `…@g.us`) |
| Message | `sent_ts` (Signal's identity on the wire) | `ext_id` = `true|false_<chat>_<RAW>[_<author>]`, `ext_raw` = RAW |

WhatsApp mixes number ids and privacy ids for the same person. `resolve()` turns a privacy id into a
number when that's known; links are remembered in kv (`lid:<lid>` → number, `lidof:<number>` → lid)
and come from WAHA, from the Android backup (`jid_map`) and from looking up group members.

## Data

The schema is `MIGRATIONS` in server/src/db.ts, with a comment on every table and column. Main tables:
`conversations`, `messages`, `message_receipts` (per-recipient ticks), `contacts` (Signal),
`wa_contacts`, `wa_media` (WhatsApp history files not downloaded yet), `message_edits` (earlier
versions of edited messages, saved in `updateMessage` whenever text changes as an edit), `deleted_messages`
(what someone else deleted, or a disappearing message whose timer ran out; saved in
`deleteMessageContent`, shown when the message is clicked; your own deletions aren't kept), `sessions`, and `kv`.

### kv keys

Small settings, caches and one-off flags. `<x>` is a variable part.

| Key | What it holds |
|---|---|
| `setting:<name>` | a setting changed in the app (settings.ts; the environment gives defaults) |
| `self_number`, `self_uuid`, `self_profile` | your Signal account |
| `wa_me` | your WhatsApp id |
| `emoji_usage` | how often you use each emoji (shared by all browsers) |
| `avatar_rev:<id>`, `wa_avatar_rev:<jid>` | bumped when a picture changes, so browsers reload it |
| `lid:<lid>`, `lidof:<number>` | WhatsApp privacy id ↔ number links (`''` = asked, none) |
| `wa_pin:`, `wa_mute:`, `wa_arch:`, `wa_unread:<jid>` | last state seen on the phone, to sync only changes |
| `wa_history_v2`, `wa_hist_complete:<jid>` | history import progress |
| `wa_read_at:<convId>` | when you last read a WhatsApp chat (here, or the phone said 0 unread); messages sent before it come in as read |
| `wa_last_event_at` | when WhatsApp events last came in (catch-up after a restart starts there) |
| `waquote:<msgId>` | which id spelling WhatsApp Web accepts for replying to a message |
| `waalias:<raw>` | an HD copy's raw id → the message row it was merged into |
| `wahd_wait:<raw>` | an HD copy that arrived before its original |
| `gset:<convId>` | group settings as last seen (who may send/edit/add, approval) |
| `glabels:<convId>`, `glabels_bk:<convId>`, `glabels_ev:<convId>` | member labels: shown / from the backup / from live changes |
| `sgedit:`, `sglink:`, `sglink_want:<convId>` | Signal group settings the API doesn't report correctly |
| `wa_stickers`, `local_sticker_packs` | WhatsApp sticker library; packs from the sticker manager |
| `*_v1`, `*_v2` (e.g. `wa_dupes_v1`, `wa_hd_pairs_v2`, `wa_mention_lids_v1`) | one-off clean-ups done; bump the version to run one again |

## Things that bit us (keep in mind)

- **WEBJS is WhatsApp Web in a browser.** Heavy calls (getChats, looking up many messages) make it
  unresponsive for minutes. Never loop over many WAHA calls at once: few, one at a time, with pauses.
- **Events only flow while both WAHA and this app run.** Anything that arrives during a restart never
  comes as an event; `catchUpWa` fetches it: one chat list call, then each chat active since the
  interruption, back to that moment, filling holes too. "Since when" (`missedSince`) is noted the moment
  the stream is interrupted (start-up from kv `wa_last_event_at`, the session stopping, the websocket
  closing), not when the catch-up runs: by then new events have moved "last event" on. The ↻ button
  looks back a week.
- **Two people can send in the same instant** (WhatsApp counts in seconds; only chat + time + author is
  unique). Pages of messages are cut by time, so `listMessages*` always include every message of the
  moment at the cut-off (`withTies`).
- **WhatsApp Web hands over old messages again** as new, or counts read ones as unread. Anything sent
  more than 2 minutes before you last read that chat (`wa_read_at:`) is stored read and WhatsApp is told.
- **Signal group changes don't say what changed**: only an UPDATE message from whoever did it. The
  sender is remembered (`groupActors` in ingest.ts), the group is fetched again, and
  `noteSignalGroupChanges` writes the lines from the difference. WhatsApp sends each change itself
  (`groupNotice`).
- **Signal drops the middle-name field** of your phone's contacts, where Dutch tussenvoegsels often are
  ("Mary de Ruijter" → "Mary Ruijter"). `contactName` fills in words missing *in the middle* from the
  Signal profile or the WhatsApp contact with the same number (`fullerName`).
- **Private replies** quote a group message from a one-to-one chat: the quote has `chat` (the group's
  conversation id), set by `quoteFor` when sending and found by id (WhatsApp) or time + author (Signal,
  `findQuotedElsewhere`) when receiving. WhatsApp links it by the group message's id; Signal has no
  private replies, but its quotes carry their text, so it shows as a normal quote.
- **Replies** only link when WhatsApp Web has the quoted message; otherwise they go as a text quote.
- **HD photos/videos** arrive as two messages; the second has `associationType: *_DUAL_UPLOAD` and
  `parentMsgKey`. They're shown as one.
- **Member labels** only exist in WhatsApp Web for labels set after WAHA was linked. Older ones come
  from the Android backup (`group_participant_user.label`).
- **Mentions** may name someone by privacy id, of any length (14 digits is common).
- **Custom link previews** (`/api/send/link-custom-preview`) aren't implemented on WEBJS: on that error the
  message goes as text with WhatsApp's own preview, and kv `wa_no_custom_preview` skips the attempt from then on.
- **Sending video** needs WAHA's Chrome image (`devlikeapro/waha:chrome`); Chromium lacks the codecs.
- **A live connection can die silently** (sleep, network change, a proxy): the browser keeps waiting and
  shows nothing new. The server sends `{type:'ping'}` every 25 s; the page reconnects (and resyncs) after
  60 s of silence, on coming back to the tab, or when the network returns (App.tsx `useLiveEvents`).
- **Files the networks can't take**: large photos are made smaller in the browser before upload
  (web/src/shrink.ts, with a note in the message box); what the browser can't read or convert (HEIC, TIFF,
  video other than MP4/H.264) is converted by ffmpeg on the server just before sending (convert.ts,
  `makeSendable` in routes.ts). Audio to WhatsApp goes as a voice message, converted by WAHA.
- **Big files** (over 20 MB) are uploaded in pieces first (server/src/uploads.ts, `uploadInPieces` in
  web/src/api.ts), so a proxy's upload limit doesn't matter, then sent as `{upload: id}`. Their base64 is
  only made in `makeSendable` (an empty entry = "read the stored file"), after videos over
  `SEND_LIMIT_MB` (95; WhatsApp `WA_SEND_LIMIT_MB`, 36, because WAHA refuses requests over 50 MB) are
  made smaller by ffmpeg to fit. Other files over that limit can't be sent: the message box says so
  before you try. Video is encoded on Intel's video chip (VAAPI) when /dev/dri is in the container, with
  the processor (libx264) as fallback (`encodeVideo` in convert.ts).
- **Browsers allow ~6 connections per site.** Nothing may hold a request open: pictures and files that
  aren't ready answer at once (404 + retry) and are fetched in the background.
- **Signal's REST API** can't upload sticker packs, join groups by link, make a new invite link or remove
  a group picture, and reports "who may edit group info" wrongly.
- **One-off fixes** run at start-up or after connecting, each behind a kv flag. If a first version
  marked itself done too early, bump the flag's version.

## Debugging on the server

The app's data is in the container at `/data` (`signal-web.db`, `attachments/`, `avatars/`,
`whatsapp-backup/`). Read-only queries can be run without stopping anything:

```bash
docker exec signal-web node --no-warnings -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/data/signal-web.db", { readOnly: true });
console.log(db.prepare("SELECT id, network, kind, group_name FROM conversations LIMIT 5").all());'
```

The container's environment has `WAHA_URL` and `WAHA_API_KEY`, so WAHA can be asked from inside it
(`fetch(process.env.WAHA_URL + "/api/default/…", {headers: {"X-Api-Key": process.env.WAHA_API_KEY}})`)
without anyone typing the key. Never ask for keys or passwords in chat.
