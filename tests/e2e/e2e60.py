"""Slow chat openings end up in the server's log with where the time went (here: a held-up answer).
A message that arrives while a chat is still loading isn't lost."""
import sys, time, os, json, urllib.request
def post(port, path, body):
    req = urllib.request.Request(f'http://127.0.0.1:{port}{path}', data=json.dumps(body).encode(), headers={'content-type': 'application/json'})
    return urllib.request.urlopen(req).read()
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
LOG = os.environ.get('E2E_SERVER_LOG', os.path.join(S, 'server.log'))
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 900})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row:has-text("Alice")', timeout=20000); time.sleep(2)
    # A quick opening: nothing is logged
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg'); time.sleep(1.5)
    assert 'browser: opening chat' not in open(LOG).read()
    # A held-up one (2 s): logged with the breakdown
    def slow(route):
        time.sleep(2); route.continue_()
    page.route('**/api/conversations/*/messages*', slow)
    page.click('.chat-row:has-text("Jan Bakker")'); page.wait_for_selector('.msg:has-text("")', timeout=10000)
    line = ''
    for _ in range(40):
        line = next((l for l in open(LOG).read().splitlines() if 'browser: opening chat' in l), '')
        if line: break
        time.sleep(0.25)
    print('log:', line)
    assert 'took' in line and 'drawing' in line and 'other downloads' in line, line
    # A message arriving while a chat loads: the page of messages is made first (without it), the message
    # arrives live, and only then does the page reach the browser
    page.unroute('**/api/conversations/*/messages*')
    held = []
    page.route('**/api/conversations/*/messages*', lambda route: held.append(route))
    page.click('.chat-row:has-text("Carol")'); page.wait_for_timeout(500)
    assert held, 'no page requested'
    made = held[0].fetch()
    post(8080, '/mock/incoming', {'from': 'carol', 'text': 'Terwijl het laadt'})
    page.wait_for_timeout(2000)  # it arrives live meanwhile
    held[0].fulfill(response=made)
    page.wait_for_selector('.msg:has-text("Terwijl het laadt")', timeout=5000)
    print('message during loading: shown')
    assert not errors, errors
    b.close()
print('e2e60 ok')
