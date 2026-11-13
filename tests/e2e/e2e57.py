"""Voice messages and audio files play in a WhatsApp-style player: picture with a mic, play/pause, the
recording's waveform (loud-quiet-loud here), time, a speed button while playing, click-to-jump; one at a time."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def sig(path, data):
    r = urllib.request.Request('http://127.0.0.1:8080' + path, data=json.dumps(data).encode(), headers={'content-type': 'application/json'}, method='POST')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
voice = lambda i: {'contentType': 'audio/aac', 'filename': None, 'id': f'mockvoice{i}.wav', 'size': 48044, 'isVoiceNote': True}
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required']); page = b.new_page(viewport={'width': 1300, 'height': 900})
    page.on('pageerror', lambda e: errors.append(str(e)))
    sig('/mock/incoming', {'from': 'alice', 'text': '', 'extra': {'attachments': [voice(1)]}})
    sig('/mock/incoming', {'from': 'alice', 'text': '', 'extra': {'attachments': [voice(2)]}})
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row:has-text("Alice")', timeout=20000)
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.voice', timeout=10000)
    v1, v2 = page.locator('.voice').nth(0), page.locator('.voice').nth(1)
    assert page.locator('audio[controls]').count() == 0  # no browser player any more
    assert v1.locator('.voice-face .voice-badge').count() == 1 and v1.locator('.voice-badge.audio-file').count() == 0  # a microphone
    assert v1.locator('.voice-badge').bounding_box()['width'] < 24  # a small round badge
    for _ in range(40):  # waveform worked out from the sound (the file may still be on its way)
        hs = v1.locator('.voice-wave > span:not(.voice-knob)').evaluate_all('s => s.map(x => parseFloat(x.style.height))')
        if hs[len(hs) // 2] < 30: break
        time.sleep(0.5)
    hs = v1.locator('.voice-wave > span:not(.voice-knob)').evaluate_all('s => s.map(x => parseFloat(x.style.height))')
    third = len(hs) // 3
    loud1, quiet, loud2 = sum(hs[:third]) / third, sum(hs[third + 2:2 * third - 2]) / (third - 4), sum(hs[-third:]) / third
    print(f'wave: {loud1:.0f}% / {quiet:.0f}% / {loud2:.0f}%')
    assert loud1 > 70 and loud2 > 70 and quiet < 30, hs
    assert v1.locator('.voice-time').inner_text() == '0:03'
    v2.scroll_into_view_if_needed(); time.sleep(0.3)
    page.locator('.msg:has(.voice)').first.screenshot(path=S + '/e2e57-light.png')
    bb = page.locator('.msg:has(.voice) .bubble').first.bounding_box(); page.screenshot(path=S + '/e2e57-wide.png', clip={'x': bb['x'] - 20, 'y': bb['y'] - 10, 'width': bb['width'] + 40, 'height': bb['height'] + 20})
    # Play: pause button, speed button instead of the picture, time and the coloured part move
    v1.locator('.voice-play').click(); time.sleep(1.2)
    assert 'Pause' in v1.locator('.voice-play').get_attribute('aria-label')
    assert v1.locator('.voice-speed').inner_text() == '1×' and v1.locator('.voice-face').count() == 0
    on = v1.locator('.voice-wave > span.on').count(); print('played bars after 1.2s:', on); assert on > 5
    v1.locator('.voice-speed').click(); assert v1.locator('.voice-speed').inner_text() == '1.5×'
    page.locator('.msg:has(.voice)').first.screenshot(path=S + '/e2e57-playing.png')
    # One at a time
    v2.locator('.voice-play').click(); time.sleep(0.5)
    assert 'Play' in v1.locator('.voice-play').get_attribute('aria-label') and 'Pause' in v2.locator('.voice-play').get_attribute('aria-label')
    v2.locator('.voice-play').click()
    # Click on the waveform to jump
    box = v1.locator('.voice-wave').bounding_box(); page.mouse.click(box['x'] + box['width'] * 0.66, box['y'] + box['height'] / 2); time.sleep(0.3)
    t = v1.locator('.voice-time').inner_text(); print('after jump:', t); assert t == '0:01'
    assert v1.locator('.voice-wave').get_attribute('aria-valuenow') == '2'
    page.emulate_media(color_scheme='dark'); time.sleep(0.5)
    page.locator('.msg:has(.voice)').nth(1).screenshot(path=S + '/e2e57-dark.png')
    print('voice player ok')
    b.close()
print('ERRORS:', errors)
