"""Member labels from an Android backup ("Import member labels only"), and which source wins."""
import sys, time, json, os, subprocess, urllib.request
from playwright.sync_api import sync_playwright

def goto(pg, title): pg.click(f'.settings-nav-row:has(strong:text-is("{title}"))')
def to_chats(pg):
    if pg.locator('button[aria-label="Back to settings"]').count(): pg.click('button[aria-label="Back to settings"]')
    pg.click('button[aria-label="Back to chats"]')
S = sys.argv[1]; errors = []
MW = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
DATA = os.environ.get('E2E_DATA') or os.path.join(MW, '.data')  # the app's data folder for this test run
def req(base, path, data=None):
    r = urllib.request.Request(base + path, data=json.dumps(data).encode() if data is not None else None, headers={'content-type': 'application/json'}, method='POST' if data is not None else 'GET')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
wa = lambda path, data=None: req('http://127.0.0.1:8090', path + ('&' if '?' in path else '?') + 'x-api-key=test-waha-key', data)
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
def until(fn, secs=10, msg='timeout'):
    end = time.time() + secs
    while time.time() < end:
        if fn(): return
        time.sleep(0.3)
    raise AssertionError(msg)
KEY = 'a1b2c3d4' * 8
backup = os.path.join(S, 'b28', 'msgstore.db.crypt15')

with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 1000})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Familie'), timeout=20000); time.sleep(6)
    wa('/mock/incoming', {'from': 'sanne', 'group': 'buren', 'text': 'Hoi buren'})  # so Buren is a chat here
    page.wait_for_selector(row('Buren'), timeout=10000)
    subprocess.run(['node', '--no-warnings', MW + '/mock/make-backup.mjs', backup, KEY, '{}'], check=True, capture_output=True)
    cookies = '; '.join(f"{c['name']}={c['value']}" for c in page.context.cookies())
    def api(path, data=None, raw=None, headers=None):
        h = {'cookie': cookies, **(headers or {})}
        if data is not None: h['content-type'] = 'application/json'
        r = urllib.request.Request('http://localhost:3000' + path, data=raw if raw is not None else json.dumps(data).encode() if data is not None else None, headers=h, method='POST' if (data is not None or raw is not None) else 'GET')
        return json.loads(urllib.request.urlopen(r).read() or b'null')

    # upload, then "Import member labels only" in the UI
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Settings")'); goto(page, 'History and backup')
    page.click('text=Import full history from an Android backup')
    page.set_input_files('.backup-import input[type=file]', backup)
    page.wait_for_selector('.backup-import :text("msgstore.db.crypt15 ·")', timeout=10000)
    page.fill('input[aria-label="64-digit backup key"]', KEY)
    page.click('.backup-import button:has-text("Import member labels only")')
    page.wait_for_selector('.backup-import :text("Imported 5 member labels in 2 groups")', timeout=20000)
    assert os.path.exists(DATA + '/whatsapp-backup/msgstore.db.crypt15'), 'backup file should stay after labels-only'
    assert not os.path.exists(DATA + '/whatsapp-backup/msgstore.decrypted.db'), 'decrypted copy kept'
    assert not page.locator('.backup-import :text("Imported 0 messages")').count()
    print('labels-only import ok')

    convs = {c['title']: c for c in api('/api/conversations')}
    def labels(title):
        return {m['name']: m.get('label') for m in api(f"/api/conversations/{convs[title]['id']}/info")['members']}
    until(lambda: 'You' in labels('Buren'), 15, 'Buren members not loaded')
    fam = labels('Familie'); bur = labels('Buren')
    print('Familie', fam); print('Buren', bur)
    assert fam['Jan Bakker'] == 'Chef', fam            # backup, matched through privacy id → number
    assert fam['Sanne'] == 'Organiser', fam            # WhatsApp beats the backup
    assert fam['You'] == 'Papa', fam                   # yours: WhatsApp beats the backup
    assert bur['You'] == 'Buurman', bur                # yours: only in the backup
    assert bur['Jan Bakker'] == 'Kookt goed', bur
    d = api(f"/api/conversations/{convs['Buren']['id']}/group")
    assert d['myLabel'] == 'Buurman', d
    print('priorities ok')

    # a live change still wins over the backup
    wa('/mock/label-event', {'group': '120363000000000001@g.us', 'id': '33333333333333@lid', 'pn': '31655500001@c.us', 'tag': 'Nieuwe kok'})
    until(lambda: labels('Familie')['Jan Bakker'] == 'Nieuwe kok', 10, 'live change lost')
    # shows in the chat
    to_chats(page)
    page.click(row('Buren')); page.wait_for_selector('.msg:has-text("Hoi buren")')
    page.click('.chat-head .chat-head-main, .chat-head button.head-title, .chat-head h2')
    page.wait_for_selector('aside.panel .member-row:has-text("You") .member-label:text("Buurman")', timeout=8000)
    page.wait_for_selector('aside.panel input[aria-label="Your member label"]')
    assert page.input_value('aside.panel input[aria-label="Your member label"]') == 'Buurman'
    print('ui ok')
    page.screenshot(path=S + '/e2e28.png')
    b.close()
print('ERRORS:', errors)
