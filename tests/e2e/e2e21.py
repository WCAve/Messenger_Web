"""History import in pages, stopping early on re-import, automatic restart of a failed WAHA session."""
import sys, time, json, re, urllib.request, os
MW = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
from playwright.sync_api import sync_playwright

def goto(pg, title): pg.click(f'.settings-nav-row:has(strong:text-is("{title}"))')
def to_chats(pg):
    if pg.locator('button[aria-label="Back to settings"]').count(): pg.click('button[aria-label="Back to settings"]')
    pg.click('button[aria-label="Back to chats"]')
S = sys.argv[1]; errors = []
def wa(path, data=None):
    r = urllib.request.Request('http://127.0.0.1:8090' + path, data=json.dumps(data).encode() if data is not None else None, headers={'content-type': 'application/json'}, method='POST' if data is not None else 'GET')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
def until(fn, secs=10, msg='timeout'):
    end = time.time() + secs
    while time.time() < end:
        if fn(): return
        time.sleep(0.3)
    raise AssertionError(msg)
SANNE = '31655500002@c.us'
log = lambda: open(os.environ.get('E2E_SERVER_LOG', S + '/server.log')).read()
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 900})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row', timeout=20000); time.sleep(9)
    print('bulk:', wa('/mock/bulk', {'from': 'sanne', 'n': 2500}))
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Settings")'); goto(page, 'History and backup')
    sels = page.locator('.history-settings select'); sels.nth(0).select_option('0'); sels.nth(1).select_option('0'); time.sleep(0.5)

    # 1. big chat in pages of 1000
    before = len(wa('/mock/stats')['pages'])
    page.click('button:has-text("Import history now")')
    until(lambda: page.locator('text=Importing history').count() > 0 or 'Getting the chat list' in page.inner_text('body'), 10, 'import did not start')
    until(lambda: page.locator('text=Importing history').count() == 0 and 'Getting the chat list' not in page.inner_text('body'), 90, 'import did not finish')
    pages = [x for x in wa('/mock/stats')['pages'][before:] if x['chat'] == SANNE]
    print('pages:', pages)
    assert len(pages) >= 3 and all(x['limit'] <= 1000 for x in pages), pages
    n = int(re.findall(r'history import: (\d+) new messages', log())[-1])
    assert n >= 2500, n
    print('paged import ok:', n)

    # 2. again: stops after the first page, nothing new
    before = len(wa('/mock/stats')['pages'])
    page.click('button:has-text("Import history now")'); time.sleep(1)
    until(lambda: not page.locator('text=Importing history').count(), 30, 'second import did not finish')
    pages = [x for x in wa('/mock/stats')['pages'][before:] if x['chat'] == SANNE]
    assert len(pages) == 1, pages
    print('re-import stops early ok')

    # 3. a failed session is restarted automatically
    r0 = wa('/mock/stats')['restarts']
    wa('/mock/status', {'status': 'FAILED'})
    page.click('button[aria-label="Back to settings"]'); goto(page, 'WhatsApp')
    try:
        page.wait_for_selector('text=Restarting it automatically', timeout=10000)
    except Exception:
        page.screenshot(path=S + '/e2e21-fail.png'); raise
    until(lambda: wa('/mock/stats')['restarts'] > r0, 20, 'no automatic restart')
    page.wait_for_selector('.settings-section:has-text("WhatsApp") dd:has-text("+31600000009")', timeout=20000)
    assert 'restarting it (attempt 1)' in log()
    print('auto restart ok')
    b.close()
print('ERRORS:', errors)
