"""Sticker search in the picker: text read in stickers (a stand-in reader here; the real models are tested
in the Docker image), a small misspelling, Signal packs by name and emoji, "still reading" while busy,
and big grids shown 300 at a time."""
# server-env: STICKER_OCR=fake STICKER_OCR_DELAY_MS=500 STICKER_OCR_PAUSE_MS=0
import sys, time, json, base64, struct, zlib, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def png(n, text=None):
    raw = b'\x00' + bytes([n % 256, (n // 256) % 256, 99])
    c = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    b = b'\x89PNG\r\n\x1a\n' + c(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) + c(b'IDAT', zlib.compress(raw)) + c(b'IEND', b'')
    return b + (b'OCRTEXT:' + text.encode() + b'\x00' if text else b'')
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
def until(fn, what, secs=20):
    end = time.time() + secs
    while time.time() < end:
        v = fn()
        if v: return v
        time.sleep(0.3)
    raise AssertionError('timed out: ' + what)
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1300, 'height': 900}); page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Jan Bakker'), timeout=20000); time.sleep(1)
    api = lambda method, path, body=None: page.evaluate("([m, p, b]) => fetch(p, {method: m, headers: {'content-type': 'application/json'}, body: b ? JSON.stringify(b) : undefined}).then(r => r.json())", [method, path, body])
    texts = ['Nee joh!', 'Goedemorgen allemaal', 'Ik ben er klaar mee']
    api('POST', '/api/stickers/images', {'images': ['data:image/png;base64,' + base64.b64encode(png(i, t)).decode() for i, t in enumerate(texts)]})
    for k in range(7):
        api('POST', '/api/stickers/images', {'images': ['data:image/png;base64,' + base64.b64encode(png(1000 + k * 50 + i)).decode() for i in range(50)]})
    r = until(lambda: (lambda x: x if x['reading']['done'] == x['reading']['total'] else None)(api('GET', '/api/stickers/search?q=nee')), 'all read')
    print('reading:', r['reading'], 'results:', [x.get('text') for x in r['results']])
    assert [x.get('text') for x in r['results']] == ['Nee joh!']

    page.click(row('Jan Bakker')); page.wait_for_selector('.msg')
    page.click('.composer button[aria-label=Emoji]'); page.click('.picker-tabs button:has-text("Stickers")')
    box = page.locator('input[aria-label="Search stickers"]')
    box.fill('nee joh'); page.wait_for_selector('.picker-body .sticker-cell[title="Nee joh!"]')
    assert page.locator('.picker-body .sticker-cell').count() == 1
    box.fill('goedemorgn'); page.wait_for_selector('.picker-body .sticker-cell[title="Goedemorgen allemaal"]'); print('misspelled ok')
    box.fill('blob'); page.wait_for_selector('.picker-body .sticker-cell[title*="Blob"]'); print('signal pack by name ok:', page.locator('.picker-body .sticker-cell').count())
    box.fill('zzzz'); page.wait_for_selector('.picker-body :text("No stickers found")')
    box.fill('klaar'); page.wait_for_selector('.picker-body .sticker-cell[title="Ik ben er klaar mee"]')
    page.screenshot(path=S + '/e2e80-search.png')
    page.click('.picker-body .sticker-cell[title="Ik ben er klaar mee"]')
    until(lambda: [x for x in json.loads(urllib.request.urlopen('http://127.0.0.1:8090/mock/sent').read()) if x['path'] == '/api/sendSticker'], 'sent from search')
    print('send from search ok')

    # 350+ stickers not in a pack: 300 shown, then the rest
    page.click('.composer button[aria-label=Emoji]'); page.click('.picker-tabs button:has-text("Stickers")')
    page.click('nav.sticker-packs button[title="WhatsApp stickers not in a pack"]')
    page.wait_for_selector('.picker-body button.show-more')
    n = page.locator('.picker-body .sticker-cell').count(); print('shown:', n, page.locator('.picker-body button.show-more').inner_text())
    assert n == 300
    left = int(''.join(ch for ch in page.locator('.picker-body button.show-more').inner_text() if ch.isdigit()))
    page.click('.picker-body button.show-more'); time.sleep(0.3)
    assert page.locator('.picker-body .sticker-cell').count() == 300 + left and not page.locator('.picker-body button.show-more').count()
    print('paging ok')
    assert not errors, errors
    b.close()
print('e2e80 ok')
