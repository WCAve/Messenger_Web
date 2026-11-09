"""Settings: theme (light/dark), read receipts, Enter sends, sign out everywhere."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright

def goto(pg, title): pg.click(f'.settings-nav-row:has(strong:text-is("{title}"))')
def to_chats(pg):
    if pg.locator('button[aria-label="Back to settings"]').count(): pg.click('button[aria-label="Back to settings"]')
    pg.click('button[aria-label="Back to chats"]')
S = sys.argv[1]; errors = []
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1400, 'height': 900}, color_scheme='light')
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/')
    page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row')
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg')
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Settings")'); goto(page, 'Appearance')
    page.wait_for_selector('.settings-section')
    time.sleep(0.5)
    page.screenshot(path=f'{S}/shots4/01-settings-light.png')
    page.click('.segmented button:has-text("Dark")')
    assert page.evaluate("document.documentElement.dataset.theme") == 'dark'
    time.sleep(0.3)
    page.screenshot(path=f'{S}/shots4/02-settings-dark.png')
    page.reload(); page.wait_for_selector('.chat-row')
    assert page.evaluate("document.documentElement.dataset.theme") == 'dark', 'theme not kept after reload'
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Settings")'); goto(page, 'Privacy')
    page.wait_for_selector('.settings-section')
    # server-side toggle
    page.locator('.setting-row:has-text("Send read receipts") input').click()
    time.sleep(0.5)
    st = page.evaluate("fetch('/api/settings').then(r=>r.json())")
    assert st['sendReadReceipts'] is False, st
    # enter to send off
    page.click('button[aria-label="Back to settings"]'); goto(page, 'Chats')
    page.locator('.setting-row:has-text("Enter sends") input').click()
    to_chats(page)
    page.click('.chat-row:has-text("Carol")'); page.wait_for_selector('.msg')
    page.click('textarea'); page.keyboard.type('line one'); page.keyboard.press('Enter'); page.keyboard.type('line two')
    assert page.input_value('textarea') == 'line one\nline two', page.input_value('textarea')
    page.keyboard.press('Control+Enter'); time.sleep(0.6)
    assert page.locator('.msg.out:has-text("line two")').count() == 1
    page.click('.segmented button:has-text("System")') if page.locator('.segmented').count() else None
    # system theme follows OS
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Settings")'); goto(page, 'Appearance')
    page.click('.segmented button:has-text("System")')
    assert page.evaluate("document.documentElement.dataset.theme") is None
    # sign out everywhere: a second browser gets logged out too
    other = b.new_context(storage_state=ctx.storage_state()); op = other.new_page(); op.goto('http://localhost:3000/'); op.wait_for_selector('.chat-row')
    page.once('dialog', lambda d: d.accept())
    page.click('button[aria-label="Back to settings"]'); goto(page, 'Account')
    page.click('button:has-text("Sign out everywhere")')
    page.wait_for_selector('input[type=password]')
    op.reload(); op.wait_for_selector('input[type=password]')
    b.close()
print('ERRORS:', errors)
