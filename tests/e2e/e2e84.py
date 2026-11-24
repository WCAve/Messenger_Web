"""Hiding a Signal sticker pack (it can't be removed from Signal here): the sticker manager says "hidden",
the picker no longer shows it, its search and ⭐ (most used) leave it out; "Show" brings it back."""
import sys, time, json
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def until(fn, what, secs=10):
    end = time.time() + secs
    while time.time() < end:
        v = fn()
        if v: return v
        time.sleep(0.25)
    raise AssertionError('timed out: ' + what)
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
BLOB = '0123456789abcdef0123456789abcdef'
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 1000})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Alice de Vries'), timeout=20000); time.sleep(2)
    top = lambda: page.evaluate("fetch('/api/stickers/top').then(r => r.json())")

    # Send one from the pack, so it's among the most used
    page.click(row('Alice de Vries')); page.click('.composer button[aria-label=Stickers]')
    page.click('nav.sticker-packs button[title="Blob faces"]'); page.locator('.picker-body .sticker-cell').first.click()
    until(lambda: any(BLOB in t['key'] for t in top()['used']), 'sticker counted as used')

    # Hide it in the sticker manager
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Sticker manager")')
    head = '.sticker-manager .stk-pack-head:has-text("Blob faces")'
    page.click(head + ' button:has-text("Hide")'); page.wait_for_selector(head + ':has-text("hidden")')
    page.screenshot(path=S + '/e2e84-manager.png')
    assert not any(BLOB in t['key'] for t in top()['used'] + top()['favorites']), 'hidden pack still in ⭐'
    page.keyboard.press('Escape'); time.sleep(0.3)
    if page.locator('.sticker-manager').count(): page.click('.sticker-manager button[aria-label="Close"], .sticker-manager button[aria-label^="Back"]')

    # The picker: no pack button, nothing from it in a search by its name
    page.reload(); page.wait_for_selector(row('Alice de Vries'), timeout=20000); page.click(row('Alice de Vries'))
    page.click('.composer button[aria-label=Stickers]'); page.wait_for_selector('nav.sticker-packs')
    time.sleep(0.5); assert not page.locator('nav.sticker-packs button[title="Blob faces"]').count(), 'hidden pack in the picker'
    page.fill('.picker-search input', 'Blob'); time.sleep(1)
    assert not page.locator(f'.picker-body img[src*="{BLOB}"]').count(), 'hidden pack in the search'
    print('hidden ok')

    # Show it again
    page.click('.composer button[aria-label=Stickers]')
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Sticker manager")')
    page.click(head + ' button:has-text("Show")'); until(lambda: not page.locator(head + ':has-text("hidden")').count(), 'shown again')
    page.reload(); page.wait_for_selector(row('Alice de Vries'), timeout=20000); page.click(row('Alice de Vries'))
    page.click('.composer button[aria-label=Stickers]'); page.wait_for_selector('nav.sticker-packs button[title="Blob faces"]')
    print('shown again ok')
    assert not errors, errors
    b.close()
print('e2e84 ok')
