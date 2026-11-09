"""Theme options (light, dark, dark green) and how they look."""
import sys, time
from playwright.sync_api import sync_playwright

def goto(pg, title): pg.click(f'.settings-nav-row:has(strong:text-is("{title}"))')
def to_chats(pg):
    if pg.locator('button[aria-label="Back to settings"]').count(): pg.click('button[aria-label="Back to settings"]')
    pg.click('button[aria-label="Back to chats"]')
S = sys.argv[1]; errors = []
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 1600, 'height': 950}); page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row')
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Settings")'); goto(page, 'Appearance')
    page.wait_for_selector('.segmented')
    labels = page.locator('.segmented button').all_inner_texts(); print('theme options:', labels)
    assert labels == ['System', 'Light', 'Dark blue', 'Dark green'], labels
    page.click('.segmented button:has-text("Dark green")')
    assert page.evaluate("document.documentElement.dataset.theme") == 'dark-green'
    time.sleep(0.3); page.screenshot(path=f'{S}/shots8/01-settings-green.png')
    page.reload(); page.wait_for_selector('.chat-row')
    assert page.evaluate("document.documentElement.dataset.theme") == 'dark-green', 'not kept after reload'
    page.click('.chat-row:has-text("Weekend")'); page.wait_for_selector('.msg')
    page.click('textarea'); page.keyboard.type('Looks like home now'); page.keyboard.press('Enter'); time.sleep(4)
    page.screenshot(path=f'{S}/shots8/02-group-green.png')
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg'); page.click('textarea'); page.keyboard.type('Read ticks?'); page.keyboard.press('Enter')
    page.wait_for_selector('.msg.out:has-text("Read ticks?") .status.read', timeout=8000); time.sleep(3)
    page.click('.chat-head-main'); page.wait_for_selector('.panel-hero'); time.sleep(0.5)
    page.screenshot(path=f'{S}/shots8/03-direct-green-info.png')
    # Dark blue unchanged
    page.click('.panel-head button[aria-label=Close]')
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Settings")'); goto(page, 'Appearance'); page.click('.segmented button:has-text("Dark blue")')
    to_chats(page); time.sleep(0.4)
    page.screenshot(path=f'{S}/shots8/04-direct-blue.png')
    b.close()
print('ERRORS:', errors)
