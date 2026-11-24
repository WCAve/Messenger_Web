"""Sticker library: no 500 limit, copies of one sticker shown once, favourites (★, kept on the server) and
"Most used" from what you send, in the picker's ⭐ tab."""
import sys, time, json, base64, struct, zlib, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def wa(path, data):
    r = urllib.request.Request('http://127.0.0.1:8090' + path, data=json.dumps(data).encode(), headers={'content-type': 'application/json'}, method='POST')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
def png(n):  # a tiny PNG of its own colour
    raw = b'\x00' + bytes([n % 256, (n // 256) % 256, 77])
    c = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + c(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) + c(b'IDAT', zlib.compress(raw)) + c(b'IEND', b'')
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
def until(fn, what, secs=10):
    end = time.time() + secs
    while time.time() < end:
        v = fn()
        if v: return v
        time.sleep(0.25)
    raise AssertionError('timed out: ' + what)
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1300, 'height': 900}); page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Jan Bakker'), timeout=20000); time.sleep(2)
    api = lambda method, path, body=None: page.evaluate("([m, p, b]) => fetch(p, {method: m, headers: {'content-type': 'application/json'}, body: b ? JSON.stringify(b) : undefined}).then(r => r.json())", [method, path, body])

    # More than 500 stickers: none fall off
    for k in range(11):
        imgs = ['data:image/png;base64,' + base64.b64encode(png(k * 50 + i)).decode() for i in range(50)]
        api('POST', '/api/stickers/images', {'images': imgs})
    n = len(api('GET', '/api/stickers')['local']['unsorted']); print('library:', n)
    assert n == 550, n

    # The same sticker received three times: once in the library
    wa('/mock/config', {'identicalFiles': True})
    for _ in range(3):
        wa('/mock/incoming', {'from': 'jan', 'text': '', 'media': 'image/webp', 'extra': {'data': {'type': 'sticker'}}})
    page.click(row('Jan Bakker')); until(lambda: page.locator('.msg .bubble.sticker img.sticker-img').count() >= 3, 'stickers received')
    until(lambda: len(api('GET', '/api/stickers')['local']['unsorted']) == 551, 'one new sticker, not three')
    print('copies once ok')

    # Send one (it becomes "most used"), star another
    page.click('.composer button[aria-label=Stickers]')
    page.click('nav.sticker-packs button[title="WhatsApp stickers not in a pack"]')
    page.wait_for_selector('.picker-body .sticker-cell-wrap')
    first = page.locator('.picker-body .sticker-cell-wrap').nth(0)
    first.locator('.sticker-cell').click()
    until(lambda: [x for x in json.loads(urllib.request.urlopen('http://127.0.0.1:8090/mock/sent').read()) if x['path'] == '/api/sendSticker'], 'sticker sent')
    page.click('.composer button[aria-label=Stickers]')
    page.click('nav.sticker-packs button[title="WhatsApp stickers not in a pack"]')
    third = page.locator('.picker-body .sticker-cell-wrap').nth(2); third.hover(); third.locator('.sticker-fav').click()
    until(lambda: page.locator('.picker-body .sticker-fav.on').count() == 1, 'star on')
    page.click('nav.sticker-packs button[title="Favourites and most used"]')
    page.wait_for_selector('.picker-body h4:text("Favourites")'); page.wait_for_selector('.picker-body h4:text("Most used")')
    page.screenshot(path=S + '/e2e78-top.png')
    top = api('GET', '/api/stickers/top'); print('top:', len(top['favorites']), len(top['used']))
    assert len(top['favorites']) == 1 and len(top['used']) == 1 and top['used'][0]['uses'] == 1
    # From the ⭐ tab: sending works
    page.locator('.picker-body .sticker-cell').first.click()
    until(lambda: len([x for x in json.loads(urllib.request.urlopen('http://127.0.0.1:8090/mock/sent').read()) if x['path'] == '/api/sendSticker']) == 2, 'sent from favourites')
    # Kept after a reload (on the server, not in this browser)
    page.reload(); page.wait_for_selector(row('Jan Bakker'), timeout=20000); page.click(row('Jan Bakker'))
    page.click('.composer button[aria-label=Stickers]')
    page.wait_for_selector('.picker-body h4:text("Favourites")')
    print('favourites and most used ok')
    assert not errors, errors
    b.close()
print('e2e78 ok')
