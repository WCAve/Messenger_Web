"""The composer's buttons: Emoji, GIF and Stickers each open their own section (no tab row; the same
button closes it), the picker can be dragged bigger or made big with a button (remembered), and the 📎
menu: photos & videos (sent as photos), a document (a photo sent as a file), contact, poll."""
import sys, time, json, struct, zlib, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
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
def png():
    c = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + c(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) + c(b'IDAT', zlib.compress(b'\x00\x10\x20\x30')) + c(b'IEND', b'')
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
sends = lambda kind: [x for x in wa('/mock/sent') if x['path'] == '/api/' + kind]
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 1000})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Jan Bakker'), timeout=20000); page.click(row('Jan Bakker')); page.wait_for_selector('.composer textarea')

    # Each button its own section, no tabs; the same button closes it, another switches
    page.click('.composer button[aria-label=Emoji]'); page.wait_for_selector('.picker-panel .emoji-grid')
    assert not page.locator('.picker-tabs button:has-text("Stickers")').count(), 'tab row still there'
    page.click('.composer button[aria-label=Stickers]'); page.wait_for_selector('.picker-panel nav.sticker-packs')
    assert page.get_attribute('.composer button[aria-label=Stickers]', 'aria-expanded') == 'true'
    page.click('.composer button[aria-label=GIF]'); page.wait_for_selector('.picker-panel .gif-grid, .picker-panel .picker-search')
    page.click('.composer button[aria-label=GIF]'); until(lambda: not page.locator('.picker-panel').count(), 'GIF button closes')
    print('buttons ok')

    # Drag the bar up: bigger; remembered when opened again
    page.click('.composer button[aria-label=Stickers]'); page.wait_for_selector('.picker-grip')
    h0 = page.locator('.picker-panel').bounding_box()['height']
    g = page.locator('.picker-grip').bounding_box(); x, y = g['x'] + g['width'] / 2, g['y'] + g['height'] / 2
    page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x, y - 150, steps=8); page.mouse.up()
    h1 = page.locator('.picker-panel').bounding_box()['height']
    assert abs(h1 - (h0 + 150)) < 6, (h0, h1)
    page.click('.composer button[aria-label=Stickers]'); page.click('.composer button[aria-label=Emoji]'); page.wait_for_selector('.picker-panel .emoji-grid')
    assert abs(page.locator('.picker-panel').bounding_box()['height'] - h1) < 6, 'size not remembered'
    # The button: most of the chat, and back
    page.click('.picker-panel button[aria-label="Make bigger"]'); time.sleep(0.2)
    big = page.locator('.picker-panel').bounding_box()['height']
    assert big > h1 + 100 and big < 1000, big
    page.screenshot(path=S + '/e2e83-big.png')
    page.click('.picker-panel button[aria-label="Make smaller"]'); time.sleep(0.2)
    assert abs(page.locator('.picker-panel').bounding_box()['height'] - h1) < 6
    page.click('.picker-panel button[aria-label="Make bigger"]'); page.reload(); page.wait_for_selector(row('Jan Bakker'), timeout=20000); page.click(row('Jan Bakker')); page.wait_for_selector('.composer textarea')
    page.click('.composer button[aria-label=Emoji]'); page.wait_for_selector('.picker-panel button[aria-label="Make smaller"]'); print('size ok')
    page.click('.composer button[aria-label=Emoji]')

    # 📎 menu: four items
    page.click('.composer button[aria-label=Attach]'); page.wait_for_selector('.attach-menu')
    items = [t.strip() for t in page.locator('.attach-menu button').all_inner_texts()]
    assert items == ['Photos & videos', 'Document', 'Contact', 'Poll'], items
    page.screenshot(path=S + '/e2e83-attach.png')
    page.click('.attach-menu button:has-text("Poll")'); page.wait_for_selector('.dialog:has-text("New poll")'); page.keyboard.press('Escape')
    page.click('.composer button[aria-label=Attach]'); page.click('.attach-menu button:has-text("Contact")'); page.wait_for_selector('.dialog:has-text("Share a contact")'); page.keyboard.press('Escape')
    until(lambda: not page.locator('.dialog').count(), 'dialog closed')

    # Photos & videos: a photo; Document: the same photo as a file
    page.set_input_files('input.attach-photos', files=[{'name': 'foto.png', 'mimeType': 'image/png', 'buffer': png()}])
    page.wait_for_selector('.pending-file img'); page.click('.composer .send-btn')
    until(lambda: sends('sendImage'), 'photo sent as a photo')
    page.set_input_files('input.attach-docs', files=[{'name': 'scan.png', 'mimeType': 'image/png', 'buffer': png()}])
    page.wait_for_selector('.pending-file:has-text("scan.png")'); assert not page.locator('.pending-file img').count(), 'document shown as a photo'
    page.click('.composer .send-btn')
    f = until(lambda: [x for x in sends('sendFile') if 'scan.png' in json.dumps(x)], 'document sent as a file')
    print('attach ok', f[0].get('file', {}).get('mimetype'))
    assert not errors, errors
    b.close()
print('e2e83 ok')
