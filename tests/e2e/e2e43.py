"""Deleted messages: what someone else deletes (Signal and WhatsApp, text and photo) is kept and shown on
click; your own deletions aren't kept; disappearing messages show "This message disappeared" and can be opened."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def post(port, path, data):
    r = urllib.request.Request(f'http://127.0.0.1:{port}' + path, data=json.dumps(data).encode(), headers={'content-type': 'application/json'}, method='POST')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
wa = lambda path, data: post(8090, path, data)
sig = lambda path, data: post(8080, path, data)
def wait(cond, t=10, msg='timeout'):
    end = time.time() + t
    while time.time() < end:
        v = cond()
        if v: return v
        time.sleep(0.2)
    raise AssertionError(msg)
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 1000})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Jan Bakker'), timeout=20000); time.sleep(8)
    dialog = '.dialog:has(h2:text-is("Deleted message"))'
    # WhatsApp: Jan sends a photo with a caption and a text, then deletes both
    page.click(row('Jan Bakker'))
    photo = wa('/mock/incoming', {'from': 'jan', 'text': 'Kijk deze foto', 'media': 'image/jpeg'})
    text = wa('/mock/incoming', {'from': 'jan', 'text': 'Dit had ik *niet* moeten sturen'})
    page.wait_for_selector('.msg:has-text("niet moeten sturen")'); time.sleep(1.5)
    for mm in (text, photo):
        raw = mm['_data']['id']['id']
        wa('/mock/event', {'event': 'message.revoked', 'payload': {'after': {'id': 'false_31655500001@c.us_NOTICE' + raw[:6]}, 'before': {'id': mm['id']}, 'revokedMessageId': raw}})
    wait(lambda: page.locator('.msg:has-text("niet moeten sturen")').count() == 0 and page.locator('.msg:has-text("Kijk deze foto")').count() == 0)
    shows = page.locator('.deleted-show:has-text("This message was deleted")')
    assert shows.count() >= 2, shows.count()
    shows.last.click(); page.wait_for_selector(dialog + ' .edit-text')
    print('wa text:', page.locator(dialog + ' .edit-text').inner_text())
    assert 'Dit had ik niet moeten sturen' in page.locator(dialog + ' .edit-text').inner_text()
    assert page.locator(dialog + ' .edit-text strong:text-is("niet")').count() == 1  # formatting kept
    page.screenshot(path=S + '/e2e43.png')
    page.click(dialog + ' button[aria-label="Close"]'); time.sleep(0.3)
    shows.nth(shows.count() - 2).click(); page.wait_for_selector(dialog + ' .deleted-media img')
    assert 'Kijk deze foto' in page.locator(dialog).inner_text()
    wait(lambda: page.locator(dialog + ' .deleted-media img').evaluate('i => i.complete && i.naturalWidth > 0'), msg='photo not loading')
    page.click(dialog + ' .deleted-media'); page.wait_for_selector('.lightbox img')
    page.keyboard.press('Escape'); time.sleep(0.3)
    print('whatsapp kept ok')
    # Your own deletion: not kept
    page.click('textarea'); page.keyboard.type('Eigen bericht weg'); page.keyboard.press('Enter')
    page.wait_for_selector('.msg.out:has-text("Eigen bericht weg")'); time.sleep(1.5)
    page.on('dialog', lambda d: d.accept())
    m = page.locator('.msg.out:has-text("Eigen bericht weg")').last; m.hover(); m.locator('button[aria-label="Delete for everyone"]').click()
    wait(lambda: page.locator('.msg.out:has-text("You deleted this message")').count() >= 1)
    assert page.locator('.msg.out .deleted-show').count() == 0
    print('own deletion not kept ok')
    # Signal: Alice sends and deletes
    page.click('.chat-row:has-text("Alice")'); time.sleep(0.5)
    ts = int(time.time() * 1000)
    sig('/mock/incoming', {'from': 'alice', 'text': 'Geheimpje van Alice', 'ts': ts})
    page.wait_for_selector('.msg:has-text("Geheimpje van Alice")')
    sig('/mock/incoming', {'from': 'alice', 'text': '', 'extra': {'remoteDelete': {'timestamp': ts}}})
    wait(lambda: page.locator('.msg:has-text("Geheimpje van Alice")').count() == 0)
    page.locator('.deleted-show').last.click(); page.wait_for_selector(dialog + ' .edit-text')
    assert 'Geheimpje van Alice' in page.locator(dialog).inner_text()
    page.click(dialog + ' button[aria-label="Close"]')
    print('signal kept ok')
    # Disappearing: a message with a 3-second timer (starts when read; the chat is open)
    sig('/mock/incoming', {'from': 'alice', 'text': 'Even zichtbaar', 'extra': {'expiresInSeconds': 3}})
    page.wait_for_selector('.msg:has-text("Even zichtbaar")')
    wait(lambda: page.locator('.msg:has-text("Even zichtbaar")').count() == 0, 15, 'did not disappear')
    page.wait_for_selector('.deleted-show:has-text("This message disappeared")')
    page.click('.deleted-show:has-text("This message disappeared")')
    d2 = '.dialog:has(h2:text-is("Disappeared message"))'
    page.wait_for_selector(d2 + ' .edit-text'); assert 'Even zichtbaar' in page.locator(d2).inner_text()
    page.click(d2 + ' button[aria-label="Close"]')
    page.reload(); page.wait_for_selector('.chat-row'); page.click('.chat-row:has-text("Alice")'); time.sleep(1)
    assert page.locator('.deleted-show:has-text("This message disappeared")').count() == 1  # still there after a reload
    print('disappeared kept ok')
    b.close()
print('ERRORS:', errors)
