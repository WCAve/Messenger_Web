"""Sidebar width and resetting it, chat list previews."""
import sys, time
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1400, 'height': 900})
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/')
    page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row')
    # --- resize ---
    w0 = page.locator('.sidebar').bounding_box()['width']
    r = page.locator('.side-resizer').bounding_box()
    page.mouse.move(r['x'] + 4, 400); page.mouse.down()
    for x in range(int(r['x']), 620, 20): page.mouse.move(x, 400)
    page.mouse.move(620, 400); page.mouse.up()
    w1 = page.locator('.sidebar').bounding_box()['width']
    print('sidebar', round(w0), '->', round(w1))
    assert 600 <= w1 <= 625, w1
    page.reload(); page.wait_for_selector('.chat-row')
    w2 = page.locator('.sidebar').bounding_box()['width']; assert abs(w2 - w1) < 2, ('not kept', w2)
    page.locator('.side-resizer').focus(); page.keyboard.press('ArrowLeft'); time.sleep(0.2)
    w3 = page.locator('.sidebar').bounding_box()['width']; assert w3 < w2, 'keyboard resize'
    page.screenshot(path=f'{S}/shots5/01-wide-sidebar.png')
    page.locator('.side-resizer').dblclick(); time.sleep(0.2)
    w4 = page.locator('.sidebar').bounding_box()['width']; print('reset to', round(w4)); assert abs(w4 - w0) < 2
    # --- ticks ---
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg')
    page.click('textarea'); page.keyboard.type('Tick check'); page.keyboard.press('Enter')
    page.wait_for_selector('.msg.out:has-text("Tick check") .status.delivered', timeout=5000)
    page.locator('.msg.out:has-text("Tick check") .meta').screenshot(path=f'{S}/shots5/02-delivered.png')
    page.wait_for_selector('.msg.out:has-text("Tick check") .status.read', timeout=8000)
    page.locator('.msg.out:has-text("Tick check") .meta').screenshot(path=f'{S}/shots5/03-read.png')
    # --- edit via ↑ ---
    time.sleep(3)  # let the mock's auto-reply land (it's then not the last message, but ours is still the last own one)
    page.click('textarea'); page.keyboard.press('ArrowUp')
    page.wait_for_selector('.reply-preview.editing')
    for _ in range(25):
        if page.input_value('textarea'): break
        time.sleep(0.1)
    assert page.input_value('textarea') == 'Tick check', repr(page.input_value('textarea'))
    page.screenshot(path=f'{S}/shots5/04-editing.png')
    page.keyboard.press('Escape'); assert page.input_value('textarea') == ''
    page.keyboard.press('ArrowUp'); page.keyboard.press('End'); page.keyboard.type(' (edited) :tada:')
    page.keyboard.press('Enter')
    page.wait_for_selector('.msg.out:has-text("Tick check (edited) 🎉") .meta:has-text("edited")', timeout=5000)
    # --- edit via toolbar ---
    m = page.locator('.msg.out:has-text("Tick check (edited)")'); m.hover()
    m.locator('button[aria-label=Edit]').click()
    page.fill('textarea', 'Tick check, second edit'); page.keyboard.press('Enter')
    page.wait_for_selector('.msg.out:has-text("Tick check, second edit")', timeout=5000)
    time.sleep(0.5)
    page.screenshot(path=f'{S}/shots5/05-edited.png')
    sent = page.evaluate("fetch('http://localhost:3000/api/conversations').then(r=>r.json())")
    preview = [c for c in sent if c['title'].startswith('Alice')][0]['lastMessage']['text']
    print('chat list preview:', preview)
    # dark ticks
    d = b.new_context(viewport={'width': 1400, 'height': 900}, color_scheme='dark', storage_state=ctx.storage_state())
    dp = d.new_page(); dp.goto('http://localhost:3000/'); dp.wait_for_selector('.chat-row'); dp.click('.chat-row:has-text("Alice")'); dp.wait_for_selector('.msg.out .status.read')
    time.sleep(0.5); dp.locator('.messages').screenshot(path=f'{S}/shots5/06-dark.png')
    b.close()
print('ERRORS:', errors)
