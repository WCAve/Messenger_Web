"""The live connection dies silently (no error, nothing arrives, like after sleep or a network change):
the page notices within about a minute, reconnects by itself and shows what came in meanwhile, without a refresh."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def wa(path, data):
    r = urllib.request.Request('http://127.0.0.1:8090' + path, data=json.dumps(data).encode(), headers={'content-type': 'application/json'}, method='POST')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 900})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Jan Bakker'), timeout=20000); time.sleep(6)
    page.click(row('Jan Bakker')); page.wait_for_selector('.msg')
    # Live still works
    wa('/mock/incoming', {'from': 'jan', 'text': 'Nog verbonden'}); page.wait_for_selector('.msg:has-text("Nog verbonden")', timeout=5000)
    # The connection goes silent
    page.evaluate('() => fetch("/api/test/stall-events", {method: "POST"})'); time.sleep(1)
    wa('/mock/incoming', {'from': 'jan', 'text': 'Tijdens de stilte'})
    wa('/mock/incoming', {'from': 'sanne', 'text': 'Ook in een andere chat'})
    time.sleep(3)
    assert page.locator('.msg:has-text("Tijdens de stilte")').count() == 0  # really silent
    t0 = time.time()
    page.wait_for_selector('.msg:has-text("Tijdens de stilte")', timeout=100_000)
    print(f'back by itself after {time.time() - t0:.0f}s')
    page.wait_for_selector(row('Sanne') + ':has-text("Ook in een andere chat")', timeout=10_000)
    # And it's live again
    wa('/mock/incoming', {'from': 'jan', 'text': 'Weer live'}); page.wait_for_selector('.msg:has-text("Weer live")', timeout=5000)
    print('reconnects by itself ok')
    b.close()
print('ERRORS:', errors)
