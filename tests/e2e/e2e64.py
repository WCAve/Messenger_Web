"""WhatsApp: when WAHA quietly stops passing new messages on (connection up, no error), Messenger notices
within minutes (here: seconds), fetches what's missed and connects again; still stuck: restarts the session."""
# server-env: WAHA_WATCH_MS=2000 WAHA_WATCH_GRACE_MS=1500
import sys, time, json, os, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
LOG = os.environ.get('E2E_SERVER_LOG', os.path.join(S, 'server.log'))
def wa(path, body=None):
    req = urllib.request.Request(f'http://127.0.0.1:8090{path}', data=json.dumps(body).encode() if body is not None else None, headers={'content-type': 'application/json'}, method='POST' if body is not None else 'GET')
    return json.loads(urllib.request.urlopen(req).read() or b'null')
def log_has(text): return text in open(LOG).read()
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 900})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row:has-text("Jan Bakker")', timeout=20000)
    time.sleep(10)  # history import done
    page.click('.chat-row:has-text("Jan Bakker")'); page.wait_for_selector('.msg')
    # Live, as normal
    wa('/mock/incoming', {'from': 'jan', 'text': 'Gewoon live'})
    page.wait_for_selector('.msg:has-text("Gewoon live")', timeout=5000)

    # WAHA goes quiet: messages aren't passed on any more
    wa('/mock/config', {'silentMessages': True})
    t0 = time.time()
    wa('/mock/incoming', {'from': 'jan', 'text': 'Stil bericht een'})
    time.sleep(2); assert page.locator('.msg:has-text("Stil bericht een")').count() == 0, 'came in live anyway?'
    page.wait_for_selector('.msg:has-text("Stil bericht een")', timeout=20000)
    print(f'first one fetched after {time.time() - t0:.1f} s')
    for _ in range(20):
        if log_has("didn't come in live"): break
        time.sleep(0.25)
    assert log_has("didn't come in live"), 'not in the log'
    assert wa('/mock/stats')['restarts'] == 0

    # Still quiet after connecting again: the session is restarted, and messages come in live again
    time.sleep(3)
    wa('/mock/incoming', {'from': 'jan', 'text': 'Stil bericht twee'})
    page.wait_for_selector('.msg:has-text("Stil bericht twee")', timeout=30000)
    for _ in range(40):
        if wa('/mock/stats')['restarts'] >= 1: break
        time.sleep(0.25)
    print('restarts:', wa('/mock/stats')['restarts']); assert wa('/mock/stats')['restarts'] == 1
    assert log_has('restarting the WhatsApp session')
    time.sleep(8)  # session back
    wa('/mock/incoming', {'from': 'jan', 'text': 'Weer live'})
    page.wait_for_selector('.msg:has-text("Weer live")', timeout=5000)
    print('live again after the restart')

    # Nothing missed: no catch-ups, no extra restarts
    n = open(LOG).read().count("live messages stopped")
    time.sleep(8)
    assert open(LOG).read().count("live messages stopped") == n, 'kept catching up although nothing was missed'
    assert wa('/mock/stats')['restarts'] == 1
    assert not errors, errors
    b.close()
print('e2e64 ok')
