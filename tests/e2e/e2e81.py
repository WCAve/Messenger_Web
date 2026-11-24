"""Picture search for stickers: choosing and downloading a model in Settings → Stickers (checked; a bad
download is refused), the stickers looked at in the background, "Looks like" results in the picker, and
removing the model. A local server stands in for Hugging Face; a stand-in engine (STICKER_CLIP=fake)
for the model (the real one is tested in the Docker image)."""
# server-env: STICKER_OCR=fake STICKER_CLIP=fake STICKER_OCR_DELAY_MS=500 STICKER_OCR_PAUSE_MS=0 MODELS_BASE_URL=http://127.0.0.1:8447 MODELS_TEST={"id":"test-tiny","label":"Test","description":"Tiny","files":[{"role":"vision","repo":"test/model","path":"tiny/vision.onnx","size":20000,"sha256":"7d48531218c8bf40381f8447547d90daa825e4b50385eb4a4cf330896d9b5f35"},{"role":"text","repo":"test/model","path":"tiny/text.onnx","size":20000,"sha256":"80d32adb474ab8a7e6f57462f17d0e693c785ae944fc8fce201dba0db8185cf3"},{"role":"dense","repo":"test/model","path":"tiny/dense.safetensors","size":100,"sha256":"407c28e1d51f887a034d378a1f30870486fdd987b7d2724a643bdd8d3e550304"},{"role":"tokenizer","repo":"test/model","path":"tiny/tokenizer.json","size":2,"sha256":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"}]}
import sys, time, json, base64, struct, zlib, threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
FILES = {'/test/model/resolve/main/tiny/vision.onnx': b'V' * 20000, '/test/model/resolve/main/tiny/text.onnx': b'T' * 20000,
         '/test/model/resolve/main/tiny/dense.safetensors': b'D' * 100, '/test/model/resolve/main/tiny/tokenizer.json': b'{}'}
corrupt = {'on': True}
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        body = FILES.get(self.path)
        if body is None: self.send_response(404); self.end_headers(); return
        if corrupt['on'] and self.path.endswith('text.onnx'): body = b'X' * len(body)
        self.send_response(200); self.send_header('content-length', str(len(body))); self.end_headers(); self.wfile.write(body)
threading.Thread(target=HTTPServer(('127.0.0.1', 8447), H).serve_forever, daemon=True).start()
def png(n, tags=None, text=None):
    raw = b'\x00' + bytes([n % 256, 40, 99])
    c = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    b = b'\x89PNG\r\n\x1a\n' + c(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) + c(b'IDAT', zlib.compress(raw)) + c(b'IEND', b'')
    return b + (b'CLIPTAGS:' + tags.encode() + b'\x00' if tags else b'') + (b'OCRTEXT:' + text.encode() + b'\x00' if text else b'')
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
def until(fn, what, secs=20):
    end = time.time() + secs
    while time.time() < end:
        v = fn()
        if v: return v
        time.sleep(0.3)
    raise AssertionError('timed out: ' + what)
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1300, 'height': 900}); page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Jan Bakker'), timeout=20000); time.sleep(1)
    api = lambda method, path, body=None: page.evaluate("([m, p, b]) => fetch(p, {method: m, headers: {'content-type': 'application/json'}, body: b ? JSON.stringify(b) : undefined}).then(r => r.json())", [method, path, body])
    stickers = [png(1, 'kat,dier'), png(2, 'hond,dier'), png(3, 'auto'), png(4, None, 'Nee joh')]
    api('POST', '/api/stickers/images', {'images': ['data:image/png;base64,' + base64.b64encode(x).decode() for x in stickers]})

    # Settings → Stickers
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Settings")')
    page.click('.settings-nav-row:has(strong:text-is("Stickers"))')
    page.wait_for_selector('.model-choice:has-text("Compact")'); page.wait_for_selector('.model-choice:has-text("Full quality")')
    sizes = page.locator('.model-choice strong').all_inner_texts(); print('choices:', sizes)
    assert any('228 MB' in t for t in sizes) and any('894 MB' in t for t in sizes), sizes
    page.click('.model-choice:has-text("Test")')
    page.click('.model-actions button:has-text("Download")')
    page.wait_for_selector('.form-error:has-text("checksum doesn")', timeout=15000); print('bad download refused ok')
    corrupt['on'] = False
    page.click('.model-actions button:has-text("Download")')
    page.wait_for_selector('.setting-note:has-text("Installed: Test")', timeout=15000)
    page.wait_for_selector('.setting-note:has-text("All stickers looked at")', timeout=20000)
    page.screenshot(path=S + '/e2e81-settings.png'); print('downloaded and looked at ok')
    page.click('button[aria-label="Back to settings"]'); page.click('button[aria-label="Back to chats"]')

    # The picker: "Looks like"
    page.click(row('Jan Bakker')); page.wait_for_selector('.msg')
    page.click('.composer button[aria-label=Stickers]')
    box = page.locator('input[aria-label="Search stickers"]')
    box.fill('kat'); page.wait_for_selector('.picker-body h4:has-text("Looks like")')
    n = page.locator('.picker-body .sticker-cell').count(); print('kat:', n); assert n == 1, n
    box.fill('dier'); until(lambda: page.locator('.picker-body .sticker-cell').count() == 2, 'two animals')
    box.fill('nee joh'); page.wait_for_selector('.picker-body .sticker-cell[title="Nee joh"]')
    page.screenshot(path=S + '/e2e81-picker.png')
    box.fill('kat'); page.wait_for_selector('.picker-body h4:has-text("Looks like")')
    page.locator('.picker-body .sticker-cell').first.click()
    until(lambda: [x for x in json.loads(__import__('urllib.request').request.urlopen('http://127.0.0.1:8090/mock/sent').read()) if x['path'] == '/api/sendSticker'], 'sent')
    print('looks like ok')

    # Remove: the tip comes back
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Settings")')
    page.click('.settings-nav-row:has(strong:text-is("Stickers"))')
    page.once('dialog', lambda d: d.accept()); page.click('.model-actions button:has-text("Remove")')
    until(lambda: not page.locator('.setting-note:has-text("Installed")').count(), 'removed')
    r = api('GET', '/api/stickers/search?q=kat'); assert r['pictures'] == [] and r['reading']['pictures'] is None, r
    print('removed ok')
    assert not errors, errors
    b.close()
print('e2e81 ok')
