"""Recording voice messages: the microphone button (when there's nothing to send), recording with a timer,
Escape throws it away, Stop puts it above the box to listen to, Send sends it as a voice message
(Signal: converted to M4A; WhatsApp: as a voice message)."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def get(port, path): return json.loads(urllib.request.urlopen(f'http://127.0.0.1:{port}{path}').read() or b'null')
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
    ctx = b.new_context(viewport={'width': 1400, 'height': 900}, permissions=['microphone'])
    page = ctx.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row:has-text("Alice")', timeout=20000); time.sleep(2)
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg')
    mic = page.locator('button[aria-label="Record a voice message"]')
    assert mic.is_visible()
    page.locator('textarea').fill('hallo'); assert not mic.count(), 'mic shown while there is text'
    page.locator('textarea').fill('')

    # Escape throws a recording away
    mic.click(); page.wait_for_selector('.recording'); time.sleep(1.2)
    page.keyboard.press('Escape'); page.wait_for_selector('.recording', state='detached')
    time.sleep(0.5); assert not page.locator('.pending-file').count(), 'kept a cancelled recording'

    # Record, listen, send (Signal)
    page.locator('button[aria-label="Record a voice message"]').click(); page.wait_for_selector('.recording')
    time.sleep(2.3); print('while recording:', page.locator('.recording').inner_text())
    assert '0:02' in page.locator('.recording').inner_text()
    page.screenshot(path=S + '/e2e70-recording.png')
    page.click('button[aria-label="Stop recording"]')
    page.wait_for_selector('.pending-file.voice-pending audio')
    dur = None
    for _ in range(20):
        dur = page.evaluate("(() => { const a = document.querySelector('.voice-preview'); return a && a.readyState && isFinite(a.duration) ? a.duration : null; })()")
        if dur: break
        time.sleep(0.2)
    print('preview length:', dur)
    page.screenshot(path=S + '/e2e70-preview.png')
    before = len(get(8080, '/mock/sent'))
    page.click('button.send-btn[aria-label="Send"]')
    sent = None
    for _ in range(60):
        sent = [x for x in get(8080, '/mock/sent')[before:] if x.get('base64_attachments')]
        if sent: break
        time.sleep(0.25)
    head = sent[0]['base64_attachments'][0].split('base64,')[0]; print('Signal got:', head, sent[0]['attachment_sizes'])
    assert head.startswith('data:audio/mp4;filename=Voice message') and '.m4a' in head, head
    assert dur and dur != float('inf') and 1.5 < dur < 4, f'preview length {dur}'
    page.wait_for_selector('.msg.out .voice .voice-badge:not(.audio-file)', timeout=8000); print('shown as a voice message')

    # WhatsApp: a real voice message
    page.click('.chat-row:has-text("Jan Bakker")'); page.wait_for_selector('.msg')
    page.locator('button[aria-label="Record a voice message"]').click(); page.wait_for_selector('.recording'); time.sleep(1.5)
    page.click('button[aria-label="Stop recording"]'); page.wait_for_selector('.pending-file.voice-pending')
    page.click('button.send-btn[aria-label="Send"]')
    wa = None
    for _ in range(60):
        wa = [x for x in get(8090, '/mock/sent') if x['path'] == '/api/sendVoice']
        if wa: break
        time.sleep(0.25)
    print('WhatsApp:', wa[0]['path'], wa[0]['file'].get('mimetype'), wa[0]['file'].get('filename')); assert wa
    assert not errors, errors
    b.close()
print('e2e70 ok')
