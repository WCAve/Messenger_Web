"""Chat list filters: All / Signal / WhatsApp, unread counts per network, remembered after a reload, search within a filter."""
import sys, time
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
SIGNAL = ['Alice de Vries', 'Weekend plans', 'Carol']
WHATSAPP = ['Jan Bakker', 'Familie', 'Privé Pieter']
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 1000})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Familie'), timeout=20000); time.sleep(4)
    titles = lambda: page.locator('.chat-list .chat-row-wrap .chat-title').all_inner_texts()
    print('filters:', page.locator('.chat-filter').all_inner_texts())
    assert page.locator('.chat-filter').count() == 3 and page.locator('.chat-filter.on').inner_text().startswith('All')
    page.click('.chat-filter.signal'); time.sleep(0.4)
    t = titles(); print('signal:', t)
    assert all(x in t for x in SIGNAL) and not any(x in t for x in WHATSAPP), t
    page.click('.chat-filter.whatsapp'); time.sleep(0.4)
    t = titles(); print('whatsapp:', t)
    assert all(x in t for x in WHATSAPP) and not any(x in t for x in SIGNAL), t
    page.screenshot(path=S + '/e2e38.png', clip={'x': 0, 'y': 0, 'width': 420, 'height': 520})
    # remembered after a reload
    page.reload(); page.wait_for_selector(row('Familie'), timeout=20000); time.sleep(1)
    assert page.locator('.chat-filter.on').inner_text().startswith('WhatsApp')
    assert not any(x in titles() for x in SIGNAL)
    print('remembered ok')
    # search stays within the filter
    page.fill('input[aria-label="Search chats and messages"]', 'a'); time.sleep(1.2)
    t = titles(); print('search a:', t)
    assert not any(x in t for x in SIGNAL), t
    page.fill('input[aria-label="Search chats and messages"]', '')
    page.click('.chat-filter:has-text("All")'); time.sleep(0.4)
    t = titles(); assert all(x in t for x in SIGNAL + WHATSAPP), t
    print('chat filters ok')
    b.close()
print('ERRORS:', errors)
