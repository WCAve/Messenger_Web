# Messenger Web: notes for Claude

Signal and WhatsApp in one self-hosted web app. Runs on the owner's Unraid box as the `signal-web`
container (image `ghcr.io/wcave/messenger_web`, built by CI on every push), next to
signal-cli-rest-api (port 8739) and WAHA (port 6523, **WEBJS** engine, Chrome image).

**Read first:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (how it works, ids, kv keys, pitfalls),
then [server/README.md](server/README.md) / [web/README.md](web/README.md) (which file does what).
Every source file starts with a comment explaining it. Don't reverse-engineer what's written down;
do update these docs when you change how something works.

## Working rules (from the owner)

- Commit and push when a piece of work is done. After each push, wait for CI (`gh run watch`) and
  report the result. Commits end with the attribution lines the session gives you.
- After each batch of changes, give a numbered test plan the owner can tick off.
- "Don't build yet" / "only put it on the to-do list" means: investigate and answer, no code.
- **Never** ask for or paste the WAHA API key, the app password or the 64-digit backup key in chat.
  For checks on the server, give `docker exec signal-web …` commands that read secrets from the
  container's own environment, or that prompt for them locally (`read -s`).
- Plain language in everything the owner reads (UI text, replies): no jargon where a normal word works.
- The owner keeps a to-do list (TODO.md) in a folder they connect to the session; keep it up to date
  when it's connected (tick off, add, move to "Done").

## Commands

```bash
npm install                 # once
npm run build               # web (esbuild) + server (tsc)
npm run typecheck           # both; CI runs this and the build
tests/e2e/run.sh            # all browser tests against the mocks (~15 min); see tests/README.md
tests/e2e/run.sh e2e27      # one suite
```

Run the server by hand like `tests/e2e/run.sh` does (mocks on 8080/8090, `DATA_DIR=.data`,
`APP_PASSWORD=testpassword`, `PORT=3000`).

## How to work on it

- **Bugs from the owner's real setup**: reproduce in a mock first (mock/mock-waha.mjs,
  mock/mock-signal-api.mjs; add hooks there), write a test that fails without the fix, then fix. When
  the real data is needed, ask for the output of a read-only `docker exec signal-web node -e …` query
  (see "Debugging on the server" in docs/ARCHITECTURE.md), never for the database itself.
- **WAHA**: check its docs (waha.devlike.pro) and source (github.com/devlikeapro/waha and its
  whatsapp-web.js fork) for exact endpoint shapes; WEBJS behaves differently from the other engines.
  Be gentle with it: no floods of requests.
- **signal-cli-rest-api**: its swagger (github.com/bbernhard/signal-cli-rest-api, src/docs) is the
  reference; several things Signal can do aren't in the REST API.
- Run the full test suite before pushing anything that touches shared code (store, routes, ingest,
  whatsapp); a single suite is enough for an isolated change.
