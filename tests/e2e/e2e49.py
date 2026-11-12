"""A reply to a photo without caption: WhatsApp Web puts the photo's preview picture (as base64 text) where
the quoted text goes. It must show "Photo" with the picture, never the data; also when the photo itself
isn't here, and for a photo whose own text is that data."""
import sys, time, json, base64, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def wa(path, data):
    r = urllib.request.Request('http://127.0.0.1:8090' + path, data=json.dumps(data).encode(), headers={'content-type': 'application/json'}, method='POST')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
DATA = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEABsbGxscGx4hIR4qLSgtKj04MzM4PV1CR0JHQl2NWGdYWGdYjX2Xe3N7l33gsJycsOD' + base64.b64encode(bytes(range(256)) * 4).decode()
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 1000})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row-wrap:has(.chat-title:text-is("Familie"))', timeout=20000); time.sleep(6)
    page.click('.chat-row-wrap:has(.chat-title:text-is("Familie"))'); page.wait_for_selector('.msg')
    # A photo whose own text is the preview data (as WhatsApp Web sometimes sends it)
    photo = wa('/mock/incoming', {'from': 'sanne', 'group': True, 'text': DATA, 'media': 'image/jpeg'})
    page.wait_for_selector('.msg .img-btn', timeout=10000); time.sleep(1)
    assert DATA[:20] not in page.locator('.messages').inner_text()
    # Replies to it, and to a photo that isn't here
    wa('/mock/incoming', {'from': 'jan', 'group': True, 'text': 'Wat een rit', 'extra': {'replyTo': {'id': photo['id'], 'participant': '31655500002@c.us', 'body': DATA}}})
    wa('/mock/incoming', {'from': 'jan', 'group': True, 'text': 'En deze?', 'extra': {'replyTo': {'id': 'false_x_NOTHERE1234', 'participant': '31655500002@c.us', 'body': DATA}}})
    page.wait_for_selector('.msg:has-text("En deze?")'); time.sleep(1)
    page.screenshot(path=S + '/e2e49.png')
    text = page.locator('.messages').inner_text()
    assert DATA[:20] not in text and '/9j/' not in text, text[-500:]
    q1 = page.locator('.msg:has-text("Wat een rit") .quote').inner_text(); print('quote 1:', q1)
    q2 = page.locator('.msg:has-text("En deze?") .quote').inner_text(); print('quote 2:', q2)
    assert 'Photo' in q1 and 'Photo' in q2
    assert page.locator('.msg:has-text("Wat een rit") .quote img').count() == 1  # the picture of the photo it replies to
    print('preview data hidden ok')
    b.close()
print('ERRORS:', errors)
