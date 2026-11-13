#!/usr/bin/env bash
# Runs the browser tests against the mock Signal API and mock WAHA.
#
#   tests/e2e/run.sh                 all suites, 4 at a time
#   tests/e2e/run.sh e2e27 e2e28     just these
#   JOBS=1 tests/e2e/run.sh          one at a time
#
# Needs: a build (npm run build), Python 3 with Playwright, and a Chromium Playwright can launch.
# Every suite gets a fresh app: mocks and server are restarted and its test data is wiped.
#
# Several at once: each runner gets its own private network (`unshare -rn`, no root needed), so all of
# them use the usual ports (app 3000, Signal mock 8080, WAHA mock 8090) without getting in each
# other's way, and its own data folder ($E2E_DATA, .data-<n>). Where that isn't possible, one at a time.
# The slowest suites start first, so the runners finish at about the same time.
#
# Output goes to $OUT (default .test-out/): <suite>.log per suite, plus server/waha/mock logs per
# runner, and any screenshots the suites take. One line per suite: "e2e27 exit 0: <last line of its log>".
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${OUT:-$ROOT/.test-out}"
JOBS="${JOBS:-4}"
mkdir -p "$OUT" "$OUT/shots" "$OUT/shots6" "$OUT/b28" # folders some suites write into
cd "$ROOT"

# ---------------------------------------------------------------- one runner
if [ "${1:-}" = --runner ]; then
  N="$2" QUEUE="$3" RESULTS="$4"
  # A fresh private network starts with its loopback switched off; e2e7 also visits the app through an
  # outside address (192.0.2.2, a documentation address), which the runner's network gets too.
  python3 - <<'PY' 2>/dev/null
import socket, fcntl, struct
s = socket.socket()
def up(name):
    flags = struct.unpack('16sH', fcntl.ioctl(s, 0x8913, struct.pack('16sH', name, 0)))[1]
    fcntl.ioctl(s, 0x8914, struct.pack('16sH', name, flags | 1))
up(b'lo')
try:
    fcntl.ioctl(s, 0x8916, struct.pack('16sH2s4s8s', b'lo:1', socket.AF_INET, b'\0\0', socket.inet_aton('192.0.2.2'), b'\0' * 8))
    up(b'lo:1')
except OSError:
    pass  # not inside a private network
PY
  export E2E_DATA="$ROOT/.data-$N"
  export E2E_SERVER_LOG="$OUT/server-$N.log" E2E_WAHA_LOG="$OUT/waha-$N.log" E2E_MOCK_LOG="$OUT/mock-$N.log" # for suites that read them
  pids=()
  stop_all() {
    for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done
    for p in "${pids[@]}"; do wait "$p" 2>/dev/null; done
    pids=()
  }
  # Fresh mocks and server. $1 = "nowa" starts without WhatsApp; $2 = "unlinked" starts Signal unlinked.
  start_all() {
    stop_all
    rm -rf "$E2E_DATA"
    if [ "${2:-}" = unlinked ]; then
      node mock/mock-signal-api.mjs > "$OUT/mock-$N.log" 2>&1 &
    else
      MOCK_LINKED=1 node mock/mock-signal-api.mjs > "$OUT/mock-$N.log" 2>&1 &
    fi
    pids+=($!)
    MOCK_WA_LINKED=1 node mock/mock-waha.mjs > "$OUT/waha-$N.log" 2>&1 &
    pids+=($!)
    sleep 0.5
    local waha=http://127.0.0.1:8090
    [ "${1:-}" = nowa ] && waha=" "
    # Test-only timings: what waits a minute in real life waits seconds here.
    DATA_DIR="$E2E_DATA" APP_PASSWORD=testpassword PORT=3000 \
      SIGNAL_API_URL=http://127.0.0.1:8080 SIGNAL_STICKER_CDN=http://127.0.0.1:8080 \
      WAHA_URL="$waha" WAHA_API_KEY=test-waha-key GIPHY_API_KEY=test-key LINK_PREVIEW_INSECURE=1 \
      WAHA_HISTORY_ROUNDS_MS="${ROUNDS:-1500,7000}" WAHA_RESUME_SETTLE_MS=1500 WAHA_RESTART_AFTER_MS=2000 WAHA_AFTER_CONNECT_PAUSE_MS=1500 WAHA_CATCHUP_MARGIN_MS=2000 \
      WAHA_EVENT_SAVE_MS=1000 EVENTS_PING_MS=2000 E2E_HOOKS=1 \
      env ${SUITE_ENV:-} node --no-warnings=ExperimentalWarning server/dist/index.js > "$OUT/server-$N.log" 2>&1 &
    pids+=($!)
    for _ in $(seq 1 50); do # until the app answers
      python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:3000/healthz', timeout=1)" 2>/dev/null && break
      sleep 0.1
    done
    sleep 2.5 # as before: the suites expect the app to have had a moment (WhatsApp connecting)
  }
  trap stop_all EXIT
  while :; do
    t=$(flock "$QUEUE.lock" sh -c 'head -n1 "$1"; sed -i 1d "$1"' _ "$QUEUE")
    [ -z "$t" ] && break
    # A suite can ask for its own settings with a line "# server-env: NAME=value …"
    SUITE_ENV=$(sed -n 's/^# server-env: //p' "tests/e2e/$t.py" | head -1)
    if [ "$t" = e2e ]; then start_all nowa unlinked; else start_all; fi # the first suite: Signal only, not linked yet
    python3 "tests/e2e/$t.py" "$OUT" > "$OUT/$t.log" 2>&1
    code=$?
    line="$t exit $code: $(tail -1 "$OUT/$t.log" | cut -c1-140)"
    flock "$RESULTS.lock" sh -c 'echo "$1" >> "$2"' _ "$line" "$RESULTS"
    echo "$line"
  done
  rm -rf "$E2E_DATA"
  exit 0
fi

# ---------------------------------------------------------------- all runners
suites=("$@")
if [ ${#suites[@]} -eq 0 ]; then
  mapfile -t suites < <(ls tests/e2e/e2e*.py | xargs -n1 basename | sed 's/\.py$//' | sort -V)
fi
# Slowest first (they wait on purpose), then the rest in order.
SLOW=(e2e43 e2e59 e2e61 e2e62 e2e52 e2e53 e2e40 e2e e2e9 e2e44 e2e58 e2e42 e2e57 e2e19 e2e11 e2e27 e2e10)
queue="$OUT/.queue"; results="$OUT/.results"
: > "$results"
{
  for s in "${SLOW[@]}"; do printf '%s\n' "${suites[@]}" | grep -qx "$s" && echo "$s"; done
  for s in "${suites[@]}"; do printf '%s\n' "${SLOW[@]}" | grep -qx "$s" || echo "$s"; done
} > "$queue"

private() { [ "${E2E_PRIVATE:-1}" != 0 ] && unshare -rn true 2>/dev/null; } # E2E_PRIVATE=0: never
jobs=$JOBS
[ ${#suites[@]} -lt "$jobs" ] && jobs=${#suites[@]}
if ! private; then
  [ "$jobs" -gt 1 ] && echo "(no private networks here: one at a time)"
  jobs=1
fi
runners=()
for n in $(seq 1 "$jobs"); do
  if private; then
    unshare -rn bash "$0" --runner "$n" "$queue" "$results" &
  else
    bash "$0" --runner "$n" "$queue" "$results" &
  fi
  runners+=($!)
done
for p in "${runners[@]}"; do wait "$p"; done
failed=$(grep -cv ' exit 0:' "$results")
echo "done: $(wc -l < "$results") suites, $failed failed"
rm -f "$queue" "$queue.lock" "$results.lock"
[ "$failed" -eq 0 ]
