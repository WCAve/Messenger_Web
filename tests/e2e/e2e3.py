"""Signal stickers: shown in chats, sticker picker, sending a sticker."""
import sys, time
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
with sync_playwright() as p:
    b = p.chromium.launch()
    for scheme in ['light', 'dark']:
        ctx = b.new_context(viewport={'width': 1400, 'height': 900}, color_scheme=scheme)
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
        page.goto('http://localhost:3000/')
        page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
        page.wait_for_selector('.chat-row')
        page.click('.chat-row:has-text("Alice")')
        page.wait_for_selector('.sticker-img')
        time.sleep(0.8)
        if scheme == 'dark':
            page.screenshot(path=f'{S}/shots3/dark-chat.png'); ctx.close(); continue
        page.click('button[aria-label=Emoji]')
        page.click('.picker-tabs button:has-text("Stickers")')
        page.wait_for_selector('.sticker-cell img')
        time.sleep(0.6)
        page.screenshot(path=f'{S}/shots3/01-sticker-tab.png')
        page.locator('.sticker-cell').nth(2).click()
        for _ in range(50):
            if page.locator('.msg.out .sticker-img').count() >= 1: break
            time.sleep(0.2)
        else: raise AssertionError('sent sticker not shown')
        time.sleep(3)
        page.screenshot(path=f'{S}/shots3/02-sticker-sent.png')
        # add pack via link
        page.click('button[aria-label=Emoji]')
        page.click('.picker-tabs button:has-text("Stickers")')
        page.click('button[aria-label="Add a sticker pack"]')
        page.fill('.sticker-add input', 'https://signal.art/addstickers/#pack_id=00112233445566778899aabbccddeeff&pack_key=' + 'c' * 64)
        page.click('.sticker-add button:has-text("Add pack")')
        page.wait_for_selector('.picker-body h4:has-text("Added from a link")')
        time.sleep(0.6)
        page.screenshot(path=f'{S}/shots3/03-pack-added.png')
        ctx.close()
    b.close()
print('ERRORS:', errors)
