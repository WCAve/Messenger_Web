"""Pinned messages: pin in a Signal group (24 h / 7 d / 30 d choice) and in WhatsApp; the bar under the
header (several pins: click goes to the message and moves on to the next); unpin from the bar; pins made
by others come in (Signal pinMessage, WhatsApp "pinned a message" notices); one-to-one Signal chats have
the Pin button greyed out."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def get(port, path): return json.loads(urllib.request.urlopen(f'http://127.0.0.1:{port}{path}').read() or b'null')
def post(port, path, data):
    r = urllib.request.Request(f'http://127.0.0.1:{port}{path}', data=json.dumps(data).encode(), headers={'Content-Type': 'application/json'}, method='POST')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
def until(fn, what, tries=60):
    for _ in range(tries):
        v = fn()
        if v: return v
        time.sleep(0.25)
    raise AssertionError('timed out: ' + what)
BOB = '+31622222222'
with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={'width': 1400, 'height': 900}); page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row:has-text("Alice")', timeout=20000); time.sleep(2)
    ts1 = int(post(8080, '/mock/incoming', {'from': 'bob', 'text': 'pin me please', 'group': True})['timestamp'])
    ts2 = int(post(8080, '/mock/incoming', {'from': 'bob', 'text': 'second one', 'group': True})['timestamp'])
    page.click('.chat-row:has-text("Weekend plans")'); page.wait_for_selector('.msg:has-text("second one")')

    # Pin from the toolbar: pick how long
    msg = page.locator('.msg:has-text("pin me please")').last
    msg.hover(); msg.locator('button[aria-label="Pin"]').click()
    page.wait_for_selector('.pin-menu'); page.screenshot(path=S + '/e2e71-menu.png')
    assert page.locator('.pin-menu button').all_inner_texts() == ['Pin for 24 hours', 'Pin for 7 days', 'Pin for 30 days']
    page.click('.pin-menu button:has-text("7 days")')
    sent = until(lambda: [x for x in get(8080, '/mock/sent') if x['path'].endswith('/pin-message')], 'Signal pin sent')
    print('Signal got:', sent[0]); assert sent[0]['method'] == 'POST' and sent[0]['duration'] == 604800 and sent[0]['timestamp'] == ts1 and sent[0]['target_author'] == BOB
    page.wait_for_selector('.pinned-bar:has-text("pin me please")')
    page.wait_for_selector('.system-line:has-text("You pinned a message")')
    msg.hover(); assert msg.locator('button[aria-label="Unpin"]').count(), 'no Unpin in the toolbar'

    # Someone else pins another message
    post(8080, '/mock/incoming', {'from': 'carol', 'text': '', 'group': True, 'extra': {'message': None, 'pinMessage': {'targetAuthorNumber': BOB, 'targetSentTimestamp': ts2, 'pinDurationSeconds': 86400}}})
    page.wait_for_selector('.pinned-bar:has-text("Pinned message 1 of 2")')
    page.wait_for_selector('.system-line:has-text("Carol pinned a message")')
    assert 'second one' in page.locator('.pinned-bar').inner_text()
    page.screenshot(path=S + '/e2e71-bar.png')
    page.click('.pinned-main'); page.wait_for_selector('.pinned-bar:has-text("2 of 2")')
    assert 'pin me please' in page.locator('.pinned-bar').inner_text()
    # Unpin from the bar
    page.click('.pinned-bar button[aria-label="Unpin"]')
    until(lambda: [x for x in get(8080, '/mock/sent') if x['path'].endswith('/pin-message') and x['method'] == 'DELETE'], 'Signal unpin sent')
    page.wait_for_selector('.pinned-bar:has-text("Pinned message")'); time.sleep(0.5)
    assert '1 of' not in page.locator('.pinned-bar').inner_text() and 'second one' in page.locator('.pinned-bar').inner_text()
    page.wait_for_selector('.system-line:has-text("You unpinned a message")')

    # One-to-one Signal chat: greyed out
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg')
    m = page.locator('.msg:not(.system-line)').last; m.hover()
    btn = m.locator('button[aria-label="Pin"]'); assert btn.get_attribute('aria-disabled') == 'true'
    btn.click(force=True); time.sleep(0.3); assert not page.locator('.pin-menu').count(), 'menu opened in a Signal direct chat'
    assert not page.locator('.pinned-bar').count()

    # WhatsApp
    page.click('.chat-row:has-text("Jan Bakker")'); page.wait_for_selector('.msg')
    m = page.locator('.msg.in').last; m.hover(); m.locator('button[aria-label="Pin"]').click()
    page.click('.pin-menu button:has-text("24 hours")')
    wa = until(lambda: [x for x in get(8090, '/mock/sent') if x['path'].endswith('/pin')], 'WhatsApp pin sent')
    print('WhatsApp got:', wa[0]); assert wa[0]['duration'] == 86400
    page.wait_for_selector('.pinned-bar'); time.sleep(1.5)  # the notice WhatsApp sends back adds no second line
    assert page.locator('.system-line:has-text("You pinned a message")').count() == 1
    # Jan unpins it on his phone
    import urllib.parse
    target = urllib.parse.unquote(wa[0]['path'].split('/messages/')[1].rsplit('/', 1)[0])
    post(8090, '/mock/incoming', {'from': 'jan', 'text': '', 'extra': {'data': {'type': 'pinned_message', 'pinMessageType': 2, 'pinParentKey': {'_serialized': target}}}})
    page.wait_for_selector('.pinned-bar', state='detached')
    page.wait_for_selector('.system-line:has-text("unpinned a message")')
    page.screenshot(path=S + '/e2e71-wa.png')
    assert not errors, errors
    b.close()
print('e2e71 ok')
