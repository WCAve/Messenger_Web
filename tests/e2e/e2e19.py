"""History import waits while WhatsApp Web restarts, then resumes."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright

def goto(pg, title): pg.click(f'.settings-nav-row:has(strong:text-is("{title}"))')
def to_chats(pg):
    if pg.locator('button[aria-label="Back to settings"]').count(): pg.click('button[aria-label="Back to settings"]')
    pg.click('button[aria-label="Back to chats"]')
S = sys.argv[1]; errors = []
def wa(path, data=None):
    r = urllib.request.Request('http://127.0.0.1:8090' + path, data=json.dumps(data).encode() if data is not None else None, headers={'content-type': 'application/json'}, method='POST' if data is not None else 'GET')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 900})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row', timeout=20000); time.sleep(9)
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Settings")'); goto(page, 'History and backup')
    wa('/mock/config', {'messagesDelayMs': 2500})
    page.click('button:has-text("Import history now")')
    page.wait_for_selector('text=Importing history from WhatsApp (chat', timeout=10000)
    time.sleep(1)
    wa('/mock/status', {'status': 'FAILED'})   # WhatsApp Web crashes mid-import
    page.wait_for_selector('text=WhatsApp Web restarted', timeout=15000)
    print('waiting shown ok')
    wa('/mock/config', {'messagesDelayMs': 0})
    time.sleep(2); wa('/mock/status', {'status': 'WORKING'})
    import re
    end = time.time() + 40
    while time.time() < end and not re.search(r'No older messages found|Imported \d+ messages', page.inner_text('body')): time.sleep(0.5)
    assert re.search(r'No older messages found|Imported \d+ messages', page.inner_text('body')), 'import did not finish'
    log = open(S + '/server.log').read()
    assert 'waiting for it to come back' in log, 'no resume in log'
    assert 'history import failed' not in log.split('waiting for it to come back')[-1], 'import failed after resume'
    print('resumed ok')
    b.close()
print('ERRORS:', errors)
