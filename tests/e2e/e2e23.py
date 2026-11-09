"""Replies to old messages: linked when WhatsApp Web has the original, otherwise quoted as text; ids spelled two ways."""
import sys, time, json, os, subprocess, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
MW = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
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
backup = os.path.join(S, 'msgstore23.db.crypt15')
sends = lambda: [s for s in wa('/mock/sent') if s['path'] == '/api/sendText']

with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 1000})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Familie'), timeout=20000); time.sleep(8)
    subprocess.run(['node', '--no-warnings', MW + '/mock/make-backup.mjs', backup, KEY, '{}'], check=True, capture_output=True)
    cookies = '; '.join(f"{c['name']}={c['value']}" for c in page.context.cookies())
    def api(path, data=None, raw=None, headers=None):
        h = {'cookie': cookies, **(headers or {})}
        if data is not None: h['content-type'] = 'application/json'
        r = urllib.request.Request('http://localhost:3000' + path, data=raw if raw is not None else json.dumps(data).encode() if data is not None else None, headers=h, method='POST' if (data is not None or raw is not None) else 'GET')
        return json.loads(urllib.request.urlopen(r).read() or b'null')
    api('/api/whatsapp/backup/upload', raw=open(backup, 'rb').read(), headers={'content-type': 'application/octet-stream', 'x-messenger-upload': '1', 'x-file-name': 'msgstore.db.crypt15'})
    api('/api/whatsapp/backup/import', {'key': KEY})
    until(lambda: (api('/api/whatsapp').get('backup') or {}).get('stage') == 'done', 20, 'import not done')
    # WhatsApp Web knows Kees's old message by his privacy id
    wa('/mock/history', {'chat': '77777777777777@lid', 'id': 'false_77777777777777@lid_OLDKEES00001', 'body': 'Hallo van Kees'})
    print('setup ok')

    def reply(text_of, answer):
        m = page.locator(f'.msg:has(.body:has-text("{text_of}"))').first
        m.hover(); m.locator('button[aria-label="Reply"]').click()
        page.wait_for_selector('.reply-preview')
        time.sleep(1.2)
        note = page.locator('.reply-note').count() == 1
        page.fill('textarea', answer); page.keyboard.press('Enter')
        until(lambda: any(answer in (s.get('text') or '') for s in sends()), 10, 'not sent')
        return note, [s for s in sends() if answer in (s.get('text') or '')][-1]

    # 1. an old message WhatsApp Web doesn't have: quoted as text
    page.click(row('Jan Bakker')); page.wait_for_selector('.msg:has-text("Kijk eens")')
    page.click('button[aria-label="Chat options"]'); page.click('.head-menu button:has-text("Go to date")')
    page.fill('input[aria-label="Go to date"]', '2024-03-01'); page.wait_for_selector('.msg:has-text("Heel oud bericht")')
    page.click('aside.panel button[aria-label="Close"]') if page.locator('aside.panel button[aria-label="Close"]').count() else None
    note, sent = reply('Heel oud bericht', 'antwoord op oud')
    print('old:', note, repr(sent['text'][:60]), sent.get('reply_to'))
    assert note, 'no warning in the reply bar'
    assert sent['text'].startswith('> *Jan Bakker:* Heel oud bericht\n\nantwoord op oud'), sent['text']
    assert not sent.get('reply_to'), sent
    page.wait_for_selector('.msg.out:has-text("antwoord op oud") .quote :text("quoted as text")', timeout=5000)
    print('text quote ok')

    # 2. a message WhatsApp Web has: a real reply
    page.click(row('Familie')); page.click(row('Jan Bakker')); page.wait_for_selector('.msg:has-text("Kijk eens")')
    note, sent = reply('Kijk eens', 'mooie foto')
    kijk = [m for m in wa('/api/default/chats/31655500001%40c.us/messages?limit=50&x-api-key=test-waha-key') if m['body'] == 'Kijk eens'][0]
    assert not note and sent.get('reply_to') == kijk['id'] and not sent['text'].startswith('>'), sent
    print('linked reply ok')

    # 3. known to WhatsApp Web by the other spelling of the id (privacy id instead of number)
    page.click(row('+31 6 55500077') if page.locator(row('+31 6 55500077')).count() else '.chat-row:has-text("Hallo van Kees")')
    page.wait_for_selector('.msg:has-text("Hallo van Kees")')
    note, sent = reply('Hallo van Kees', 'hoi Kees')
    assert sent.get('reply_to') == 'false_77777777777777@lid_OLDKEES00001' and not note, sent
    print('other id spelling ok')
    b.close()
print('ERRORS:', errors)
