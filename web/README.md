# Web app (`web/src`)

React 19, TypeScript, bundled by esbuild (`build.mjs`) into `web/dist`, which the server serves.
No CSS framework: one stylesheet (`styles.css`) with CSS variables for the themes. Every file starts
with a comment saying what it does; this is the map.

| File | What it does |
|---|---|
| `main.tsx` | Entry point |
| `App.tsx` | Shell: login → link screen → layout; live events (SSE) with resync; notifications; tab title and icon |
| `store.ts` | App state (one external store, `useStore(selector)`), and how each server event changes it |
| `api.ts` | Every server call, typed |
| `types.ts` | The server's JSON shapes and events (mirror of server/src/store.ts and events.ts) |
| `networks.ts` | What each network can do (`capsFor`), so the UI only offers what works |
| `prefs.ts` | Browser-only settings (localStorage): theme, Enter sends, emoji style, notifications |
| `format.ts` | WhatsApp-style formatting in the text box (`*bold*` …) ↔ text + style ranges; links |
| `jump.ts` | Opening a chat at a particular message |
| `notifications.ts` | Browser notifications (permission state, pictures with initials) |
| `favicon.ts` | Unread count inside the tab icon |
| `exporter.ts` | Exporting chats: pages through messages, fetches files, makes small photos, writes txt (WhatsApp's format), html, json and csv |
| `zip.ts` | A small ZIP writer for the export (no library) |
| `changelog.ts` | What's new, in plain words; shown after an update (`components/WhatsNew.tsx`). Add a line for every change people notice |
| `util.ts` | Small helpers (hues, initials, images, safe links) |
| `emoji/` | Emoji data (`curated.ts` hand-picked with shortcodes, `extra.ts` generated), search, usage, rendering in the chosen style |
| **components/** | |
| `Sidebar.tsx` | Left column: chat list, archived, New chat, New group, Settings, sticker manager |
| `Chat.tsx` | The open chat: header, message list, attachments, lightbox, composer (map in its header) |
| `InfoPanel.tsx` | Right panel: chat info, search in chat / go to date, message info |
| `GroupManage.tsx` | Group management parts of chat info, New group, join by link |
| `Picker.tsx` | Emoji / sticker / GIF picker |
| `StickerManager.tsx` | Sticker manager |
| `Export.tsx` | The Export window: pick chats, formats, photos, period; progress; saves the ZIP |
| `VoicePlayer.tsx` | Player for voice messages and audio: picture, play, waveform from the sound, speed |
| `Settings.tsx` | Settings main list and pages |
| `Extras.tsx` | Polls, forwarding |
| `Setup.tsx`, `Login.tsx` | Link screen (QR code), sign-in |
| `ui.tsx` | Icons, avatars (lazy), ticks, menus |

## Conventions

- State: read with `useStore((s) => s.thing)`, change with `setState` or the helpers in store.ts
  (`upsertConversation`, `upsertMessages`). Server events arrive through `applyEvent`.
- Ask the server, don't guess: anything that differs per network goes through `capsFor(conversation)`.
- Content-Security-Policy: no inline scripts and no eval. Links from message data go through `safeHref`.
- Never hold a request open waiting for something slow (pictures, history files): the browser has ~6
  connections per site and the app freezes when they're used up.
- Icons: add an SVG path to `PATHS` in ui.tsx and use `<Icon name="…"/>`.
- Typecheck: `npm run typecheck -w web` (an old complaint about the `styles.css` import from newer
  TypeScript versions is harmless; CI is the reference).
