"""Search words on stickers: added by hand from the ⋯ menu (also on Signal pack stickers), learned from a
search you sent a sticker from, found first; removing a sticker from the picker with "Undo"; look-alike
stickers (the same picture, different files) counted in Settings → Stickers for sorting later."""
# server-env: STICKER_OCR=fake STICKER_OCR_DELAY_MS=500 STICKER_OCR_PAUSE_MS=0
import sys, time, json, base64, struct, zlib, urllib.request, urllib.parse
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def png(w, h, px, text=None):
    c = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    raw = b''.join(b'\x00' + b''.join(bytes(px(x, y)) for x in range(w)) for y in range(h))
    b = b'\x89PNG\r\n\x1a\n' + c(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + c(b'IDAT', zlib.compress(raw)) + c(b'IEND', b'')
    return b + (b'OCRTEXT:' + text.encode() + b'\x00' if text else b'')
flat = lambda n: (lambda x, y: (n, 40, 99))
stripes = lambda s: (lambda x, y: (230, 60, 60) if (x * 4 // s + y * 2 // s) % 3 == 0 else (30, 30, 200) if (x * 3 // s) % 2 else (250, 240, 200))
checks = lambda s: (lambda x, y: (0, 160, 0) if ((x * 5 // s) + (y * 5 // s)) % 2 else (255, 255, 255))
data = lambda b: 'data:image/png;base64,' + base64.b64encode(b).decode()
def until(fn, what, secs=20):
    end = time.time() + secs
    while time.time() < end:
        v = fn()
        if v: return v
        time.sleep(0.25)
    raise AssertionError('timed out: ' + what)
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
cell = lambda title: f'.picker-body .sticker-cell-wrap:has(.sticker-cell[title="{title}"])'
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 1000})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Jan Bakker'), timeout=20000)
    api = lambda method, path, body=None: page.evaluate("([m, p, b]) => fetch(p, {method: m, headers: {'content-type': 'application/json'}, body: b ? JSON.stringify(b) : undefined}).then(r => r.json())", [method, path, body])
    # Hallo (text), Feest (no text, gets a word by hand), two look-alikes (same picture, 32 and 48 px), and another
    api('POST', '/api/stickers/images', {'images': [data(png(1, 1, flat(5), 'Hallo daar')), data(png(1, 1, flat(9))), data(png(32, 32, stripes(32))), data(png(48, 48, stripes(48))), data(png(40, 40, checks(40)))]})
    lib = until(lambda: api('GET', '/api/stickers')['local']['unsorted'], 'library')
    assert len(lib) == 5, len(lib)
    until(lambda: (lambda r: r['done'] == r['total'] and r['looks']['done'] == r['total'])(api('GET', '/api/models')['reading']), 'read and fingerprinted')
    looks = api('GET', '/api/models')['reading']['looks']; print('look-alikes:', looks)
    assert looks['groups'] == 1 and looks['stickers'] == 2, looks

    page.click(row('Jan Bakker')); page.wait_for_selector('.msg')
    page.click('.composer button[aria-label=Stickers]')
    page.click('nav.sticker-packs button[title="WhatsApp stickers not in a pack"]'); page.wait_for_selector('.picker-body .sticker-cell')

    # A word by hand: ⋯ → Search words…
    plain = page.locator('.picker-body .sticker-cell-wrap').nth(3)  # newest first: the 1-pixel one without text
    plain.hover(); plain.locator('button.sticker-more').click()
    page.click('.sticker-menu button:has-text("Search words")'); page.wait_for_selector('.sticker-tags-dialog')
    page.fill('.sticker-tags-dialog input', 'feest'); page.keyboard.press('Enter')
    page.wait_for_selector('.sticker-tag:has-text("feest")'); page.click('.sticker-tags-dialog button:has-text("Save")')
    box = page.locator('input[aria-label="Search stickers"]')
    box.fill('feest'); page.wait_for_selector(cell('feest')); print('word by hand ok')

    # Remove from the picker, then Undo
    page.locator(cell('feest')).hover(); page.locator(cell('feest') + ' button.sticker-more').click()
    page.click('.sticker-menu button:has-text("Remove from stickers")')
    until(lambda: not page.locator(cell('feest')).count(), 'removed'); page.wait_for_selector('.sticker-undo')
    page.screenshot(path=S + '/e2e85-undo.png')
    page.click('.sticker-undo button:has-text("Undo")'); page.wait_for_selector(cell('feest')); print('remove + undo ok')

    # Learned: sent after searching "hallo" → the word sticks to it
    box.fill('hallo'); page.wait_for_selector(cell('Hallo daar')); page.click(cell('Hallo daar') + ' .sticker-cell')
    until(lambda: [x for x in json.loads(urllib.request.urlopen('http://127.0.0.1:8090/mock/sent').read()) if x['path'] == '/api/sendSticker'], 'sent')
    key = [s for s in api('GET', '/api/stickers')['local']['unsorted'] if s['id'] not in ()]
    tags = [api('GET', '/api/stickers/tags?key=' + urllib.parse.quote(s['key']))['tags'] for s in key]
    learned = [t for ts in tags for t in ts if t['learned']]
    assert learned == [{'tag': 'hallo', 'learned': True}], tags
    r = api('GET', '/api/stickers/search?q=hallo')['results']; assert r[0].get('tags') == ['hallo'], r
    print('learned ok')

    # Signal pack sticker: a word on it, found by that word
    page.click('.composer button[aria-label=Stickers]'); page.click('nav.sticker-packs button[title="Blob faces"]')
    first = page.locator('.picker-body .sticker-cell-wrap').first; first.hover(); first.locator('button.sticker-more').click()
    assert page.locator('.sticker-menu .menu-note').count(), 'Signal sticker offered removing'
    page.click('.sticker-menu button:has-text("Search words")'); page.fill('.sticker-tags-dialog input', 'blij, vrolijk'); page.keyboard.press('Enter')
    page.wait_for_selector('.sticker-tag:has-text("vrolijk")'); page.screenshot(path=S + '/e2e85-tags.png'); page.click('.sticker-tags-dialog button:has-text("Save")')
    page.locator('input[aria-label="Search stickers"]').fill('vrolijk'); page.wait_for_selector(cell('vrolijk') + ' img[src*="0123456789abcdef"]')
    print('signal sticker word ok')

    # Settings → Stickers says how many look-alikes
    page.keyboard.press('Escape')
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Settings")'); page.click('.settings-nav-row:has(strong:text-is("Stickers"))')
    page.wait_for_selector('text=Look-alikes: 1 groups (2 stickers)'); print('settings ok')
    assert not errors, errors
    b.close()
print('e2e85 ok')
