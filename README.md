# Caution: 100% Vibe Code. No Guarantees. Do not expose to the internet. Internal use only

# Messenger Web

One self-hosted, WhatsApp-Web-style browser interface for [Signal](https://signal.org) **and WhatsApp**, on Unraid or any Docker host.
It links to your phone on each network as a linked device, like Signal Desktop and WhatsApp Web, and shows all your chats in one list.
It started as a fork of [Signal Web](https://github.com/WCAve/Signal_Web).

![Chat view](docs/chat.png)

```
                         ┌─ REST + WebSocket ─▶ signal-api (signal-cli-rest-api) ─▶ Signal
Browser ──HTTPS/SSE──▶ messenger-web
                (UI, auth, history DB)
                         └─ REST + WebSocket ─▶ WAHA (WhatsApp HTTP API) ──────────▶ WhatsApp
```

Either network is optional: set `SIGNAL_API_URL=off` for WhatsApp only, or leave `WAHA_URL` empty for Signal only.

> **WhatsApp warning.** WAHA is an unofficial WhatsApp client. Using it is against WhatsApp's terms, and accounts can be banned, mostly ones that send in bulk. Normal personal use rarely has problems, but you take that risk.

## What works

- Linking via QR code, right in the web UI
- Chat list with unread counts, typing and delivery state; the unread total in the tab title and inside the tab icon (muted chats left out)
- Search: chats and messages from the chat list, or inside one chat (magnifier in the chat header); a result opens the chat at that message
- Go to date: pick a day in the chat's search panel, or *Go to date…* in the chat menu, to jump to that day's first message
- 1:1 and group chats, with history stored in SQLite
- Text, links, replies (quotes), reactions (quick bar plus every emoji)
- @mentions: type `@` in a group to pick someone; mentions of you are highlighted
- Text formatting, both ways: `*bold*`, `_italic_`, `~strikethrough~`, `` `monospace` ``, `||spoiler||` (click to reveal). Ctrl+B, Ctrl+I, Ctrl+Shift+X and Ctrl+Shift+M wrap the selection
- Link previews, both ways: when you type an https link, Messenger Web fetches the page's title and picture (like Signal Desktop; can be switched off in Settings → Privacy, or with `SEND_LINK_PREVIEWS=false`)
- Polls: vote, create (📊 button next to the paperclip) and end your own polls
- Forward messages (text, files, stickers) to up to 5 chats
- Pin (up to 10), mute, archive and mark as unread from the ⋮ menu in the chat header, or the ⌄ button on a chat in the list. On Signal these stay in Messenger Web; on WhatsApp, mutes and "marked as unread" are kept in step with your phone, and chats you pin or unpin on your phone are copied (WAHA can't pin chats on the phone)
- Call lines in the chat: incoming, missed and answered calls (calls themselves happen on your phone)
- Drafts per chat (kept in this browser), and an "N unread messages" divider when you open a chat
- Disappearing messages: set the timer from chat or group info, messages and their files are deleted from Messenger Web when it runs out. Switching the timer off needs your phone (the Signal API can't send "off" yet)
- Emoji in Google's Noto style by default (or Microsoft Fluent 3D, Twemoji or your system's, in Settings → Emoji), built in so nothing loads from elsewhere
- Emoji picker with your most used emoji first (counted on the server, so every browser shares them), and Slack/WhatsApp-style `:shortcode` suggestions (`:lau` → 😆, `:thumbsup:` → 👍). Names several emoji share, like `:laugh:`, give the one you use most
- GIF picker (Giphy, needs a free key; see [Settings](#settings)); received GIFs loop silently
- Stickers: shown in chats, sent from the sticker tab (packs installed on your phone appear automatically), and new packs added by pasting a signal.art link
- One sticker picker for every chat: Signal packs, your own packs and recent stickers. A **sticker manager** (⋮ menu, or the gear in the picker) puts WhatsApp stickers into your own packs: received ones, ones imported from the backup folder, or your own images. Signal packs go as Signal stickers in Signal chats and as WhatsApp stickers in WhatsApp chats; your own packs go as WhatsApp stickers in WhatsApp chats and as a picture in Signal chats (Signal's API can't upload packs)
- Settings: your profile (picture, first name, about), theme (System, Light, Dark blue, or Dark green with WhatsApp-like colours), Enter-to-send, notifications and their previews, read receipts and typing indicators, sign out everywhere
- Change a group's picture from Group info (if the group lets you)
- Groups, the same on Signal and WhatsApp: make a new group (⋮ → New group, or New chat → New group); in Group info change the name, description and picture, add and remove people, make or dismiss admins, choose who may edit the info, send messages and add members, approve new members, the invite link, join requests, and leaving. Joining with a link is WhatsApp only (Signal's API can't); Signal's API also can't make a new invite link or remove a group picture
- WhatsApp member labels: shown next to names in Group info and on group messages; set your own there. WhatsApp Web (and so WAHA) only knows labels set after it was linked: the Android backup import brings in the older ones (also on their own: "Import member labels only")
- Resizable chat list: drag the divider, or double-click it to reset
- Sending and receiving images, video, audio and files (paste, drag-and-drop or the paperclip)
- Group and contact info: description, members and admins, profile pictures, shared media, docs and links
- Delivery and read ticks, plus per-person "Read by / Delivered to" in Message info
- Read receipts and typing indicators, both ways
- Edit your own text messages for 24 hours (↑ in an empty message box edits your last one), delete for everyone, retry failed sends
- Edits and deletes made by others are shown
- Browser notifications, dark mode, layout for wide screens and phones

In a group, the ticks turn into two outlined circles once anyone has received the message, and fill in once every member has read it. Message info (ⓘ on your own messages) shows exactly who has received and read it. People who switched off read receipts never count as read, so with such a member in the group the ticks stay outlined.

### WhatsApp

WhatsApp chats sit in the same list as Signal chats, with a small **W** or **S** on each avatar when both are set up.

- Recent chats and messages are imported after linking (40 chats × 40 messages by default). Settings → WhatsApp lets you pick more, up to "as many as possible", and import again; messages you already have are skipped. Photos, videos and files in imported history are fetched when you open them (old ones WhatsApp no longer has show as "not available any more"); Settings → WhatsApp can also download them in the background
- Text with WhatsApp formatting, replies, @mentions with suggestions, reactions, photos/videos/files both ways, voice notes and GIFs that others send
- Edit (15 minutes, WhatsApp's limit) and delete for everyone, typing and "recording audio…" indicators, read receipts, ticks, per-person read lists in groups
- Contact info shows someone's About text; group info shows the group description
- Starting a chat with a number checks it's on WhatsApp first
- Group events as lines in the chat: joined, left, added, removed, admins, name, description, picture and settings changes
- View-once photos and videos show as a placeholder (open them on your phone; WhatsApp Web can't either)
- "Forwarded" and "Forwarded many times" labels; forwarding between WhatsApp chats is a real WhatsApp forward (Settings → Privacy to send copies instead)
- Block and unblock from contact info
- "online" / "last seen …" under the name (Settings → Privacy; can be switched off), and, if you switch it on, you show as online while Messenger Web is open and in front
- Add someone to your WhatsApp contacts, or rename them, from contact info
- Your WhatsApp name, about and picture in Settings
- WhatsApp stickers: shown as stickers, sent from the same sticker picker as Signal chats (Signal packs included), or made from any image (WhatsApp turns it into a sticker)
- Archive syncs both ways; archived WhatsApp chats stay archived when new messages arrive, like on the phone
- Polls: see and vote, and create new ones
- Search, pin/mute/archive, drafts and forwarding work across both networks; you can forward a Signal message to a WhatsApp chat and the other way round
- Not on WhatsApp chats: disappearing-message settings, ending polls and changing group pictures (do those on your phone)
- Replies: WhatsApp only links a reply when WhatsApp Web still has the original (it may know it by the privacy id instead of the number; both are tried). For older messages, like most of an imported backup, the reply goes out with the original as a `> ` quote, and the reply bar says so before you send
- **Full history from an Android backup** (Settings → WhatsApp → *Import full history from an Android backup*): turn on end-to-end encrypted backup with a 64-digit key on the phone, back up, and upload `msgstore.db.crypt15` (or copy it into `whatsapp-backup/` in the data folder). Every chat and message the phone has is imported, with replies, reactions and group events; messages already here are skipped. Then copy the phone's `WhatsApp/Media` folder into the same `whatsapp-backup/` folder and click *Add media from the folder*. The key isn't stored, and the backup and its decrypted copy are deleted after the import
- Developed against WAHA's **WEBJS** engine. With WEBJS you see that a call came in, but not whether you answered it on your phone, so call lines read "Incoming voice call" unless WhatsApp sends its own call log

**Not supported**: voice/video calls, stories, message history from before linking (signal-cli doesn't support Signal's history transfer), editing messages that have attachments, changing your last name (the Signal API only sets the first name), view-once media.

Stickers are downloaded from Signal's CDN (`cdn.signal.org`) by the signal-web container and decrypted there, like Signal Desktop does, so that container needs outbound internet access.

## Install on Unraid

This assumes the setup used during development: all containers in **bridge** mode, talking to each other through the Unraid host's IP.
In bridge mode the Signal API and WAHA ports are reachable by anything on your LAN; WAHA is protected by its API key, the Signal API has no login. Use this only on a network you trust.

### 1. Signal API (skip for WhatsApp only)

Install **Signal-API** from Community Applications and change its defaults before the first start:

1. **Mode**: `json-rpc` (or `json-rpc-native`).
2. **Receive Schedule**: click **Remove** (in json-rpc mode the container refuses to start while `AUTO_RECEIVE_SCHEDULE` exists, even empty).
3. **Add another Path, Port, Variable…** → Variable `JSON_RPC_RECEIVE_MODE` = `manual`.
4. **Apply**, then fix the folder ownership in the Unraid terminal and start it again:

   ```sh
   chown -R 1000:1000 /mnt/cache/appdata/signal-api
   ```

Note the host port (the template's default is **8739**).

### 2. WAHA (skip for Signal only)

Install **WAHA** using its Chrome image, `devlikeapro/waha:chrome` (the plain image has Chromium, which can't send videos). Set:

- `WAHA_API_KEY`: a long random key (or use the one WAHA prints in its log on first start).
- `WHATSAPP_DEFAULT_ENGINE`: `WEBJS`. Messenger Web is developed and tested against WEBJS (a real WhatsApp Web in a headless browser); the other engines answer differently in places.
- Keep its sessions folder (`/app/.sessions`) on appdata so the link survives updates.

Note the host port you gave it (for example **6523**). You don't need to link WhatsApp in WAHA's own dashboard: Messenger Web creates the session and shows the QR code.

### 3. Messenger Web

In the Unraid terminal:

```sh
cd /boot/config/plugins/dockerMan/templates-user
wget -O my-messenger-web.xml https://raw.githubusercontent.com/WCAve/Messenger_Web/main/unraid/messenger-web.xml
```

**Docker → Add Container** → *messenger-web*, then set:

- **Password**: 8+ characters, longer is better.
- **Signal API URL**: `http://<unraid-ip>:8739`, or `off`.
- **WAHA URL**: `http://<unraid-ip>:6523`, and **WAHA API key**: the key from step 2. Leave the URL empty for Signal only.

If the GitHub repository is private, its image is private too: make the package public (GitHub → Packages → messenger_web → Package settings), or `docker login ghcr.io -u WCAve` on Unraid with a token that has `read:packages`.

### 4. Link your phones

Open `http://<unraid-ip>:3000` and sign in.

- **Signal:** scan the QR code (Signal → Settings → Linked devices → Link new device). With WhatsApp set up too, the app opens right away and a banner offers *Link Signal*.
- **WhatsApp:** open **⋮ → Settings → WhatsApp** and scan the code (WhatsApp → Settings → Linked devices → Link a device). Recent chats are imported within a minute.

Coming from Signal Web? **Stop the signal-web container first**: two apps reading from the same Signal API would each get only some of your messages. To keep your Signal history, copy `/mnt/user/appdata/signal-web` to `/mnt/user/appdata/messenger-web` before Messenger Web's first start. The Signal link itself lives in signal-api, so there's nothing to re-link.

### HTTPS (needed for notifications)

Browsers only allow desktop notifications on HTTPS pages (or `localhost`). Over plain `http://<unraid-ip>:3000` everything else works, but notifications stay off and Messenger Web explains why. Options:

- **Tailscale (Unraid 7):** edit messenger-web, turn on **Use Tailscale**, give it a hostname, enable **Serve**, and apply. Approve it with the link in the container log, then open the `https://…ts.net` address from any device on your tailnet.
- **Reverse proxy** with a certificate: Nginx Proxy Manager, SWAG or Caddy in front of port 3000. Set `SECURE_COOKIES=true`.
- **Certificate in messenger-web itself:** mount a PEM certificate and key and set `TLS_CERT_FILE` and `TLS_KEY_FILE`. Messenger Web then serves HTTPS on its port.
- **Only for one browser on your LAN:** Firefox `about:config` → add the server's IP to `dom.securecontext.allowlist`; Chrome/Edge `chrome://flags/#unsafely-treat-insecure-origin-as-secure` → add `http://<unraid-ip>:3000`. Restart the browser.

Notifications appear while a Messenger Web tab is open (it may be in the background); there are no push notifications when the browser is closed.

### Updating

Unraid shows "update ready" as new images are published. Keep **signal-api** and **WAHA** reasonably current: Signal stops accepting old signal-cli versions after a few months, and WhatsApp protocol changes need a new WAHA.

### Backups

Back up both appdata folders:

- `/mnt/user/appdata/signal-api` holds your Signal keys. Losing it means re-linking.
- `/mnt/user/appdata/messenger-web` holds chat history and attachments.
- WAHA's sessions folder holds your WhatsApp link. Losing it means linking again.

## Security notes

- Your Signal keys and message history live on the server. Anyone with the password, or with access to the appdata folders, can read and send as you. Treat it like a logged-in Signal Desktop.
- Keep it on your LAN or behind a VPN (Tailscale, WireGuard). If you put it behind a reverse proxy with HTTPS, set `SECURE_COOKIES=true`.
- Login is rate-limited (10 failed attempts per IP per 15 minutes) and sessions are http-only, same-site cookies.
- When a contact's safety number changes, signal-api follows `JSON_RPC_TRUST_NEW_IDENTITIES` (default `on-first-use`). Verify safety numbers on your phone.

## Settings

| Variable | Default | |
|---|---|---|
| `APP_PASSWORD` | (required) | Web UI password, 8+ characters |
| `SIGNAL_API_URL` | `http://signal-api:8080` | Where the signal-api container is; `off` = no Signal |
| `WAHA_URL` | (none) | WAHA's address; empty = no WhatsApp |
| `WAHA_API_KEY` | (none) | WAHA's API key |
| `WAHA_SESSION` | `default` | WAHA session to use (created if missing) |
| `WAHA_HISTORY_CHATS` / `WAHA_HISTORY_MESSAGES` | `40` / `40` | How much WhatsApp history to import (`0` = as many as possible). Can also be changed in Settings → WhatsApp, which wins |
| `SIGNAL_NUMBER` | first linked account | Only if signal-api holds several accounts |
| `GIPHY_API_KEY` | (none) | Enables the GIF picker. Free: [developers.giphy.com](https://developers.giphy.com/dashboard/) → Create an App → API. The browser talks to Giphy directly, as Giphy's terms require |
| `GIPHY_RATING` | `pg-13` | Content rating for GIF results: `g`, `pg`, `pg-13`, `r` |
| `SEND_READ_RECEIPTS` | `true` | Send read receipts when you open a chat. Default only: the switch in Settings overrides it |
| `SEND_TYPING_INDICATORS` | `true` | Send typing indicators. Default only: the switch in Settings overrides it |
| `SEND_LINK_PREVIEWS` | `true` | Fetch pages you link to, to send a preview. Default only: the switch in Settings overrides it |
| `SECURE_COOKIES` | `false` | Set `true` when served over HTTPS through a proxy (automatic with `TLS_CERT_FILE`) |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | (none) | PEM certificate and key: serve HTTPS directly |
| `SESSION_DAYS` | `30` | How long a browser stays signed in |
| `MAX_UPLOAD_MB` | `100` | Largest attachment you can send |
| `PUID` / `PGID` | `99` / `100` | Owner of files in `/data` |
| `DATA_DIR` | `/data` | Database and attachments |
| `PORT` | `3000` | HTTP port |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. `debug` logs every delivery/read receipt |

## Other Docker hosts

```sh
mkdir -p data/signal-api && sudo chown 1000:1000 data/signal-api   # signal-api runs as uid 1000
APP_PASSWORD='a long password' WAHA_API_KEY='a long random key' docker compose up -d
```

See [docker-compose.yml](docker-compose.yml).

## Development

Requires Node 22.13 or newer. The server has no runtime dependencies: it uses Node's built-in `node:sqlite`, `fetch`, `WebSocket` and `http`.

```sh
npm install
npm run mock            # fake Signal API on :8080 with sample chats (no phone needed)
node mock/mock-waha.mjs # fake WAHA (WEBJS engine behaviour) on :8090, API key test-waha-key; MOCK_WA_LINKED=1 starts linked
npm run dev:web         # rebuilds the UI into web/dist on change
npm run build -w server && \
  DATA_DIR=.data APP_PASSWORD=devpassword SIGNAL_API_URL=http://localhost:8080 \
  WAHA_URL=http://localhost:8090 WAHA_API_KEY=test-waha-key npm start -w server
```

Add `SIGNAL_STICKER_CDN=http://localhost:8080` so stickers come from the mock's fake CDN.
Open http://localhost:3000. The mock starts unlinked: its QR code "links" four seconds after it is shown (`MOCK_LINKED=1` skips that).
It auto-replies to anything you send, and messages containing "fail" are rejected so you can test retries.
The sample group has a description, admins, an avatar, a member with only a profile name and one Signal knows nothing about, a GIF (silent MP4) and a normal video, and a mention stored as a phone number. Group sends take a second, with delivery receipts arriving before the send returns, like on real Signal.
`POST /mock/incoming {"from":"bob","text":"hi","group":true}` on the mock injects incoming messages.

Emoji artwork is in `web/public/emoji`, made by `web/scripts/gen-emoji-assets.py` from the upstream sets (instructions at the top of that script): [Noto Color Emoji](https://github.com/googlefonts/noto-emoji) (SIL OFL 1.1), [Fluent Emoji](https://github.com/microsoft/fluentui-emoji) (MIT) and [Twemoji](https://github.com/jdecked/twemoji) (graphics CC-BY 4.0, © Twitter, Inc. and other contributors). Each folder has its license.

### Tests and code guide

- `tests/e2e/run.sh` runs the browser tests against both mocks; see [tests/README.md](tests/README.md).
- How it works: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Which file does what: [server/README.md](server/README.md), [web/README.md](web/README.md). Notes for AI assistants working on the code: [CLAUDE.md](CLAUDE.md).

Images are built by GitHub Actions and published to `ghcr.io/wcave/messenger_web`.

<p align="center"><img src="docs/mobile-dark.png" width="300" alt="Phone layout, dark mode"></p>
