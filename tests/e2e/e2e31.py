"""No duplicate when a message arrives live and through a history import at the same time."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def req(base, path, data=None):
    r = urllib.request.Request(base + path, data=json.dumps(data).encode() if data is not None else None, headers={'content-type': 'application/json'}, method='POST' if data is not None else 'GET')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
wa = lambda path, data=None: req('http://127.0.0.1:8090', path + ('&' if '?' in path else '?') + 'x-api-key=test-waha-key', data)
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 1000})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Jan Bakker'), timeout=20000); time.sleep(6)
    page.click(row('Jan Bakker')); page.wait_for_selector('.msg:has-text("Kijk eens")')
    wa('/mock/config', {'fileDelayMs': 2500})  # a slow video download, like a real one
    # a video you send from your phone while a history import runs: the import finds it too
    cookies = '; '.join(f"{c['name']}={c['value']}" for c in page.context.cookies())
    r = urllib.request.Request('http://localhost:3000/api/whatsapp/import', data=b'{}', headers={'cookie': cookies, 'content-type': 'application/json'}, method='POST')
    mm = wa('/mock/incoming', {'from': 'jan', 'text': 'Wist je dat', 'media': 'video/mp4', 'extra': {'fromMe': True}, 'payload': {'source': 'app'}, 'alsoAs': ['message']})
    wa('/mock/history', {'message': mm})
    time.sleep(0.3); urllib.request.urlopen(r)
    # and one Jan sends you
    wa('/mock/incoming', {'from': 'jan', 'text': 'Pink Floyd', 'media': 'video/mp4', 'alsoAs': ['message', 'message.any']})
    time.sleep(7)
    out = page.locator('.msg:has-text("Wist je dat")').count(); inc = page.locator('.msg:has-text("Pink Floyd")').count()
    print('from phone:', out, ' received:', inc)
    assert out == 1 and inc == 1, (out, inc)
    page.reload(); page.wait_for_selector(row('Jan Bakker')); page.click(row('Jan Bakker')); page.wait_for_selector('.msg:has-text("Pink Floyd")')
    assert page.locator('.msg:has-text("Wist je dat")').count() == 1 and page.locator('.msg:has-text("Pink Floyd")').count() == 1
    assert page.locator('.msg.out:has-text("Wist je dat")').count() == 1
    print('no duplicates ok')
    b.close()
print('ERRORS:', errors)
