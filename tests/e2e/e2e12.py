"""Emoji: font loading, frequently used, suggestions while typing, emoji styles."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright

def goto(pg, title): pg.click(f'.settings-nav-row:has(strong:text-is("{title}"))')
def to_chats(pg):
    if pg.locator('button[aria-label="Back to settings"]').count(): pg.click('button[aria-label="Back to settings"]')
    pg.click('button[aria-label="Back to chats"]')
S = sys.argv[1]; errors = []
def wait(cond, t=10, msg='timeout'):
    end = time.time() + t
    while time.time() < end:
        v = cond()
        if v: return v
        time.sleep(0.2)
    raise AssertionError(msg)
shot = lambda page, n: page.screenshot(path=f'{S}/shots12/{n}.png')
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 1400, 'height': 900}); page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row')

    # no horizontal scroll in the message list, even with the unread divider
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg')
    assert page.evaluate("(() => { const m = document.querySelector('.messages'); return m.scrollWidth <= m.clientWidth })()"), 'horizontal scroll'

    # Noto by default: the emoji font loads and is used
    assert page.evaluate("document.documentElement.dataset.emoji") == 'noto'
    page.click('textarea'); page.keyboard.type('feest 🎉'); page.keyboard.press('Enter')
    wait(lambda: page.evaluate("document.fonts.check('16px \"Messenger Emoji\"', '🎉')"), msg='noto font not loaded')
    r = page.evaluate("fetch('/emoji/noto/NotoColorEmoji.ttf').then(r => [r.status, r.headers.get('content-encoding'), r.headers.get('cache-control')])")
    print('font response', r); assert r[0] == 200 and r[2].startswith('public, max-age=31536000')
    shot(page, '01-noto')

    # frequency: 🎉 three times, then the picker lists it first
    for i in range(2):
        page.click('textarea'); page.keyboard.type(f'nog een 🎉 {i}'); page.keyboard.press('Enter'); time.sleep(0.3)
    time.sleep(2)
    page.click('button[aria-label=Emoji]'); page.wait_for_selector('#cat-recent h4:has-text("Frequently used")')
    first = page.locator('#cat-recent .emoji-cell').first.inner_text()
    print('first frequent:', first); assert first == '🎉', first
    page.click('button[aria-label=Emoji]')

    # shared name: ":laugh" — after using 🤣 a lot it comes first, shown as :laugh:, and :laugh: becomes 🤣
    for i in range(4):
        page.click('textarea'); page.keyboard.type(f'haha 🤣 {i}'); page.keyboard.press('Enter'); time.sleep(0.3)
    time.sleep(2.5)
    page.reload(); page.wait_for_selector('.chat-row'); page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg'); time.sleep(1)
    page.click('textarea'); page.keyboard.type(':laug'); page.wait_for_selector('.emoji-suggest li')
    items = page.locator('.emoji-suggest:not(.mention-suggest) li').all_inner_texts()
    print('suggestions:', items); assert items[0].replace('\n', ' ') == '🤣 :laugh:', items
    page.fill('textarea', ''); page.click('textarea'); page.keyboard.type('x :laugh:')
    assert page.input_value('textarea') == 'x 🤣', page.input_value('textarea')
    page.fill('textarea', '')
    # picking 😂 by the name "laugh" makes it show as :laugh:
    page.keyboard.type(':laugh'); page.wait_for_selector('.emoji-suggest li')
    page.locator('.emoji-suggest li:has-text("😂")').first.dispatch_event('mousedown'); time.sleep(1.5)
    page.fill('textarea', ''); page.click('button[aria-label=Emoji]'); page.fill('.picker-search input', 'tears')
    t = page.locator('.emoji-cell:has-text("😂")').first.get_attribute('title'); print('title:', t); assert t == ':laugh:', t
    page.click('button[aria-label=Emoji]')
    print('usage ok')

    # Fluent and Twemoji draw images; System uses none
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Settings")'); goto(page, 'Appearance')
    for style, ext in [('Fluent 3D', 'webp'), ('Twemoji', 'png')]:
        page.click(f'.emoji-styles button:has-text("{style}")'); time.sleep(0.6)
        srcs = page.evaluate("[...document.querySelectorAll('.messages img.emoji')].map(i => [i.getAttribute('src'), i.complete && i.naturalWidth > 0])")
        assert srcs and all(ok for _, ok in srcs) and all(s.endswith(ext) for s, _ in srcs), srcs
        to_chats(page)
        wait(lambda: page.locator('.chat-row img.emoji').count() > 0, msg='chat list has no emoji images')
        shot(page, f'02-{ext}')
        page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Settings")'); goto(page, 'Appearance')
    page.click('.emoji-styles button:has-text("System")'); time.sleep(0.3)
    assert page.locator('.messages img.emoji').count() == 0 and page.evaluate("document.documentElement.dataset.emoji") == 'system'
    page.reload(); page.wait_for_selector('.chat-row')
    assert page.evaluate("document.documentElement.dataset.emoji") == 'system', 'not kept'
    print('styles ok')
    b.close()
print('ERRORS:', errors)
