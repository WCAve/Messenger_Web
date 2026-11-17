"""Voice messages play on (the next voice message starts when one ends); "groups in common" in contact
info (Signal and WhatsApp); contact cards: received (Signal shared contact, WhatsApp vCard) and shared."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def post(port, path, body):
    req = urllib.request.Request(f'http://127.0.0.1:{port}{path}', data=json.dumps(body).encode(), headers={'content-type': 'application/json'})
    return urllib.request.urlopen(req).read()
def get(port, path): return json.loads(urllib.request.urlopen(f'http://127.0.0.1:{port}{path}').read() or b'null')
voice = lambda i: {'contentType': 'audio/aac', 'filename': None, 'id': f'mockvoice{i}.wav', 'size': 48044, 'isVoiceNote': True}
VCARD = 'BEGIN:VCARD\r\nVERSION:3.0\r\nN:Smit;Pieter;;;\r\nFN:Pieter Smit\r\nORG:Smit Bouw;\r\nitem1.TEL;waid=31687654321:+31 6 87654321\r\nEND:VCARD'
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required']); page = b.new_page(viewport={'width': 1400, 'height': 900})
    page.on('pageerror', lambda e: errors.append(str(e)))
    post(8080, '/mock/incoming', {'from': 'alice', 'text': '', 'extra': {'attachments': [voice(1)]}})
    post(8080, '/mock/incoming', {'from': 'alice', 'text': '', 'extra': {'attachments': [voice(2)]}})
    post(8080, '/mock/incoming', {'from': 'alice', 'text': '', 'extra': {'contacts': [{'name': {'given': 'Ellen', 'family': 'de Boer'}, 'phone': [{'value': '+31611122233', 'type': 'MOBILE'}], 'organization': 'Gemeente'}]}})
    post(8090, '/mock/incoming', {'from': 'jan', 'text': VCARD, 'extra': {'type': 'vcard', 'vCards': [VCARD]}})
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row:has-text("Alice")', timeout=20000); time.sleep(2)

    # 1. Voice messages play on
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.voice >> nth=1', timeout=10000)
    voices = page.locator('.voice')
    voices.nth(voices.count() - 2).locator('.voice-play').click()
    page.wait_for_selector('.voice.playing', timeout=5000)
    second = None
    for _ in range(80):
        if voices.nth(voices.count() - 1).get_attribute('class').find('playing') >= 0: second = True; break
        time.sleep(0.1)
    print('the next voice message started by itself:', second); assert second

    # 3. A received Signal contact card
    card = page.locator('.msg.in .contact-card').last; card.wait_for(timeout=5000)
    print('Signal card:', card.inner_text().replace('\n', ' | '))
    assert 'Ellen de Boer' in card.inner_text() and '+31611122233' in card.inner_text() and 'Gemeente' in card.inner_text()
    assert page.locator('.chat-row:has-text("Alice")').inner_text().find('👤 Ellen de Boer') >= 0, 'not in the chat list preview'

    # 2. Groups in common (Signal): Alice is in "Weekend plans"
    page.click('.chat-head-main'); page.wait_for_selector('.panel:has-text("Contact info")')
    page.wait_for_selector('.common-groups', timeout=5000)
    print('Signal groups in common:', page.locator('.common-groups').inner_text().replace('\n', ' | '))
    assert 'Weekend plans' in page.locator('.common-groups').inner_text()
    page.click('.common-groups button:has-text("Weekend plans")')
    page.wait_for_selector('.chat-head:has-text("Weekend plans")'); print('opens the group')

    # Share a contact in Signal: name and number as text (+ a .vcf), shown as a card here
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg')
    page.click('button[aria-label="Share a contact"]'); page.wait_for_selector('.share-contact')
    page.fill('input[aria-label="Find a contact"]', 'Carol'); page.click('.share-contact .member:has-text("Carol")')
    page.wait_for_selector('.msg.out .contact-card:has-text("Carol")', timeout=5000)
    sent = [x for x in get(8080, '/mock/sent') if (x.get('message') or '').startswith('👤')][-1]
    print('Signal sent:', repr(sent['message']), sent['base64_attachments'][0][:50])
    assert '+31633333333' in sent['message'] and sent['base64_attachments'][0].startswith('data:text/vcard;filename=Carol')

    # WhatsApp: a received vCard, groups in common, and sharing a real contact card
    page.click('.chat-row:has-text("Jan Bakker")'); page.wait_for_selector('.msg')
    card = page.locator('.msg.in .contact-card').last; card.wait_for(timeout=5000)
    print('WhatsApp card:', card.inner_text().replace('\n', ' | '))
    assert 'Pieter Smit' in card.inner_text() and '+31 6 87654321' in card.inner_text() and 'BEGIN:VCARD' not in page.content()
    page.click('.chat-head-main'); page.wait_for_selector('.common-groups', timeout=8000)
    print('WhatsApp groups in common:', page.locator('.common-groups').inner_text().replace('\n', ' | '))
    assert 'Familie' in page.locator('.common-groups').inner_text()
    page.keyboard.press('Escape')
    box = page.locator('textarea'); box.click(); box.fill('/contact'); page.keyboard.press('Enter')
    page.wait_for_selector('.share-contact'); page.fill('input[aria-label="Find a contact"]', 'Sanne')
    page.click('.share-contact .member >> nth=0')
    page.wait_for_selector('.msg.out .contact-card', timeout=5000)
    vc = [x for x in get(8090, '/mock/sent') if x['path'] == '/api/sendContactVcard'][-1]
    print('WhatsApp sent:', vc['contacts']); assert vc['contacts'][0]['fullName'] and vc['contacts'][0]['phoneNumber']

    # "Message" on a card opens (or starts) the chat with that number
    page.locator('.msg.in .contact-card button:has-text("Message")').last.click()
    page.wait_for_selector('.chat-head:has-text("+31 6 87654321"), .chat-head:has-text("31687654321"), .chat-head:has-text("Pieter")', timeout=8000)
    print('Message → chat with', page.locator('.chat-head').inner_text().split('\n')[0])
    assert not errors, errors
    b.close()
print('e2e68 ok')
