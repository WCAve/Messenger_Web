"""Clicking a quote scrolls to the quoted message and then lights it up (after the scroll lands, not during),
so it's clear which one it is; it fades out by itself. Also when the quoted message was already in view."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def sig(path, data):
    r = urllib.request.Request('http://127.0.0.1:8080' + path, data=json.dumps(data).encode(), headers={'content-type': 'application/json'}, method='POST')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
T = int(time.time() * 1000) - 3600_000
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 800})
    page.on('pageerror', lambda e: errors.append(str(e)))
    sig('/mock/incoming', {'from': 'alice', 'text': 'Het originele bericht', 'ts': T})
    for i in range(30): sig('/mock/incoming', {'from': 'alice', 'text': f'Vulbericht {i}', 'ts': T + 1000 * (i + 1)})
    sig('/mock/incoming', {'from': 'alice', 'text': 'Antwoord hierop', 'ts': T + 60_000,
                           'extra': {'quote': {'id': T, 'author': '+31611111111', 'authorNumber': '+31611111111', 'text': 'Het originele bericht'}}})
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row:has-text("Alice")', timeout=20000)
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg:has-text("Antwoord hierop") .quote')
    target = page.locator('.msg:has(.body:text-is("Het originele bericht"))')
    page.locator('.msg:has-text("Antwoord hierop") .quote').click()
    t0 = time.time()
    flashed = None
    while time.time() - t0 < 3:
        if 'flash' in (target.get_attribute('class') or ''):
            flashed = time.time() - t0; break
        time.sleep(0.03)
    assert flashed is not None, 'never lit up'
    box = target.bounding_box(); print(f'lit up after {flashed:.2f}s, at y={box["y"]:.0f}')
    assert 0 < box['y'] < 800  # in view when it lights up
    time.sleep(0.3); page.screenshot(path=S + '/e2e54.png')
    glow = target.locator('.bubble').evaluate('e => getComputedStyle(e).boxShadow'); print('glow while lit:', glow[:60])
    assert glow != 'none'
    time.sleep(2.6)
    assert 'flash' not in (target.get_attribute('class') or ''), 'did not fade'
    # Again, now that it's in view: lights up straight away
    page.locator('.msg:has-text("Antwoord hierop") .quote').scroll_into_view_if_needed()
    if target.bounding_box()['y'] > 0:
        page.locator('.msg:has-text("Antwoord hierop") .quote').click(); time.sleep(0.15)
        assert 'flash' in (target.get_attribute('class') or '')
    print('quote flash ok')
    # With animations switched off in the system settings: still lights up (without the fade)
    pr = b.new_page(viewport={'width': 1400, 'height': 800}, reduced_motion='reduce')
    pr.goto('http://localhost:3000/'); pr.fill('input[type=password]', 'testpassword'); pr.click('button:has-text("Sign in")'); pr.wait_for_selector('.chat-row:has-text("Alice")', timeout=20000)
    pr.click('.chat-row:has-text("Alice")'); pr.wait_for_selector('.msg:has-text("Antwoord hierop") .quote')
    pr.evaluate("() => document.querySelector('.messages').scrollTop = 1e9"); time.sleep(0.3)
    pr.locator('.msg:has-text("Antwoord hierop") .quote').click(); time.sleep(0.4)
    t = pr.locator('.msg:has(.body:text-is("Het originele bericht")) .bubble')
    glow = t.evaluate('e => getComputedStyle(e).boxShadow'); print('reduced motion glow:', glow[:50])
    assert glow != 'none' and 'rgba(0, 0, 0, 0)' not in glow.split(',')[0]
    time.sleep(1.6)
    assert t.evaluate('e => getComputedStyle(e).boxShadow') != glow, 'stays lit'
    print('reduced motion ok')
    b.close()
print('ERRORS:', errors)
