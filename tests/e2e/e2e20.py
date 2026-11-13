"""Files in imported history: fetched when opened, "missing" placeholders, background download, quotes by raw id."""
import sys, time, json, urllib.request, os
MW = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
DATA = os.environ.get('E2E_DATA') or os.path.join(MW, '.data')  # the app's data folder for this test run
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
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
fetches = lambda: wa('/mock/stats')['singleFetches']

with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 900})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Familie'), timeout=20000); time.sleep(9)

    # 1. the import fetched no files
    assert fetches() == 0, f'import downloaded {fetches()} files'
    assert page.locator('.chat-title:text-is("0"), .chat-title:text-is("+0")').count() == 0, 'system chat imported'
    print('import without files ok')

    # 2. files load when looked at
    page.click(row('Jan Bakker')); page.wait_for_selector('.msg:has-text("Kijk eens")')
    until(lambda: page.evaluate("[...document.querySelectorAll('.msg img')].some(i => i.complete && i.naturalWidth > 0)"), 10, 'image not loaded on view')
    assert fetches() >= 1
    print('photo on view ok, fetches:', fetches())
    page.click(row('Privé Pieter')); page.wait_for_selector('.msg:has-text("Hallo via een privé-id")')
    # an old photo WhatsApp can't provide any more
    page.wait_for_selector('.msg:has-text("Oude foto") :text("Not available any more")', timeout=10000)
    # voice notes wait for a tap
    page.wait_for_selector('.file.pending-media:has-text("Voice message")')
    n = fetches()
    page.click('.file.pending-media:has-text("Voice message")')
    until(lambda: fetches() > n, 8, 'voice note not fetched on tap')
    print('missing + tap to load ok')
    # reopening: the missing one is remembered (no new request)
    page.click(row('Jan Bakker')); time.sleep(0.5); n = fetches()
    page.click(row('Privé Pieter')); page.wait_for_selector('.msg:has-text("Oude foto") .file.missing'); time.sleep(1)
    assert fetches() == n, 'asked again for a missing file'
    print('missing remembered ok')

    # 3. background download of the rest (setting)
    cookies = '; '.join(f"{c['name']}={c['value']}" for c in page.context.cookies())
    def api(path, data):
        r = urllib.request.Request('http://localhost:3000' + path, data=json.dumps(data).encode(), headers={'content-type': 'application/json', 'cookie': cookies, 'origin': 'http://localhost:3000'}, method='POST')
        return json.loads(urllib.request.urlopen(r).read())
    # Familie's photo was never looked at: the background download fetches it
    n = fetches()
    st = api('/api/settings', {'waHistoryMedia': True})
    assert st['waHistoryMedia'] is True
    until(lambda: 'background download:' in open(os.environ.get('E2E_SERVER_LOG', S + '/server.log')).read(), 15, 'no background download')
    assert fetches() > n
    page.click(row('Familie')); page.wait_for_selector('.msg:has-text("Taartfoto")')
    assert page.locator('.msg:has-text("Taartfoto") .img-btn.pending').count() == 0, 'still pending after background download'
    print('background download ok')

    # 4. short ids: a quote that refers to a group message by its raw id only
    hist = wa('/api/default/chats/120363000000000001%40g.us/messages?limit=20&x-api-key=test-waha-key')
    target = [m for m in hist if 'taart' in m['body']][0]
    raw = target['id'].split('_')[2]
    wa('/mock/incoming', {'from': 'jan', 'group': True, 'text': 'ja ik!', 'extra': {'replyTo': {'id': raw, 'participant': '31655500002@c.us', 'body': 'x'}}})
    page.wait_for_selector('.msg:has-text("ja ik!") .quote:has-text("Wie neemt er taart mee?")', timeout=5000)
    print('raw-id quote ok')
    # a slow WhatsApp never holds a request open: pending files answer at once
    wa('/mock/config', {'mediaDelayMs': 20000})
    wa('/mock/incoming', {'from': 'jan', 'text': '', 'media': 'image/jpeg'})  # live: downloaded at once
    cookies = '; '.join(f"{c['name']}={c['value']}" for c in page.context.cookies())
    import sqlite3
    con = sqlite3.connect(os.path.join(DATA, 'signal-web.db')); con.execute("INSERT OR IGNORE INTO wa_media (id, chat, msg, message_id, ts, state) VALUES ('wa-slowtest.jpg', '31655500001@c.us', 'false_31655500001@c.us_SLOW', NULL, 1, 'pending')"); con.commit(); con.close()
    t0 = time.time()
    try:
        urllib.request.urlopen(urllib.request.Request('http://localhost:3000/api/attachments/wa-slowtest.jpg', headers={'cookie': cookies}))
    except urllib.error.HTTPError as e:
        assert e.code == 404
    assert time.time() - t0 < 2, f'pending file held the request for {time.time() - t0:.1f}s'
    wa('/mock/config', {'mediaDelayMs': 0})
    print('pending answers at once ok')
    page.screenshot(path=S + '/e2e20.png')
    b.close()
print('ERRORS:', errors)
