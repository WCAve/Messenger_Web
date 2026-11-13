"""Files made sendable: a huge BMP is made smaller in the browser (the message box says so; the original can
be sent as a file instead); a TIFF photo and an AVI video are converted on the server (JPEG, MP4/H.264)."""
import sys, time, json, os, struct, subprocess, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def get(port, path):
    return json.loads(urllib.request.urlopen(f'http://127.0.0.1:{port}{path}').read() or b'null')
# A 3000x2000 BMP (18 MB): a colour gradient
W, H = 3000, 2000
bmp = os.path.join(S, 'Groot.bmp')
with open(bmp, 'wb') as f:
    rowsize = (W * 3 + 3) & ~3
    f.write(b'BM' + struct.pack('<IHHI', 54 + rowsize * H, 0, 0, 54) + struct.pack('<IiiHHIIiiII', 40, W, H, 1, 24, 0, rowsize * H, 2835, 2835, 0, 0))
    line = bytearray()
    for x in range(W): line += bytes((x * 255 // W, 120, 255 - x * 255 // W))
    line += bytes(rowsize - W * 3)
    for y in range(H): f.write(line)
tiff = os.path.join(S, 'Scan.tiff'); avi = os.path.join(S, 'Filmpje.avi')
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=800x600', '-frames:v', '1', tiff], check=True)
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=10', '-c:v', 'mpeg4', avi], check=True)
row_ = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 900})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row:has-text("Alice")', timeout=20000); time.sleep(5)
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg')

    def signal_sent(n):
        for _ in range(60):
            s = [x for x in get(8080, '/mock/sent') if x.get('base64_attachments')]
            if len(s) >= n: return s[n - 1]
            time.sleep(0.25)
        raise AssertionError('not sent')

    # 1. Huge BMP: made smaller in the browser
    page.set_input_files('input[type=file][multiple]', bmp)
    page.wait_for_selector('.shrink-note:has-text("Made smaller")', timeout=20000)
    note = page.locator('.shrink-note').inner_text(); print('note:', note.replace('\n', ' | '))
    page.locator('.pending-files').screenshot(path=S + '/e2e58-note.png')
    page.click('textarea'); page.keyboard.press('Enter')
    a = signal_sent(1)['base64_attachments'][0]; print('sent:', a[:70])
    assert a.startswith('data:image/jpeg;filename=Groot.jpg;base64,')
    # 2. The same, but the original as a file
    page.set_input_files('input[type=file][multiple]', bmp)
    page.wait_for_selector('.shrink-note button:has-text("Send the original as a file")', timeout=20000)
    page.click('.shrink-note button:has-text("Send the original as a file")')
    assert 'Original, as a file' in page.locator('.shrink-note').inner_text()
    page.click('textarea'); page.keyboard.press('Enter')
    a = signal_sent(2)['base64_attachments'][0]; print('sent original:', a[:70])
    assert a.startswith('data:application/octet-stream;filename=Groot.bmp;base64,')
    print('browser shrinking ok')

    # 3. TIFF and AVI to WhatsApp: converted on the server
    page.click(row_('Jan Bakker')); page.wait_for_selector('.msg')
    page.set_input_files('input[type=file][multiple]', [tiff, avi]); time.sleep(0.5)
    page.click('textarea'); page.keyboard.type('Scan en filmpje'); page.keyboard.press('Enter')
    for _ in range(80):
        sent = [x for x in get(8090, '/mock/sent') if x['path'] in ('/api/sendImage', '/api/sendVideo', '/api/sendFile')]
        if len(sent) >= 2: break
        time.sleep(0.25)
    for x in sent[-2:]: print('whatsapp:', x['path'], x['file'].get('mimetype'), x['file'].get('filename'))
    assert [(x['path'], x['file']['mimetype'], x['file']['filename']) for x in sent[-2:]] == [('/api/sendImage', 'image/jpeg', 'Scan.jpg'), ('/api/sendVideo', 'video/mp4', 'Filmpje.mp4')]
    # and the chat shows the converted files
    page.wait_for_selector('.msg.out:has-text("Scan en filmpje") video', timeout=10000)
    print('server converting ok')
    b.close()
print('ERRORS:', errors)
