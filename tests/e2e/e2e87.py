"""The sticker sorting game: keep (→ key, swipe right), throw away (← key, button), skip, search words added
on the way, undo; look-alikes: keep the best copy (the other goes, its search words move over), undo,
"not the same"."""
# server-env: STICKER_OCR=fake STICKER_OCR_DELAY_MS=300 STICKER_OCR_PAUSE_MS=0
import sys, time, json, base64, struct, zlib
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def png(w, h, px):
    c = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    raw = b''.join(b'\x00' + b''.join(bytes(px(x, y)) for x in range(w)) for y in range(h))
    return b'\x89PNG\r\n\x1a\n' + c(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + c(b'IDAT', zlib.compress(raw)) + c(b'IEND', b'')
flat = lambda n: (lambda x, y: (n, 40, 99))
stripes = lambda s: (lambda x, y: (230, 60, 60) if (x * 4 // s + y * 2 // s) % 3 == 0 else (30, 30, 200) if (x * 3 // s) % 2 else (250, 240, 200))
data = lambda b: 'data:image/png;base64,' + base64.b64encode(b).decode()
def until(fn, what, secs=20):
    end = time.time() + secs
    while time.time() < end:
        v = fn()
        if v: return v
        time.sleep(0.25)
    raise AssertionError('timed out: ' + what)
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1300, 'height': 950})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Jan Bakker'), timeout=20000)
    api = lambda method, path, body=None: page.evaluate("([m, p, b]) => fetch(p, {method: m, headers: {'content-type': 'application/json'}, body: b ? JSON.stringify(b) : undefined}).then(r => r.json())", [method, path, body])
    # Five plain stickers, and two look-alikes (added first: oldest, so they come last in the keep round)
    api('POST', '/api/stickers/images', {'images': [data(png(32, 32, stripes(32))), data(png(48, 48, stripes(48)))]})
    time.sleep(0.2)
    api('POST', '/api/stickers/images', {'images': [data(png(1, 1, flat(i * 20))) for i in range(5)]})
    lib = api('GET', '/api/stickers')['local']['unsorted']; assert len(lib) == 7, len(lib)
    until(lambda: (lambda r: r['looks']['done'] == r['total'])(api('GET', '/api/models')['reading']), 'fingerprints')
    twins = [s for s in lib if s['id'] not in [x['id'] for x in lib[:5]]]

    # Open from the sticker manager
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Sticker manager")')
    page.click('.sorter-entry button:has-text("Start sorting")'); page.wait_for_selector('.sorter .sorter-card:not(.behind) img')
    page.wait_for_selector('.sorter-tabs button:has-text("7 left")'); page.screenshot(path=S + '/e2e87-card.png')
    first = page.locator('.sorter-card:not(.behind) img').get_attribute('src')

    # 1: words, then keep with →
    page.fill('.sorter-words input', 'hoi, doei'); page.keyboard.press('Enter'); page.wait_for_selector('.sorter-words .sticker-tag:has-text("doei")')
    page.click('.sorter-card:not(.behind)'); page.keyboard.press('ArrowRight')
    page.wait_for_selector('.sorter-tabs button:has-text("6 left")')
    # 2: throw away with ←
    second = page.locator('.sorter-card:not(.behind) img').get_attribute('src')
    page.keyboard.press('ArrowLeft'); page.wait_for_selector('.sorter-tabs button:has-text("5 left")')
    # 3: undo brings it back
    page.click('.sorter-undo'); page.wait_for_selector('.sorter-tabs button:has-text("6 left")')
    assert page.locator('.sorter-card:not(.behind) img').get_attribute('src') == second, 'undo: not the same sticker back'
    page.click('.sorter-btn.throw'); page.wait_for_selector('.sorter-tabs button:has-text("5 left")')
    # 4: swipe right (drag) keeps
    c = page.locator('.sorter-card:not(.behind)').bounding_box(); x, y = c['x'] + c['width'] / 2, c['y'] + c['height'] / 2
    page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + 200, y + 10, steps=10); page.mouse.up()
    page.wait_for_selector('.sorter-tabs button:has-text("4 left")')
    # 5: skip doesn't decide
    page.click('.sorter-actions button:has-text("Skip")'); time.sleep(0.3)
    assert page.locator('.sorter-tabs button:has-text("4 left")').count()
    print('keep round ok')

    lib2 = {s['url']: s for s in api('GET', '/api/stickers')['local']['unsorted']}
    assert len(lib2) == 6, len(lib2)  # one thrown away
    kept = [s for u, s in lib2.items() if u == first][0]
    tags = api('GET', '/api/stickers/tags?key=' + kept['key'])['tags']; assert sorted(t['tag'] for t in tags) == ['doei', 'hoi'], tags

    # Look-alikes: give the smaller copy a search word; keep the bigger one: the word moves over
    small = min(twins, key=lambda s: len(s['url']))  # any one of them
    api('POST', '/api/stickers/tags', {'key': twins[1]['key'], 'tags': [{'tag': 'streepjes', 'learned': False}]})
    page.click('.sorter-tabs button:has-text("Look-alikes")'); page.wait_for_selector('.sorter-twin img')
    assert page.locator('.sorter-twin').count() == 2; page.screenshot(path=S + '/e2e87-twins.png')
    keep_url = page.locator('.sorter-twin img').nth(0).get_attribute('src')
    page.click('.sorter-twin >> nth=0 >> button:has-text("Keep only this one")'); page.wait_for_selector('.sorter-empty')
    lib3 = api('GET', '/api/stickers')['local']['unsorted']; assert len(lib3) == 5, len(lib3)
    keeper = [s for s in lib3 if s['url'] == keep_url][0]
    assert 'streepjes' in [t['tag'] for t in api('GET', '/api/stickers/tags?key=' + keeper['key'])['tags']], 'word not moved over'
    # Undo: both back; then "not the same" keeps both and isn't asked again
    page.click('.sorter-undo'); page.wait_for_selector('.sorter-twin')
    assert len(api('GET', '/api/stickers')['local']['unsorted']) == 6
    page.click('.sorter-actions button:has-text("Not the same")'); page.wait_for_selector('.sorter-empty')
    assert not api('GET', '/api/stickers/lookalikes')['groups'], 'asked again'
    print('look-alikes ok')

    page.keyboard.press('Escape'); page.wait_for_selector('.sorter', state='detached')
    assert not errors, errors
    b.close()
print('e2e87 ok')
