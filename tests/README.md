# Tests

Browser tests (Playwright, Python) that drive the real app against two fakes:

- `mock/mock-signal-api.mjs`: a fake signal-cli-rest-api (port 8080)
- `mock/mock-waha.mjs`: a fake WAHA, shaped like its **WEBJS** engine (port 8090, key `test-waha-key`)

Nothing talks to real Signal or WhatsApp.

## Running

```bash
npm run build                      # the tests run server/dist and web/dist
tests/e2e/run.sh                   # all suites, 4 at a time, ~5 minutes
tests/e2e/run.sh e2e27 e2e28       # some
JOBS=1 tests/e2e/run.sh            # one at a time (E2E_PRIVATE=0: also without private networks)
```

Needs Python 3 with `playwright` and a Chromium it can launch. Every suite gets a fresh app: both mocks
and the server are restarted and its data folder is wiped.

**Four at a time:** each runner gets its own private network (`unshare -rn`, no root needed), so all of
them use the usual ports without clashing, plus its own data folder. Suites must therefore not assume a
path or log name: use `E2E_DATA` (the app's data folder), `E2E_SERVER_LOG`, `E2E_WAHA_LOG` and
`E2E_MOCK_LOG` from the environment. Slow suites start first (`SLOW` in run.sh). Waits that take a
minute in real life are seconds in the tests (`WAHA_EVENT_SAVE_MS`, `EVENTS_PING_MS` … set in run.sh).
A suite that needs its own server settings says so in a line `# server-env: SEND_LIMIT_MB=3 …` (e2e59).

Logs and screenshots go to `.test-out/` (`<suite>.log`, and `server-<n>.log`, `waha-<n>.log`,
`mock-<n>.log` per runner). Each suite prints one line:
`e2e27 exit 0: ERRORS: []`; `ERRORS` lists JavaScript errors from the page (404s for avatars that
don't exist are normal in e2e2/3/9/10, a 401 in e2e for the wrong password).

`e2e` is special: it starts with Signal not linked and no WhatsApp (the first-run flow). All others start
with both linked.

## Writing a suite

Each `e2e<N>.py` takes the output folder as its only argument and starts with a one-line docstring
saying what it covers. The pattern:

```python
page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
page.wait_for_selector(row('Familie'), timeout=20000); time.sleep(6)   # let the first sync settle
```

- `row('Jan Bakker')` → the chat row selector (`.chat-row-wrap:has(.chat-title:text-is("…"))`).
- `until(fn, secs, msg)` polls a Python condition. Don't use `page.wait_for_function` with a string:
  the app's Content-Security-Policy forbids eval, so it fails as soon as it has to poll.
- Settings is a list of pages: `goto(page, 'Privacy')` opens one (matches the row title exactly),
  `to_chats(page)` goes back through the list. Both are defined at the top of the suites that use them.
- Call the app's API with the browser's cookie (see `api()` in e2e27/e2e34).
- Prove a fix with a test that fails without it (`git stash -- <file>`, build, run, pop).
- Files a suite reads go in `tests/e2e/fixtures` (use `FIX`); everything a suite writes goes in its
  output folder (`S`). Never depend on files that only exist on one machine.

## Test data in the mocks

WhatsApp (mock-waha): you are `31600000009@c.us` (privacy id `99999999999999@lid`). People: **Jan Bakker**
`31655500001@c.us` (privacy id `33333333333333@lid` in backups), **Sanne** `31655500002@c.us` (privacy id
`22222222222222@lid`, only findable by number), **Privé Pieter** `88888888888888@lid` (only a privacy id).
Groups: **Familie** `120363000000000001@g.us` (you admin, Sanne superadmin, labels: Sanne "Organiser",
you "Papa"), **Buren** `120363000000000002@g.us` (no history; appears after a message).

Signal (mock-signal-api): **Alice de Vries**, **Bob Jansen**, **Carol**, **Dave** (uuid only), a stranger;
group **Weekend plans** (you and Bob admin). Sticker pack **Blob faces**.

`mock/make-backup.mjs <file> <64-hex key> '<json options>'` writes an encrypted Android backup
(`msgstore.db.crypt15`) with history, media references, member labels and privacy-id mappings.

## Mock control endpoints

WAHA mock (`http://127.0.0.1:8090`, add `?x-api-key=test-waha-key`):

| Endpoint | What it does |
|---|---|
| `POST /mock/incoming {from, text, group, media, extra, payload, alsoAs}` | a message arrives (`extra.fromMe` = sent from your phone; `extra.data` merges into `_data`; `alsoAs: ['message']` also sends it as those events) |
| `POST /mock/event {event, payload}` | any raw WAHA event |
| `GET /mock/sent` | everything Messenger Web sent to WAHA |
| `POST /mock/config {messagesDelayMs, mediaDelayMs, fileDelayMs}` | slow down answers |
| `POST /mock/history {chat, id, body}` or `{message}` | add to a chat's history (what the import and message lookups see) |
| `POST /mock/bulk`, `/mock/stats` | many chats/messages; call counts |
| `POST /mock/status` | session status changes (FAILED, SCAN_QR_CODE…) |
| `POST /mock/pin`, `/mock/archive` | pin/archive "on the phone" |
| `GET /mock/groups`, `POST /mock/group-set {group, patch, myRole}` | group state; change a group "from the phone" |
| `POST /mock/join-request {group, who}` | someone asks to join |
| `POST /mock/label-event {group, id, pn, tag}` | a member label changes (not in WhatsApp Web's own list) |

Signal mock (`http://127.0.0.1:8080`):

| Endpoint | What it does |
|---|---|
| `POST /mock/incoming {from, text, …}` | a message arrives |
| `POST /mock/envelope`, `/mock/receipt` | raw envelope; a receipt |
| `GET /mock/sent` | everything sent (`/v2/send` bodies have `recipients`) |
| `GET /mock/signal-groups`, `POST /mock/signal-join-request {who}` | group state; a join request |
