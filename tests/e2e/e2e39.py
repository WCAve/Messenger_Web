"""Two + buttons, one per network: each New chat shows only that network's contacts and groups, and New group from it is fixed to that network."""
import sys, time
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 1000})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row-wrap:has(.chat-title:text-is("Familie"))', timeout=20000); time.sleep(3)
    assert page.locator('button[aria-label="New chat"]').count() == 0
    sig, wa = page.locator('button[aria-label="New Signal chat"]'), page.locator('button[aria-label="New WhatsApp chat"]')
    assert sig.count() == 1 and wa.count() == 1
    assert sig.locator('.net-badge').count() == 1 and wa.locator('.net-badge').count() == 1
    page.screenshot(path=S + '/e2e39.png', clip={'x': 0, 'y': 0, 'width': 420, 'height': 120})
    titles = lambda: page.locator('.chat-list .chat-title').all_inner_texts()
    # Signal
    sig.click(); time.sleep(1.2)
    t = titles(); print('signal:', t)
    assert 'New Signal group' in t and 'Weekend plans' in t and 'Familie' not in t and not any('Join' in x for x in t), t
    page.fill('input[aria-label="Name or phone number"]', '+31655500077'); time.sleep(0.4)
    t = titles(); print('signal typed:', t)
    assert 'Message +31655500077 on Signal' in t and not any('on WhatsApp' in x for x in t), t
    page.fill('input[aria-label="Name or phone number"]', '')
    page.click('.chat-row:has-text("New Signal group")'); time.sleep(0.6)
    assert page.locator('.network-switch').count() == 0
    print('signal group head:', page.locator('.side-head').first.inner_text())
    assert 'Signal' in page.locator('.side-head').first.inner_text()
    page.click('.new-group button[aria-label="Back"]'); time.sleep(0.6)
    # WhatsApp
    page.click('button[aria-label="New WhatsApp chat"]'); time.sleep(1.2)
    t = titles(); print('whatsapp:', t)
    assert 'New WhatsApp group' in t and 'Familie' in t and 'Weekend plans' not in t and any('Join' in x for x in t), t
    page.fill('input[aria-label="Name or phone number"]', '+31655500077'); time.sleep(0.4)
    t = titles(); assert 'Message +31655500077 on WhatsApp' in t and not any('on Signal' in x for x in t), t
    page.fill('input[aria-label="Name or phone number"]', '')
    page.click('.chat-row:has-text("New WhatsApp group")'); time.sleep(0.6)
    assert page.locator('.network-switch').count() == 0 and 'WhatsApp' in page.locator('.side-head').first.inner_text()
    print('two plus buttons ok')
    b.close()
print('ERRORS:', errors)
