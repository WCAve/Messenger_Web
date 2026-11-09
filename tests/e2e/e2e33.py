"""Mentions by privacy id (@lid) show the name; nobody known shows "@Unknown", not a fake number."""
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
    page.wait_for_selector(row('Familie'), timeout=20000); time.sleep(6)
    page.click(row('Familie')); page.wait_for_selector('.msg:has-text("jij toch")')
    # Sanne mentioned by her privacy id (14 digits; WhatsApp Web can't turn it into her number)
    wa('/mock/incoming', {'group': True, 'from': 'jan', 'text': 'Ik dacht dat @22222222222222 weg was', 'extra': {'data': {'mentionedJidList': ['22222222222222@lid']}}})
    page.wait_for_selector('.msg:has-text("weg was") .mention:text-is("@Sanne")', timeout=10000)
    assert page.locator('.msg:has-text("weg was") :text("+2222")').count() == 0
    print('mention by privacy id ok')
    # without the mention list (older messages): no made-up phone number either
    wa('/mock/incoming', {'group': True, 'from': 'jan', 'text': 'Nog een keer @22222222222222'})
    page.wait_for_selector('.msg:has-text("Nog een keer") .mention:text-is("@Sanne")', timeout=10000)
    print('mention without list ok')
    # someone nobody can identify: "@Unknown", not a fake number
    wa('/mock/incoming', {'group': True, 'from': 'jan', 'text': 'Wie is @44444444444444', 'extra': {'data': {'mentionedJidList': ['44444444444444@lid']}}})
    page.wait_for_selector('.msg:has-text("Wie is") .mention', timeout=10000)
    t = page.inner_text('.msg:has-text("Wie is") .mention'); print('unknown shows as', t)
    assert '+4444' not in t, t
    b.close()
print('ERRORS:', errors)
