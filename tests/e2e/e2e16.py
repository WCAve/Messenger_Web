"""WhatsApp history import settings, and importing."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright

def goto(pg, title): pg.click(f'.settings-nav-row:has(strong:text-is("{title}"))')
def to_chats(pg):
    if pg.locator('button[aria-label="Back to settings"]').count(): pg.click('button[aria-label="Back to settings"]')
    pg.click('button[aria-label="Back to chats"]')
S = sys.argv[1]; errors = []
def wa(path):
    return json.loads(urllib.request.urlopen('http://127.0.0.1:8090' + path).read() or b'null')
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 900})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row', timeout=20000); time.sleep(9)  # let the automatic rounds finish
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Settings")'); goto(page, 'History and backup')
    page.wait_for_selector('.history-settings select')
    sels = page.locator('.history-settings select')
    assert sels.nth(0).input_value() == '40' and sels.nth(1).input_value() == '40'
    sels.nth(0).select_option('0'); sels.nth(1).select_option('0'); time.sleep(0.5)
    st = json.loads(urllib.request.urlopen(urllib.request.Request('http://localhost:3000/api/settings', headers={'cookie': '; '.join(f"{c['name']}={c['value']}" for c in page.context.cookies())})).read())
    assert st['waHistoryChats'] == 0 and st['waHistoryMessages'] == 0, st
    page.reload(); page.wait_for_selector('.chat-row'); page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Settings")'); goto(page, 'History and backup')
    page.wait_for_selector('.history-settings select')
    assert page.locator('.history-settings select').nth(1).input_value() == '0'
    print('settings saved ok')
    page.click('button:has-text("Import history now")')
    page.wait_for_selector('text=No older messages found', timeout=15000)
    lim = [r for r in open(S + '/waha.log').read().splitlines()]
    print('import ok')
    page.screenshot(path=S + '/e2e16.png')
    b.close()
print('ERRORS:', errors)
