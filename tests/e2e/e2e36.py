"""Replies quoting a sticker or photo show it (thumbnail + "Sticker"/"Photo"), not just "Attachment", on both networks."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def req(base, path, data=None):
    r = urllib.request.Request(base + path, data=json.dumps(data).encode() if data is not None else None, headers={'content-type': 'application/json'}, method='POST' if data is not None else 'GET')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
wa = lambda path, data=None: req('http://127.0.0.1:8090', path + ('&' if '?' in path else '?') + 'x-api-key=test-waha-key', data)
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
def reply_to(msg, text):
    msg.hover(); msg.locator('button[aria-label="Reply"]').click()
    page.wait_for_selector('.reply-preview')
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 1000})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Familie'), timeout=20000); time.sleep(5)
    # Signal: Alice's sticker
    page.click(row('Alice de Vries')); page.wait_for_selector('.msg .sticker-img')
    m = page.locator('.msg:has(.sticker-img)').last
    reply_to(m, '')
    assert 'Sticker' in page.inner_text('.reply-preview'), page.inner_text('.reply-preview')
    assert page.locator('.reply-preview img.quote-thumb.sticker').count() == 1
    page.fill('textarea', 'Eindelijk goede signal stickers'); page.keyboard.press('Enter')
    q = '.msg.out:has-text("Eindelijk goede") .quote'
    page.wait_for_selector(q + ' img.quote-thumb.sticker', timeout=8000)
    assert 'Sticker' in page.inner_text(q) and 'Attachment' not in page.inner_text(q), page.inner_text(q)
    print('signal sticker quote ok')
    # WhatsApp: a photo from Jan
    page.click(row('Jan Bakker')); page.wait_for_selector('.msg:has-text("Kijk eens")')
    wa('/mock/incoming', {'from': 'jan', 'text': '', 'media': 'image/jpeg'})
    time.sleep(2)
    m = page.locator('.msg:not(.out):has(.images)').last
    reply_to(m, '')
    assert 'Photo' in page.inner_text('.reply-preview'), page.inner_text('.reply-preview')
    page.fill('textarea', 'Mooie foto'); page.keyboard.press('Enter')
    q = '.msg.out:has-text("Mooie foto") .quote'
    page.wait_for_selector(q + ' img.quote-thumb', timeout=8000)
    assert 'Photo' in page.inner_text(q), page.inner_text(q)
    print('whatsapp photo quote ok')
    page.screenshot(path=S + '/e2e36.png')
    b.close()
print('ERRORS:', errors)
