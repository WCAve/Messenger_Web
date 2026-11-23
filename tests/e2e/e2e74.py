"""Signal: a reply whose quote comes without text (and the quoted message has no attachment) shows the
quoted message's own text, not "Attachment"."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def post(path, data):
    r = urllib.request.Request('http://127.0.0.1:8080' + path, data=json.dumps(data).encode(), headers={'Content-Type': 'application/json'}, method='POST')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
BOB = '+31622222222'
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1300, 'height': 900}); page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row:has-text("Weekend plans")', timeout=20000); time.sleep(2)
    page.click('.chat-row:has-text("Weekend plans")'); page.wait_for_selector('.msg')
    ts = int(post('/mock/incoming', {'from': 'bob', 'group': True, 'text': 'Mede ook die posts met fotos'})['timestamp'])
    page.wait_for_selector('.msg:has-text("Mede ook die posts")')
    for text in (None, ''):
        post('/mock/incoming', {'from': 'carol', 'group': True, 'text': f'Antwoord {text!r}', 'extra': {'quote': {'id': ts, 'author': BOB, 'authorNumber': BOB, 'text': text, 'attachments': []}}})
        q = page.locator(f'.msg:has-text("Antwoord {text!r}") .quote')
        q.wait_for(); time.sleep(0.3)
        print('quote shows:', q.inner_text().replace('\n', ' | '))
        assert 'Mede ook die posts met fotos' in q.inner_text() and 'Attachment' not in q.inner_text()
    assert not errors, errors
    b.close()
print('e2e74 ok')
