"""Slow chat openings end up in the server's log with where the time went (here: a held-up answer)."""
import sys, time, os
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
    assert not errors, errors
    b.close()
print('e2e60 ok')
