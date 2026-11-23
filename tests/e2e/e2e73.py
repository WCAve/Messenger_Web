"""WhatsApp link previews on GOWS: with a picture we send our own preview; without one the text goes with
WhatsApp's own preview (GOWS crashes on a preview without a picture); if our own preview fails anyway,
the message still goes, as text."""
# server-env: MOCK_WA_ENGINE=GOWS
import os, sys, time, json, ssl, threading, urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')
PNG = open(f'{FIX}/photo.png', 'rb').read()
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path in ('/withpic', '/nopic'):
            img = '<meta property="og:image" content="/pic.png">' if self.path == '/withpic' else ''
            body = f'<!doctype html><html><head><meta charset="utf-8"><meta property="og:title" content="Gamepad {self.path[1:]}"><meta name="description" content="A controller.">{img}</head><body>hi</body></html>'.encode()
            self.send_response(200); self.send_header('content-type', 'text/html; charset=utf-8'); self.end_headers(); self.wfile.write(body)
        elif self.path == '/pic.png':
            self.send_response(200); self.send_header('content-type', 'image/png'); self.end_headers(); self.wfile.write(PNG)
        else:
            self.send_response(404); self.end_headers()
httpd = HTTPServer(('127.0.0.1', 8443), H)
if not os.path.exists(f'{S}/cert.pem'):
    import subprocess
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=localhost', '-keyout', f'{S}/key.pem', '-out', f'{S}/cert.pem'], check=True, capture_output=True)
c = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); c.load_cert_chain(f'{S}/cert.pem', f'{S}/key.pem'); httpd.socket = c.wrap_socket(httpd.socket, server_side=True)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
def wa(path, data=None):
    r = urllib.request.Request('http://127.0.0.1:8090' + path, data=json.dumps(data).encode() if data is not None else None, headers={'content-type': 'application/json'}, method='POST' if data is not None else 'GET')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
def until(fn, what, secs=10):
    end = time.time() + secs
    while time.time() < end:
        v = fn()
        if v: return v
        time.sleep(0.25)
    raise AssertionError('timed out: ' + what)
def send(page, text):
    page.click('textarea'); page.keyboard.type(text); page.wait_for_selector('.compose-preview', timeout=8000)
    page.keyboard.press('Enter')
    try: page.wait_for_selector(f'.msg.out:has-text("{text.split()[0]}") .tick, .msg.out:has-text("{text.split()[0]}") time', timeout=10000)
    except Exception:
        page.screenshot(path=S + '/e2e73-fail.png'); print('SENT', [x['path'] for x in wa('/mock/sent')][-5:]); raise
    time.sleep(0.5)
    assert page.locator(f'.msg.out:has-text("{text.split()[0]}") :text("Not sent")').count() == 0, 'Not sent'
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1300, 'height': 900}); page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row-wrap:has(.chat-title:text-is("Jan Bakker"))', timeout=20000); time.sleep(3)
    page.click('.chat-row-wrap:has(.chat-title:text-is("Jan Bakker"))'); page.wait_for_selector('.msg')

    send(page, 'Eerste https://127.0.0.1:8443/withpic')
    custom = [x for x in wa('/mock/sent') if x['path'] == '/api/send/link-custom-preview']
    assert len(custom) == 1 and custom[0]['preview'].get('image') and not custom[0].get('crashed'), custom
    print('with a picture: our own preview ok')

    send(page, 'Tweede https://127.0.0.1:8443/nopic')
    assert len([x for x in wa('/mock/sent') if x['path'] == '/api/send/link-custom-preview']) == 1, 'tried our own preview without a picture'
    t = until(lambda: [x for x in wa('/mock/sent') if x['path'] == '/api/sendText' and 'Tweede' in x.get('text', '')], 'sent as text')
    assert t[-1].get('linkPreview') is True, t[-1]
    print('without a picture: as text with WhatsApp\'s preview ok')

    wa('/mock/config', {'previewCrash': True})
    send(page, 'Derde https://127.0.0.1:8443/withpic')
    t = until(lambda: [x for x in wa('/mock/sent') if x['path'] == '/api/sendText' and 'Derde' in x.get('text', '')], 'fallback as text')
    assert t[-1].get('linkPreview') is True
    assert [x for x in wa('/mock/sent') if x['path'] == '/api/send/link-custom-preview' and x.get('crashed')], 'no crash happened'
    print('our own preview failing: still sent ok')
    assert not errors, errors
    b.close()
print('e2e73 ok')
