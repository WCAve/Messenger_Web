"""Audio files (a recording, .m4a/.mp3) to WhatsApp go as a voice message (WAHA converts it), so they play
in the chat; a caption follows as text. If WAHA can't, it goes as a file like before."""
import sys, time, json, os, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def wa(path, data=None):
    r = urllib.request.Request('http://127.0.0.1:8090' + path, data=json.dumps(data).encode() if data is not None else None, headers={'content-type': 'application/json'}, method='POST' if data is not None else 'GET')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
m4a = os.path.join(S, 'Opname 13 nov.m4a')
with open(m4a, 'wb') as f: f.write(b'\x00\x00\x00\x20ftypM4A \x00\x00\x00\x00M4A mp42isom' + bytes(2000))
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 900})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Familie'), timeout=20000); time.sleep(6)
    page.click(row('Familie')); page.wait_for_selector('.msg')
    def send(caption):
        page.set_input_files('input[type=file][multiple]', m4a); page.click('textarea'); page.keyboard.type(caption); page.keyboard.press('Enter')
        for _ in range(60):
            calls = [x for x in wa('/mock/sent') if x['path'] in ('/api/sendVoice', '/api/sendFile') and 'audio' in str(x.get('file', {}).get('mimetype'))]
            if len(calls) > send.n: send.n = len(calls); return calls[-1]
            time.sleep(0.25)
        raise AssertionError('nothing sent')
    send.n = 0
    v = send('Luister even')
    print('sent as:', v['path'], v.get('file', {}).get('mimetype'), 'convert:', v.get('convert'))
    assert v['path'] == '/api/sendVoice' and v.get('convert') is True
    time.sleep(1)
    assert any(x['path'] == '/api/sendText' and x.get('text') == 'Luister even' for x in wa('/mock/sent')), 'caption not sent'
    # WAHA can't convert: as a file, like before
    wa('/mock/config', {'noVoice': True})
    f = send('Nog eentje')
    print('fallback:', f['path'], f.get('caption'))
    assert f['path'] == '/api/sendFile' and f.get('caption') == 'Nog eentje'
    page.wait_for_selector('.msg.out:has-text("Nog eentje")'); time.sleep(1.5)
    assert page.locator('.msg.out:has-text("Nog eentje") .failed-note').count() == 0
    print('audio ok')
    b.close()
print('ERRORS:', errors)
