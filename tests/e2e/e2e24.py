"""WhatsApp presence (online/last seen), "show me as online", profile, contacts, stickers, archive sync."""
import sys, time, json, re, urllib.request, os
MW = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def wa(path, data=None):
    r = urllib.request.Request('http://127.0.0.1:8090' + path, data=json.dumps(data).encode() if data is not None else None, headers={'content-type': 'application/json'}, method='POST' if data is not None else 'GET')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
def until(fn, secs=10, msg='timeout'):
    end = time.time() + secs
    while time.time() < end:
        if fn(): return
        time.sleep(0.3)
    raise AssertionError(msg)
sent = lambda path: [s for s in wa('/mock/sent') if s['path'] == path]
JAN = '31655500001@c.us'; LID = '88888888888888@lid'; GROUP = '120363000000000001@g.us'
def settings(page, title='Privacy'):
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Settings")'); page.click(f'.settings-nav-row:has(strong:text-is("{title}"))')
def back(page):
    if page.locator('button[aria-label="Back to settings"]').count(): page.click('button[aria-label="Back to settings"]')
    page.click('button[aria-label="Back to chats"]')

with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 1000})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('dialog', lambda d: d.accept())
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Familie'), timeout=20000); time.sleep(8)

    # 1. last seen
    page.click(row('Jan Bakker'))
    page.wait_for_selector('.chat-head p:text-matches("last seen (today|yesterday) at")', timeout=8000)
    wa('/mock/event', {'event': 'presence.update', 'payload': {'id': JAN, 'presences': [{'participant': JAN, 'lastKnownPresence': 'online'}]}})
    page.wait_for_selector('.chat-head p:text-is("online")', timeout=5000)
    print('presence ok')
    settings(page); page.click('.setting-row:has-text("Show when people are online") input'); back(page)
    page.wait_for_selector('.chat-head p:text-is("+31655500001")', timeout=5000)
    settings(page); page.click('.setting-row:has-text("Show when people are online") input'); back(page)
    print('presence toggle ok')

    # 2. show me as online
    assert not any(s.get('presence') == 'online' for s in sent('/api/default/presence'))
    settings(page); page.click('.setting-row:has-text("Show me as online on WhatsApp") input')
    page.evaluate("fetch('/api/presence', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({active: true})})")
    until(lambda: any(s.get('presence') == 'online' for s in sent('/api/default/presence')), 8, 'not shown as online')
    page.evaluate("fetch('/api/presence', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({active: false})})")
    until(lambda: sent('/api/default/presence')[-1].get('presence') == 'offline', 8, 'not offline again')
    print('show me online ok')

    # 3. WhatsApp profile
    page.click('button[aria-label="Back to settings"]'); page.click('.settings-nav-row:has(strong:text-is("Profile"))')
    page.wait_for_selector('input[aria-label="WhatsApp name"]')
    assert page.input_value('input[aria-label="WhatsApp name"]') == 'Wouter'
    page.fill('input[aria-label="WhatsApp about"]', 'Op vakantie 🌴'); page.click('button:has-text("Save WhatsApp profile")')
    until(lambda: any(s.get('status') == 'Op vakantie 🌴' for s in sent('/api/default/profile/status')), 8, 'about not saved')
    print('profile ok')
    back(page)

    # 4. contacts
    page.click(row('Sanne')) if page.locator(row('Sanne')).count() else None
    if not page.locator(row('Sanne')).count():
        wa('/mock/incoming', {'from': 'sanne', 'text': 'hoi'}); page.wait_for_selector(row('Sanne')); page.click(row('Sanne'))
    page.click('.chat-head-main'); page.click('button.panel-action:has-text("Edit contact")')
    page.fill('input[aria-label="Last name"]', 'de Vries'); page.click('.contact-edit button:has-text("Save")')
    until(lambda: any(s.get('lastName') == 'de Vries' for s in sent('/api/default/contacts/31655500002%40c.us')), 8, 'contact not saved')
    page.wait_for_selector(row('Sanne de Vries'), timeout=5000)
    page.click('.chat-head-main')
    print('contact ok')

    # 5. stickers in and out
    wa('/mock/incoming', {'from': 'jan', 'text': '', 'media': 'image/webp', 'extra': {'data': {'type': 'sticker'}}})
    page.click(row('Jan Bakker')); page.wait_for_selector('.msg .bubble.sticker img.sticker-img', timeout=8000)
    page.click('button[aria-label=Emoji]'); page.click('.picker-tabs button:has-text("Stickers")')
    page.click('nav.sticker-packs button[title="WhatsApp stickers not in a pack"]'); page.click('.picker-body .sticker-cell:has(img)')
    until(lambda: any(s.get('file', {}).get('mimetype') == 'image/webp' for s in sent('/api/sendSticker')), 8, 'sticker not sent')
    page.click('button[aria-label=Emoji]'); page.click('.picker-tabs button:has-text("Stickers")')
    page.set_input_files('nav.sticker-packs input[type=file]', os.path.join(MW, 'web/public/icon.svg'))
    until(lambda: any(s.get('file', {}).get('mimetype') == 'image/svg+xml' for s in sent('/api/sendSticker')), 8, 'image sticker not sent')
    print('stickers ok')

    # 6. archive both ways
    page.hover(row('Jan Bakker')); page.click(row('Jan Bakker') + ' .row-menu-btn'); page.click('.row-menu button:has-text("Archive chat")')
    until(lambda: sent('/api/default/chats/31655500001%40c.us/archive'), 5, 'archive not sent')
    wa('/mock/event', {'event': 'chat.archive', 'payload': {'id': LID, 'archived': True}})
    until(lambda: page.locator(row('Privé Pieter')).count() == 0, 5, 'phone archive not applied')
    wa('/mock/incoming', {'from': 'jan', 'text': 'nog een bericht'}); time.sleep(1.5)
    assert page.locator(row('Jan Bakker')).count() == 0, 'new message unarchived a WhatsApp chat'
    print('archive ok')
    page.screenshot(path=S + '/e2e24.png')
    b.close()
print('ERRORS:', errors)
