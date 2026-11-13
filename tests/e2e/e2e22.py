"""Android backup import: upload, wrong key, import, history/groups/privacy-id chats, media folder, stickers from the folder, go to date."""
import sys, time, json, os, shutil, subprocess, urllib.request
from playwright.sync_api import sync_playwright

def goto(pg, title): pg.click(f'.settings-nav-row:has(strong:text-is("{title}"))')
def to_chats(pg):
    if pg.locator('button[aria-label="Back to settings"]').count(): pg.click('button[aria-label="Back to settings"]')
    pg.click('button[aria-label="Back to chats"]')
S = sys.argv[1]; errors = []
MW = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
DATA = os.environ.get('E2E_DATA') or os.path.join(MW, '.data')  # the app's data folder for this test run
def wa(path, data=None):
    r = urllib.request.Request('http://127.0.0.1:8090' + path, data=json.dumps(data).encode() if data is not None else None, headers={'content-type': 'application/json'}, method='POST' if data is not None else 'GET')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
def until(fn, secs=10, msg='timeout'):
    end = time.time() + secs
    while time.time() < end:
        if fn(): return
        time.sleep(0.3)
    raise AssertionError(msg)
KEY = 'a1b2c3d4' * 8
backup = os.path.join(S, 'msgstore.db.crypt15')

with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 1000})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Familie'), timeout=20000); time.sleep(8)
    hoi = [m for m in wa('/api/default/chats/31655500001%40c.us/messages?limit=50&x-api-key=test-waha-key') if 'Hoi' in m['body']][0]
    raw = hoi['id'].split('_')[2]
    subprocess.run(['node', '--no-warnings', MW + '/mock/make-backup.mjs', backup, KEY, json.dumps({'existingRaw': raw})], check=True, capture_output=True)

    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Settings")'); goto(page, 'History and backup')
    page.click('text=Import full history from an Android backup')
    page.set_input_files('.backup-import input[type=file]', backup)
    page.wait_for_selector('.backup-import :text("msgstore.db.crypt15 ·")', timeout=10000)
    assert 'WhatsApp 2.26.10.70' in page.inner_text('.backup-import')
    print('upload ok')

    # wrong key
    page.fill('input[aria-label="64-digit backup key"]', 'f' * 64)
    page.click('.backup-import button:has-text("Import backup")')
    page.wait_for_selector(".backup-import :text(\"That key doesn't open this backup\")", timeout=10000)
    print('wrong key ok')
    # right key, typed with spaces like the phone shows it
    page.fill('input[aria-label="64-digit backup key"]', ' '.join(KEY[i:i+4] for i in range(0, 64, 4)))
    page.click('.backup-import button:has-text("Import backup")')
    page.wait_for_selector('.backup-import :text("Imported")', timeout=20000)
    txt = page.inner_text('.backup-import'); print(txt.split('Imported')[1][:160])
    assert '1 was here already' in txt, txt
    assert not os.path.exists(DATA + '/whatsapp-backup/msgstore.db.crypt15'), 'backup file kept'
    assert not os.path.exists(DATA + '/whatsapp-backup/msgstore.decrypted.db'), 'decrypted copy kept'
    print('import ok')

    to_chats(page)
    page.click(row('Jan Bakker')); page.wait_for_selector('.msg:has-text("Kijk eens")')
    page.evaluate("document.querySelector('.messages').scrollTop = 0"); time.sleep(1.5)
    page.evaluate("document.querySelector('.messages').scrollTop = 0"); time.sleep(1.5)
    page.wait_for_selector('.msg:has-text("Heel oud bericht")', timeout=8000)
    assert page.locator('.msg .body:has-text("Hoi! Kom je zaterdag ook?")').count() == 1, 'duplicate'
    assert page.locator('.msg:has-text("Antwoord op het oude") .quote:has-text("Heel oud bericht")').count() == 1
    assert '❤️' in page.inner_text('.msg:has-text("Heel oud bericht") .reactions') or page.locator('.msg:has-text("Heel oud bericht") .reactions img[alt="❤️"]').count() == 1
    assert page.locator('.msg.out:has-text("Klopt, heel oud") strong:text-is("heel"), .msg.out:has-text("Klopt, heel oud") b:text-is("heel")').count() == 1
    assert page.locator('.msg:has-text("This message was deleted")').count() >= 1
    assert page.locator('.msg:has-text("📍 Dam")').count() == 1
    assert page.locator('.msg:has-text("Foto uit 2024")').count() == 1
    print('jan history ok')
    page.click(row('Familie')); page.wait_for_selector('.msg:has-text("jij toch")')
    page.evaluate("document.querySelector('.messages').scrollTop = 0"); time.sleep(1.5)
    page.wait_for_selector('.system-line:has-text("Sanne changed the group name to “Familie 2024”")', timeout=8000)
    assert page.locator('.system-line:has-text("Sanne added Jan Bakker")').count() == 1
    assert page.locator('.msg:has-text("Groepsbericht uit 2024") .mention').count() == 1
    print('group history ok')
    until(lambda: page.locator('.chat-row:has-text("Hallo van Kees")').count() == 1, 5, 'Kees chat missing')
    assert page.locator('.chat-row:has-text("mijn status")').count() == 0
    print('lid chat ok')

    # media folder
    d = DATA + '/whatsapp-backup/Media/WhatsApp Images'; os.makedirs(d, exist_ok=True)
    shutil.copy(MW + '/web/public/icon-192.png' if os.path.exists(MW + '/web/public/icon-192.png') else MW + '/web/public/icon.svg', d + '/IMG-20240301-WA0001.jpg')
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Settings")'); goto(page, 'History and backup')
    page.click('text=Import full history from an Android backup')
    page.click('.backup-import button:has-text("Add media from the folder")')
    page.wait_for_selector('.backup-import :text("matched 1 file")', timeout=15000)
    print('media ok')
    sd = DATA + '/whatsapp-backup/Media/WhatsApp Stickers'; os.makedirs(sd, exist_ok=True)
    open(sd + '/STK-20240301-WA0001.webp', 'wb').write(b'RIFF\x1a\x00\x00\x00WEBPVP8 ' + b'\x00' * 18)
    page.click('.backup-import button:has-text("Import stickers from the folder")')
    page.wait_for_selector('.backup-import :text("1 stickers found, 1 new")', timeout=8000)
    print('sticker import ok')
    # go to date
    to_chats(page)
    page.click(row('Jan Bakker')); page.wait_for_selector('.msg:has-text("Kijk eens")')
    page.click('button[aria-label="Chat options"]'); page.click('.head-menu button:has-text("Go to date")')
    page.wait_for_selector('input[aria-label="Go to date"]')
    assert 'History here goes back to' in page.inner_text('aside.panel')
    page.fill('input[aria-label="Go to date"]', '2024-03-01')
    page.wait_for_selector('.msg:has-text("Heel oud bericht")', timeout=8000)
    until(lambda: page.evaluate("(() => { const el = [...document.querySelectorAll('.msg')].find(m => m.textContent.includes('Heel oud bericht')); const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()"), 5, 'not scrolled to')
    page.fill('input[aria-label="Go to date"]', '2025-06-01')
    page.wait_for_selector('aside.panel :text("No messages that day; showing")', timeout=5000)
    print('go to date ok')
    page.screenshot(path=S + '/e2e22.png', full_page=True)
    b.close()
print('ERRORS:', errors)
