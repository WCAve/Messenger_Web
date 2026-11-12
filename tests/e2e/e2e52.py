"""When WhatsApp (WAHA) can't be reached for a while, a bar at the top says so in plain words; it goes away
when WAHA is back. A short hiccup doesn't show it."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def wa(path, data):
    r = urllib.request.Request('http://127.0.0.1:8090' + path, data=json.dumps(data).encode(), headers={'content-type': 'application/json'}, method='POST')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 900})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row-wrap:has(.chat-title:text-is("Jan Bakker"))', timeout=20000); time.sleep(3)
    assert page.locator('.banner').count() == 0
    wa('/mock/config', {'down': True}); t0 = time.time()
    page.wait_for_selector('.banner:has-text("Can’t reach WhatsApp")', timeout=90_000)
    took = time.time() - t0; print(f'bar after {took:.0f}s:', page.locator('.banner').inner_text())
    assert took >= 14, 'shown too soon'
    assert 'WAHA' in (page.locator('.banner').get_attribute('title') or '')  # the technical reason, on hover
    page.screenshot(path=S + '/e2e52.png', clip={'x': 0, 'y': 0, 'width': 1400, 'height': 120})
    wa('/mock/config', {'down': False})
    page.wait_for_selector('.banner', state='detached', timeout=60_000)
    print('bar gone after WAHA is back')
    b.close()
print('ERRORS:', errors)
