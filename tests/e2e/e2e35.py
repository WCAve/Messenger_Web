"""What's new: no popup on a first visit, a popup with only the newer changes after an update, ⋮ → What's new shows all."""
import sys, time
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 1000})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Familie'), timeout=20000); time.sleep(2)
    assert page.locator('.whats-new').count() == 0, 'popup on a first visit'
    newest = page.evaluate("localStorage.getItem('sw-changelog-seen')")
    print('first visit: no popup, remembered', newest)
    # an update: this browser last saw an older entry
    page.evaluate("localStorage.setItem('sw-changelog-seen', '2026-11-05-2')")
    page.reload(); page.wait_for_selector('.whats-new', timeout=10000)
    dates = page.locator('.whats-new section h3').all_inner_texts()
    print('after update:', dates)
    assert dates and all('5 November' not in d and '3 November' not in d for d in dates), dates
    page.screenshot(path=S + '/e2e35.png')
    page.click('.whats-new button:has-text("Got it")')
    assert page.locator('.whats-new').count() == 0
    page.reload(); page.wait_for_selector(row('Familie')); time.sleep(1.5)
    assert page.locator('.whats-new').count() == 0, 'shown again after Got it'
    print('seen ok')
    # the menu shows everything
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("What’s new")')
    page.wait_for_selector('.whats-new')
    n = page.locator('.whats-new section').count(); print('all entries:', n)
    assert n >= 5
    page.keyboard.press('Escape'); assert page.locator('.whats-new').count() == 0
    print('menu ok')
    b.close()
print('ERRORS:', errors)
