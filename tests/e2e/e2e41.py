"""Stepping through a chat's photos in the viewer: ← → keys and ‹ › buttons, oldest to newest, more loaded
as you go, GIFs left out, "N of M", closing jumps the chat to the photo you ended on, also from chat info."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
FIX = 'tests/e2e/fixtures'
def sig(path, data):
    r = urllib.request.Request('http://127.0.0.1:8080' + path, data=json.dumps(data).encode(), headers={'content-type': 'application/json'}, method='POST')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
now = int(time.time() * 1000)
N = 60
for k in range(N):  # older photos from Alice, oldest first
    sig('/mock/incoming', {'from': 'alice', 'text': '', 'ts': now - 50 * 3600_000 + k * 60_000,
                           'extra': {'attachments': [{'contentType': 'image/png', 'filename': f'stap-{k}.png', 'id': f'mockstep{k}.png', 'size': 100, 'width': 640, 'height': 420}]}})
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 1000})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row:has-text("Alice")', timeout=20000); time.sleep(2)
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.img-btn', timeout=15000)
    # a GIF, sent last: not part of the stepping
    page.set_input_files('input[type=file][multiple]', f'{FIX}/fake.gif'); page.click('textarea'); page.keyboard.press('Enter'); time.sleep(2)
    count = lambda: page.locator('.lightbox-count').inner_text()
    alt = lambda: page.locator('.lightbox img').get_attribute('alt')
    def wait_count(want):
        for _ in range(40):
            if page.locator('.lightbox-count').count() and count() == want: return
            time.sleep(0.1)
        raise AssertionError(f'count {count() if page.locator(".lightbox-count").count() else None} != {want}')
    page.click('.img-btn:has(img[alt="view.png"])')
    total = N + 1
    wait_count(f'{total} of {total}'); print('opened:', count(), alt())
    assert page.locator('.lightbox-nav.next').count() == 0 and page.locator('.lightbox-nav.prev').count() == 1
    page.keyboard.press('ArrowRight'); time.sleep(0.3); assert count() == f'{total} of {total}'  # the GIF isn't one of them
    page.keyboard.press('ArrowLeft'); wait_count(f'{total - 1} of {total}'); assert alt() == f'stap-{N - 1}.png', alt()
    page.screenshot(path=S + '/e2e41.png')
    for _ in range(44):  # past the first loaded stretch
        page.keyboard.press('ArrowLeft'); time.sleep(0.06)
    wait_count(f'16 of {total}'); assert alt() == 'stap-15.png', alt()
    page.click('.lightbox-nav.prev'); wait_count(f'15 of {total}'); assert alt() == 'stap-14.png', alt()
    page.keyboard.press('ArrowRight'); page.keyboard.press('ArrowLeft'); wait_count(f'15 of {total}')
    print('stepping ok')
    # Closing jumps the chat to that photo
    page.keyboard.press('Escape'); time.sleep(1.5)
    assert page.locator('.lightbox').count() == 0
    box = page.locator('.img-btn:has(img[alt="stap-14.png"])').bounding_box()
    print('jumped to:', box)
    assert box and 0 < box['y'] < 1000, box
    # From chat info's media list
    page.click('.chat-head-main'); page.wait_for_selector('.media-grid button', timeout=10000)
    page.click('.media-grid button[aria-label="Open view.png"]')
    wait_count(f'{total} of {total}')
    page.keyboard.press('ArrowLeft'); wait_count(f'{total - 1} of {total}')
    page.keyboard.press('Escape'); time.sleep(0.5)
    # Swiping on a phone: right = the older one, left = the newer one
    ph = b.new_context(viewport={'width': 390, 'height': 800}, has_touch=True, is_mobile=True).new_page()
    ph.goto('http://localhost:3000/'); ph.fill('input[type=password]', 'testpassword'); ph.click('button:has-text("Sign in")')
    ph.wait_for_selector('.chat-row:has-text("Alice")', timeout=20000); ph.click('.chat-row:has-text("Alice")')
    ph.wait_for_selector('.img-btn:has(img[alt="view.png"])', timeout=15000); ph.click('.img-btn:has(img[alt="view.png"])')
    ph.wait_for_selector('.lightbox-count', timeout=10000)
    cdp = ph.context.new_cdp_session(ph)
    def swipe(x0, x1):
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x0, 'y': 400}]})
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': (x0 + x1) / 2, 'y': 400}]})
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []}); time.sleep(0.5)
    pc = lambda: ph.locator('.lightbox-count').inner_text()
    swipe(100, 300); print('swipe right:', pc()); assert pc() == f'{total - 1} of {total}'
    swipe(300, 100); print('swipe left:', pc()); assert pc() == f'{total} of {total}'
    assert ph.locator('.lightbox').count() == 1  # a swipe doesn't close it
    print('photo stepping ok')
    b.close()
print('ERRORS:', errors)
