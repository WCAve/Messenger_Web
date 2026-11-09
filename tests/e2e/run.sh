#!/usr/bin/env bash
# Runs the browser tests against the mock Signal API and mock WAHA.
#
#   tests/e2e/run.sh                 all suites
#   tests/e2e/run.sh e2e27 e2e28     just these
#
# Needs: a build (npm run build), Python 3 with Playwright, and a Chromium Playwright can launch.
# Every suite gets a fresh app: mocks and server are restarted and the test data (.data) is wiped.
# Output goes to $OUT (default .test-out/): <suite>.log per suite, plus server.log, waha.log, mock.log,
# and any screenshots the suites take. One line per suite: "e2e27 exit 0: <last line of its log>".
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${OUT:-$ROOT/.test-out}"
mkdir -p "$OUT" "$OUT/shots" "$OUT/shots6" "$OUT/b28" # folders some suites write into
cd "$ROOT"

stop_all() {
  pkill -f 'mock/mock-signal-api.mjs' 2>/dev/null
  pkill -f 'mock/mock-waha.mjs' 2>/dev/null
  pkill -f 'server/dist/index.js' 2>/dev/null
  sleep 0.5
}

# Fresh mocks and server. $1 = "nowa" starts without WhatsApp; $2 = "unlinked" starts Signal unlinked.
start_all() {
  stop_all
  rm -rf .data
  if [ "${2:-}" = unlinked ]; then
    nohup node mock/mock-signal-api.mjs > "$OUT/mock.log" 2>&1 &
  else
    MOCK_LINKED=1 nohup node mock/mock-signal-api.mjs > "$OUT/mock.log" 2>&1 &
  fi
  MOCK_WA_LINKED=1 nohup node mock/mock-waha.mjs > "$OUT/waha.log" 2>&1 &
  sleep 0.5
  local waha=http://127.0.0.1:8090
  [ "${1:-}" = nowa ] && waha=" "
  DATA_DIR=.data APP_PASSWORD=testpassword PORT=3000 \
    SIGNAL_API_URL=http://127.0.0.1:8080 SIGNAL_STICKER_CDN=http://127.0.0.1:8080 \
    WAHA_URL="$waha" WAHA_API_KEY=test-waha-key GIPHY_API_KEY=test-key LINK_PREVIEW_INSECURE=1 \
    WAHA_HISTORY_ROUNDS_MS="${ROUNDS:-1500,7000}" WAHA_RESUME_SETTLE_MS=1500 WAHA_RESTART_AFTER_MS=2000 \
    nohup node --no-warnings=ExperimentalWarning server/dist/index.js > "$OUT/server.log" 2>&1 &
  sleep 3
}

suites=("$@")
if [ ${#suites[@]} -eq 0 ]; then
  mapfile -t suites < <(ls tests/e2e/e2e*.py | xargs -n1 basename | sed 's/\.py$//' | sort -V)
fi

failed=0
for t in "${suites[@]}"; do
  if [ "$t" = e2e ]; then start_all nowa unlinked; else start_all; fi # the first suite: Signal only, not linked yet
  python3 "tests/e2e/$t.py" "$OUT" > "$OUT/$t.log" 2>&1
  code=$?
  [ $code -ne 0 ] && failed=$((failed + 1))
  echo "$t exit $code: $(tail -1 "$OUT/$t.log" | cut -c1-140)"
done
stop_all
echo "done: ${#suites[@]} suites, $failed failed"
[ $failed -eq 0 ]
