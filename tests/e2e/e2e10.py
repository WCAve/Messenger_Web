"""Link previews, polls and votes, forwarding, drafts, pin/mute/archive, the unread divider."""
import os, sys, time, json, ssl, threading, urllib.request, base64
from http.server import HTTPServer, BaseHTTPRequestHandler
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')  # test files kept in the repo
PNG = open(f'{FIX}/photo.png', 'rb').read()
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.startswith('/article'):
            body = b'''<!doctype html><html><head><meta charset="utf-8"><title>fallback</title>
<meta property="og:title" content="Rain all weekend &amp; what to do about it">
<meta content="A short guide to staying dry at the market." name="description">
<meta property="og:image" content="/pic.png"></head><body>hi</body></html>'''
            self.send_response(200); self.send_header('content-type', 'text/html; charset=utf-8'); self.end_headers(); self.wfile.write(body)
        elif self.path == '/pic.png':
            self.send_response(200); self.send_header('content-type', 'image/png'); self.end_headers(); self.wfile.write(PNG)
        elif self.path == '/moved':
            self.send_response(302); self.send_header('location', '/article?x=1'); self.end_headers()
        else:
            self.send_response(404); self.end_headers()
httpd = HTTPServer(('127.0.0.1', 8443), H)
if not os.path.exists(f'{S}/cert.pem'):  # a throwaway certificate for the local https page
    import subprocess
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=localhost',
                    '-keyout', f'{S}/key.pem', '-out', f'{S}/cert.pem'], check=True, capture_output=True)
c = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); c.load_cert_chain(f'{S}/cert.pem', f'{S}/key.pem'); httpd.socket = c.wrap_socket(httpd.socket, server_side=True)
threading.Thread(target=httpd.serve_forever, daemon=True).start()

def mock(path, data=None):
    req = urllib.request.Request('http://127.0.0.1:8080' + path, data=json.dumps(data).encode() if data is not None else None, headers={'content-type': 'application/json'}, method='POST' if data is not None else 'GET')
    return json.loads(urllib.request.urlopen(req).read() or b'null')
def sends(): return [x for x in mock('/mock/sent') if 'recipients' in x]
def wait(cond, t=10, msg='timeout'):
    end = time.time() + t
    while time.time() < end:
        v = cond()
        if v: return v
        time.sleep(0.2)
    raise AssertionError(msg)
shot = lambda page, n: page.screenshot(path=f'{S}/shots10/{n}.png')
def row_menu(page, title, item):
    page.hover(f'.chat-row-wrap:has(.chat-title:text-is("{title}"))')
    page.click(f'.chat-row-wrap:has(.chat-title:text-is("{title}")) .row-menu-btn')
    page.click(f'.row-menu button:has-text("{item}")')

with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 1500, 'height': 950}); page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row')

    # 1. link preview when sending
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg')
    page.click('textarea'); page.keyboard.type('Read this https://127.0.0.1:8443/moved')
    page.wait_for_selector('.compose-preview', timeout=8000)
    assert 'Rain all weekend & what to do' in page.inner_text('.compose-preview'), page.inner_text('.compose-preview')
    shot(page, '01-compose-preview')
    page.keyboard.press('Enter')
    s = wait(lambda: [x for x in sends() if 'moved' in x['message']])[-1]
    lp = s.get('link_preview'); print('link_preview:', {k: (v[:40] if isinstance(v, str) else v) for k, v in (lp or {}).items()})
    assert lp and lp['url'] == 'https://127.0.0.1:8443/moved' and lp['title'].startswith('Rain') and lp['base64_thumbnail'].startswith('data:image/png;base64,'), lp
    page.wait_for_selector('.msg.out .link-preview img'); shot(page, '02-sent-preview')
    # dismissed → no preview
    page.click('textarea'); page.keyboard.type('again https://127.0.0.1:8443/article')
    page.wait_for_selector('.compose-preview'); page.click('button[aria-label="Send without link preview"]')
    page.keyboard.press('Enter')
    s = wait(lambda: [x for x in sends() if 'again' in x['message']])[-1]
    assert not s.get('link_preview'), s
    print('link previews ok')

    # 1b. WhatsApp on the WEBJS engine can't send our own preview: the message goes as text and
    # WhatsApp makes the preview; after that we don't try our own again
    def wa(path, data=None):
        r = urllib.request.Request('http://127.0.0.1:8090' + path, data=json.dumps(data).encode() if data is not None else None, headers={'content-type': 'application/json'}, method='POST' if data is not None else 'GET')
        return json.loads(urllib.request.urlopen(r).read() or b'null')
    wa('/mock/config', {'webjs': True})
    page.click('.chat-row-wrap:has(.chat-title:text-is("Jan Bakker"))'); page.wait_for_selector('.msg')
    for n in (1, 2):
        page.click('textarea'); page.keyboard.type(f'Kijk {n} https://127.0.0.1:8443/moved'); page.wait_for_selector('.compose-preview', timeout=8000)
        page.keyboard.press('Enter')
        sent = wait(lambda: [x for x in wa('/mock/sent') if x['path'] == '/api/sendText' and f'Kijk {n}' in str(x.get('text'))])
        assert sent[-1].get('linkPreview') is True, sent[-1]
        page.wait_for_selector(f'.msg.out:has-text("Kijk {n}") .tick, .msg.out:has-text("Kijk {n}") time')
        assert page.locator(f'.msg.out:has-text("Kijk {n}") .msg-error, .msg.out:has-text("Kijk {n}") :text("Not sent")').count() == 0
    custom = [x for x in wa('/mock/sent') if x['path'] == '/api/send/link-custom-preview']
    print('custom preview tries:', len(custom)); assert len(custom) == 1, custom
    wa('/mock/config', {'webjs': False})
    print('whatsapp webjs preview fallback ok')

    # 2. polls
    page.click('.chat-row:has-text("Weekend")'); page.wait_for_selector('.poll')
    poll = page.locator('.poll').first
    assert 'Where do we meet?' in poll.inner_text()
    assert poll.locator('.poll-option:has-text("Café Noord") .poll-count').inner_text() == '1'
    poll.locator('.poll-option:has-text("Market")').click()
    v = wait(lambda: [x for x in mock('/mock/sent') if x.get('path', '').endswith('/vote')])[-1]
    print('vote:', v); assert v['selected_answers'] == [1] and v['poll_author'] == '+31622222222', v
    wait(lambda: poll.locator('.poll-option.mine:has-text("Market")').count() == 1)
    shot(page, '03-poll-voted')
    page.click('button[aria-label="New poll"]'); page.wait_for_selector('.dialog')
    page.fill('.dialog input[placeholder="Ask a question"]', 'Pizza or pasta?')
    page.fill('.dialog input[aria-label="Option 1"]', 'Pizza'); page.fill('.dialog input[aria-label="Option 2"]', 'Pasta'); page.fill('.dialog input[aria-label="Option 3"]', 'Both')
    page.click('.dialog .switch'); shot(page, '04-poll-dialog')
    page.click('.dialog button:has-text("Send poll")')
    cp = wait(lambda: [x for x in mock('/mock/sent') if x.get('path', '').startswith('/v1/polls/') and x.get('question')])[-1]
    assert cp['answers'] == ['Pizza', 'Pasta', 'Both'] and cp['allow_multiple_selections'] is True, cp
    mine = page.locator('.msg.out .poll:has-text("Pizza or pasta?")')
    wait(lambda: mine.locator('.poll-option:has-text("Pasta") .poll-count').inner_text() == '1', msg='carol vote not shown')
    page.on('dialog', lambda d: d.accept())
    mine.locator('button:has-text("End poll")').click()
    wait(lambda: 'Poll ended' in mine.inner_text())
    assert [x for x in mock('/mock/sent') if x.get('method') == 'DELETE' and x.get('path', '').startswith('/v1/polls/')]
    shot(page, '05-poll-ended')
    print('polls ok')

    # 3. forward
    page.click('.chat-row:has-text("Carol")'); page.wait_for_selector('.link-preview')
    m = page.locator('.msg:has(.link-preview)').first; m.hover(); m.locator('button[aria-label=Forward]').click()
    page.wait_for_selector('.dialog'); page.click('.forward-row:has-text("Alice")'); page.click('.forward-row:has-text("Weekend")')
    shot(page, '06-forward'); page.click('.dialog button:has-text("Forward")')
    fw = wait(lambda: [x for x in sends() if 'trail-guide' in x['message']] if len([x for x in sends() if 'trail-guide' in x['message']]) >= 2 else None)
    assert len(fw) == 2 and all(x.get('link_preview') for x in fw), fw
    print('forward ok')

    time.sleep(6)  # let the mock's typing indicators from the forwards pass
    # 4. drafts
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg'); page.click('textarea'); page.keyboard.type('half-written thought')
    page.click('.chat-row:has-text("Carol")'); time.sleep(0.5)
    assert 'Draft: half-written thought' in ' '.join(page.inner_text('.chat-row-wrap:has-text("Alice")').split())
    page.reload(); page.wait_for_selector('.chat-row')
    assert 'Draft: half-written thought' in ' '.join(page.inner_text('.chat-row-wrap:has-text("Alice")').split()), 'draft lost on reload'
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('textarea')
    assert page.input_value('textarea') == 'half-written thought'
    page.fill('textarea', ''); print('drafts ok')

    # 5. pin, mute, archive
    row_menu(page, 'Carol', 'Pin chat'); time.sleep(0.5)
    assert page.locator('.chat-row-wrap .chat-title').first.inner_text() == 'Carol', page.locator('.chat-row-wrap .chat-title').first.inner_text()
    assert page.locator('.chat-row-wrap:has-text("Carol") svg title:text("Pinned")').count() == 1 or page.locator('.chat-row-wrap:has-text("Carol") .row-icons svg').count() == 1
    row_menu(page, 'Weekend plans', 'Mute notifications'); page.click('.row-menu button:has-text("For 8 hours")'); time.sleep(0.4)
    assert page.locator('.chat-row.muted:has-text("Weekend")').count() == 1
    shot(page, '07-pinned-muted')
    row_menu(page, 'Carol', 'Archive chat'); page.wait_for_selector('.archived-row')
    assert page.locator('.chat-row-wrap:has(.chat-title:text-is("Carol"))').count() == 0
    row_menu(page, 'Weekend plans', 'Archive chat'); time.sleep(0.4)
    page.click('.archived-row'); page.wait_for_selector('.sidebar h2:has-text("Archived")'); shot(page, '08-archived')
    page.click('.side-head button[aria-label="Back to chats"]')
    mock('/mock/incoming', {'from': 'carol', 'text': 'back from the archive'})
    mock('/mock/incoming', {'from': 'bob', 'group': True, 'text': 'muted chat stays archived'})
    time.sleep(1.2)
    assert page.locator('.chat-row-wrap:has(.chat-title:text-is("Carol"))').count() == 1, 'Carol should be unarchived'
    assert page.locator('.chat-row-wrap:has(.chat-title:text-is("Weekend plans"))').count() == 0, 'muted Weekend should stay archived'
    # the same actions from the chat header's menu
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg')
    page.click('button[aria-label="Chat options"]'); page.click('.head-menu button:has-text("Pin chat")'); time.sleep(0.4)
    assert page.locator('.chat-row-wrap:has-text("Alice") .row-icons svg').count() >= 1, 'header pin failed'
    shot(page, '07b-head-menu')
    print('pin/mute/archive ok')

    # 6. unread divider
    for i in range(3): mock('/mock/incoming', {'from': 'bob', 'text': f'unread number {i}'})
    page.wait_for_selector('.chat-row:has-text("Bob") .badge:text-is("3")')
    page.click('.chat-row:has-text("Bob")'); page.wait_for_selector('.unread-divider')
    assert page.inner_text('.unread-divider') == '3 unread messages', page.inner_text('.unread-divider')
    shot(page, '09-divider'); print('divider ok')
    b.close()
httpd.shutdown()
print('ERRORS:', errors)
