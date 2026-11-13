"""Stickers open large in the photo viewer (Signal pack stickers and WhatsApp stickers), on their own."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def wa(path, body):
    req = urllib.request.Request(f'http://127.0.0.1:8090{path}', data=json.dumps(body).encode(), headers={'content-type': 'application/json'})
    return urllib.request.urlopen(req).read()
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 900})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row:has-text("Alice")', timeout=20000); time.sleep(2)

    def check(where):
        page.click('.msg .sticker-btn >> nth=-1')
        page.wait_for_selector('.lightbox img.lightbox-sticker', timeout=5000)
        for _ in range(20):
            if page.evaluate("(() => { const i = document.querySelector('.lightbox img.lightbox-sticker'); return i.complete && i.naturalWidth > 0; })()"): break
            time.sleep(0.25)
        box = page.locator('.lightbox img.lightbox-sticker').bounding_box(); print(where, 'sticker in the viewer:', round(box['width']), 'x', round(box['height']))
        assert box['width'] >= 600, box  # large: 70% of the 900 px window, not the chat's 180 px
        assert not page.locator('.lightbox-nav').count() and not page.locator('.lightbox-count').count(), 'should be on its own'
        assert page.evaluate("document.querySelector('.lightbox img.lightbox-sticker').naturalWidth") > 0, 'not loaded'
        page.screenshot(path=f'{S}/e2e63-{where}.png')
        page.keyboard.press('Escape'); page.wait_for_selector('.lightbox', state='detached')

    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg .sticker-btn')
    check('signal')
    wa('/mock/incoming', {'from': 'jan', 'text': '', 'media': 'image/webp', 'extra': {'data': {'type': 'sticker'}}})
    page.click('.chat-row:has-text("Jan Bakker")'); page.wait_for_selector('.msg .sticker-btn', timeout=8000)
    check('whatsapp')
    assert not errors, errors
    b.close()
print('e2e63 ok')
