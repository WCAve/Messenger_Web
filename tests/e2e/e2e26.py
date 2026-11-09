"""Sticker manager and the one sticker picker: own packs, sending across networks, recent stickers."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def req(base, path, data=None):
    r = urllib.request.Request(base + path, data=json.dumps(data).encode() if data is not None else None, headers={'content-type': 'application/json'}, method='POST' if data is not None else 'GET')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
wa = lambda path, data=None: req('http://127.0.0.1:8090', path, data)
sig = lambda path, data=None: req('http://127.0.0.1:8080', path, data)
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
def until(fn, secs=10, msg='timeout'):
    end = time.time() + secs
    while time.time() < end:
        if fn(): return
        time.sleep(0.3)
    raise AssertionError(msg)
wa_stickers = lambda: [s for s in wa('/mock/sent') if s['path'] == '/api/sendSticker']
sig_sends = lambda: [s for s in sig('/mock/sent') if 'path' not in s and 'recipients' in s]

with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 1000})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('dialog', lambda d: d.accept('Hondjes') if d.type == 'prompt' else d.accept())
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Familie'), timeout=20000); time.sleep(6)
    # two WhatsApp stickers arrive, so the library has something
    for _ in range(2):
        wa('/mock/incoming', {'from': 'jan', 'text': '', 'media': 'image/webp', 'extra': {'data': {'type': 'sticker'}}})
    page.click(row('Jan Bakker')); until(lambda: page.locator('.msg .bubble.sticker img.sticker-img').count() >= 2, 8, 'stickers not received')

    # --- the manager ---
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Sticker manager")')
    page.wait_for_selector('.sticker-manager h2:text("Sticker manager")')
    page.wait_for_selector('.sticker-manager .stk-unsorted .stk-cell', timeout=5000)
    n0 = page.locator('.stk-unsorted .stk-cell').count(); assert n0 >= 2, n0
    assert page.locator('.sticker-manager .stk-pack-head:has-text("Blob faces")').count() == 1, 'signal packs missing'
    page.locator('.stk-unsorted .stk-cell').nth(0).click()
    page.wait_for_selector('.stk-toolbar :text("1 selected")')
    page.fill('input[aria-label="New pack name"]', 'Katten'); page.click('.stk-toolbar button:has-text("New pack")')
    page.wait_for_selector('.stk-pack-head:has-text("Katten")')
    until(lambda: page.locator('.stk-unsorted .stk-cell').count() == n0 - 1, 5, 'sticker still unsorted')
    # add the other one via "Add to pack"
    page.locator('.stk-unsorted .stk-cell').nth(0).click()
    page.select_option('select[aria-label="Pack to add to"]', label='Katten'); page.click('.stk-toolbar button:text-is("Add")')
    page.wait_for_selector('.stk-pack-head:has-text("Katten"):has-text("2 stickers")')
    # rename, take one out
    page.click('.stk-pack-head:has-text("Katten")'); page.click('.stk-pack-body button:has-text("Rename")')
    page.wait_for_selector('.stk-pack-head:has-text("Hondjes")')
    page.locator('.stk-pack-body .stk-cell').nth(1).hover(); page.locator('.stk-pack-body .stk-remove').nth(1).click()
    page.wait_for_selector('.stk-pack-head:has-text("Hondjes"):has-text("1 sticker")')
    print('manager ok')
    # survives a reload
    page.reload(); page.wait_for_selector(row('Familie'), timeout=20000)
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Sticker manager")')
    page.wait_for_selector('.stk-pack-head:has-text("Hondjes"):has-text("1 sticker")')
    page.click('button[aria-label="Back to chats"]')
    print('persisted ok')

    # --- the picker is the same everywhere ---
    def open_stickers():
        page.click('button[aria-label=Emoji]'); page.click('.picker-tabs button:has-text("Stickers")')
        page.wait_for_selector('nav.sticker-packs')
    page.click(row('Jan Bakker')); page.wait_for_selector('.msg:has-text("Kijk eens")')
    open_stickers()
    nav_wa = [page.get_attribute(x, 'title') for x in ['nav.sticker-packs button'] for _ in [0]]
    assert page.locator('nav.sticker-packs button[title="Blob faces"]').count() == 1
    assert page.locator('nav.sticker-packs button[title="Hondjes"]').count() == 1
    # your pack, in WhatsApp: a WhatsApp sticker
    before = len(wa_stickers())
    page.click('nav.sticker-packs button[title="Hondjes"]'); page.click('.picker-body .sticker-cell:has(img)')
    until(lambda: len(wa_stickers()) == before + 1, 8, 'local sticker not sent to WhatsApp')
    # a Signal pack sticker, in WhatsApp: also a WhatsApp sticker
    open_stickers()
    page.click('nav.sticker-packs button[title="Blob faces"]'); page.locator('.picker-body .sticker-cell').first.click()
    until(lambda: len(wa_stickers()) == before + 2, 8, 'signal sticker not sent to WhatsApp')
    s = wa_stickers()[-1]; assert s['chatId'].endswith('@c.us') and s.get('file'), s
    print('whatsapp sends ok', s['file'].get('mimetype'))
    page.wait_for_selector('.msg.out .bubble.sticker img', timeout=5000)
    assert page.locator('.form-error').count() == 0

    # a Signal chat: same packs; your pack goes as a picture
    page.click(row('Alice de Vries')); page.wait_for_selector('.composer textarea')
    open_stickers()
    assert page.locator('nav.sticker-packs button[title="Hondjes"]').count() == 1
    assert page.locator('nav.sticker-packs button[title="Send an image as a sticker"]').count() == 0
    page.click('nav.sticker-packs button[title="Hondjes"]')
    page.wait_for_selector('.picker-body :text("sent as a picture")')
    n = len(sig_sends()); page.click('.picker-body .sticker-cell:has(img)')
    until(lambda: len(sig_sends()) == n + 1, 8, 'not sent to Signal')
    last = sig_sends()[-1]; assert last.get('base64_attachments') and not last.get('sticker'), {k: str(v)[:40] for k, v in last.items()}
    open_stickers(); page.click('nav.sticker-packs button[title="Blob faces"]'); page.locator('.picker-body .sticker-cell').first.click()
    until(lambda: len(sig_sends()) == n + 2 and sig_sends()[-1].get('sticker'), 8, 'signal sticker not sent as a sticker')
    print('signal sends ok')
    # recent shows both kinds
    open_stickers(); page.click('nav.sticker-packs button[title="Recent"]')
    assert page.locator('.picker-body .sticker-cell').count() >= 2
    print('recent ok')
    # picker gear opens the manager
    page.click('nav.sticker-packs button[aria-label="Sticker manager"]'); page.wait_for_selector('.sticker-manager')
    page.screenshot(path=S + '/e2e26.png')
    b.close()
print('ERRORS:', errors)
