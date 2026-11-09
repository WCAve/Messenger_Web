"""Pinned chats: pinning, reordering by drag and with the menu."""
import sys, time
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
def menu(page, title, item):
    page.hover(row(title)); page.click(row(title) + ' .row-menu-btn'); page.click(f'.row-menu button:has-text("{item}")'); time.sleep(0.4)
def order(page): return page.locator('.chat-row-wrap[draggable=true] .chat-title').all_inner_texts()
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 900})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Jan Bakker'), timeout=15000)
    for t in ['Carol', 'Jan Bakker', 'Alice de Vries']: menu(page, t, 'Pin chat')
    print('pinned:', order(page)); assert order(page) == ['Carol', 'Jan Bakker', 'Alice de Vries']
    # drag Alice above Carol
    page.drag_to = None
    src = page.locator(row('Alice de Vries')); dst = page.locator(row('Carol'))
    box = dst.bounding_box()
    src.drag_to(dst, target_position={'x': 40, 'y': 5})
    time.sleep(0.6); print('after drag:', order(page)); assert order(page) == ['Alice de Vries', 'Carol', 'Jan Bakker'], order(page)
    # menu: move Carol down
    menu(page, 'Carol', 'Move down'); print('after move down:', order(page)); assert order(page) == ['Alice de Vries', 'Jan Bakker', 'Carol']
    assert page.locator(row('Alice de Vries') + ' .row-menu-btn').count() == 1
    page.hover(row('Alice de Vries')); page.click(row('Alice de Vries') + ' .row-menu-btn')
    assert page.locator('.row-menu button:has-text("Move up")').count() == 0; page.mouse.move(900, 500)
    # kept after reload, and a newly pinned chat goes to the bottom
    page.reload(); page.wait_for_selector(row('Carol'))
    assert order(page) == ['Alice de Vries', 'Jan Bakker', 'Carol'], order(page)
    menu(page, 'Carol', 'Unpin chat'); menu(page, 'Weekend plans', 'Pin chat')
    print('final:', order(page)); assert order(page) == ['Alice de Vries', 'Jan Bakker', 'Weekend plans'], order(page)
    page.screenshot(path=f'{S}/pinned.png')
    b.close()
print('ERRORS:', errors)
