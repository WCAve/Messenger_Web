"""Mark as unread (both ways with the phone), "recording audio…", about texts, group descriptions, call lines (WhatsApp and Signal)."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def req(base, path, data=None):
    r = urllib.request.Request(base + path, data=json.dumps(data).encode() if data is not None else None, headers={'content-type': 'application/json'}, method='POST' if data is not None else 'GET')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
wa = lambda path, data=None: req('http://127.0.0.1:8090', path, data)
sig = lambda path, data=None: req('http://127.0.0.1:8080', path, data)
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
JAN = '31655500001@c.us'; SANNE = '31655500002@c.us'; LID = '88888888888888@lid'
def until(fn, secs=15, msg='timeout'):
    end = time.time() + secs
    while time.time() < end:
        if fn(): return
        time.sleep(0.3)
    raise AssertionError(msg)
def menu(page, title, item):
    page.hover(row(title)); page.click(row(title) + ' .row-menu-btn'); page.click(f'.row-menu button:has-text("{item}")'); time.sleep(0.4)

with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 900})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Familie'), timeout=20000)

    # 1. "marked as unread" on the phone is copied (Privé Pieter's chat has unreadCount -1)
    until(lambda: page.locator(row('Privé Pieter') + ' .badge-dot').count() == 1, 20, 'phone mark-unread not copied')
    print('mark-unread from phone ok')
    page.click(row('Privé Pieter')); time.sleep(1.2)
    assert page.locator(row('Privé Pieter') + ' .badge-dot').count() == 0, 'still marked after opening'
    seen = [s for s in wa('/mock/sent') if s['path'] == '/api/sendSeen' and s.get('chatId') == LID]
    assert seen, 'no sendSeen to clear the mark on the phone'
    print('opening clears it (and on the phone) ok')

    # 2. mark a chat as unread here: the open chat closes, the dot shows, WhatsApp is told
    page.click(row('Jan Bakker')); page.wait_for_selector('.msg:has-text("Kijk eens")')
    menu(page, 'Jan Bakker', 'Mark as unread')
    until(lambda: page.locator(row('Jan Bakker') + ' .badge-dot').count() == 1, 5, 'no dot after mark unread')
    assert page.locator('.msg:has-text("Kijk eens")').count() == 0, 'chat stayed open'
    assert any(s['path'] == f'/api/default/chats/{JAN.replace("@", "%40")}/unread' for s in wa('/mock/sent')), 'WAHA unread not called'
    assert 'Messenger' in page.title() or '(' in page.title()
    print('title with marked chat:', page.title())
    menu(page, 'Jan Bakker', 'Mark as read')
    until(lambda: page.locator(row('Jan Bakker') + ' .badge-dot').count() == 0, 5, 'mark as read did not clear')
    print('mark as unread / read ok')
    # phone marks a chat unread / reads it: WEBJS's unread_count engine event, copied straight away
    ue = lambda n: wa('/mock/event', {'event': 'engine.event', 'payload': {'event': 'unread_count', 'data': {'id': {'_serialized': JAN}, 'unreadCount': n}}})
    ue(-1); until(lambda: page.locator(row('Jan Bakker') + ' .badge-dot').count() == 1, 4, 'unread_count -1 not applied')
    ue(0); until(lambda: page.locator(row('Jan Bakker') + ' .badge-dot').count() == 0, 4, 'unread_count 0 not applied')
    print('instant phone sync ok')

    # 3. recording audio…
    page.click(row('Jan Bakker')); page.wait_for_selector('.msg:has-text("Kijk eens")')
    wa('/mock/event', {'event': 'presence.update', 'payload': {'id': JAN, 'presences': [{'participant': JAN, 'lastKnownPresence': 'recording'}]}})
    page.wait_for_selector('.chat-head p:has-text("recording audio…")', timeout=5000)
    assert page.locator(row('Jan Bakker') + ' .typing-text:has-text("recording audio…")').count() == 1
    wa('/mock/event', {'event': 'presence.update', 'payload': {'id': JAN, 'presences': [{'participant': JAN, 'lastKnownPresence': 'typing'}]}})
    page.wait_for_selector('.chat-head p:has-text("typing…")', timeout=5000)
    assert page.locator('.chat-head p:has-text("recording")').count() == 0
    wa('/mock/event', {'event': 'presence.update', 'payload': {'id': JAN, 'presences': [{'participant': JAN, 'lastKnownPresence': 'paused'}]}})
    print('recording audio ok')

    # 4. about text in contact info
    page.click('.chat-head-main'); page.wait_for_selector('aside.panel:has-text("Aan het fietsen")', timeout=8000)
    print('about ok')
    page.click('.chat-head-main'); time.sleep(0.3)

    # 5. group description
    page.click(row('Familie')); page.wait_for_selector('.msg:has-text("jij toch")')
    page.click('.chat-head-main'); page.wait_for_selector('aside.panel:has-text("De familie-app")', timeout=8000)
    print('group description ok')
    page.click('.chat-head-main'); time.sleep(0.3)

    # 6. WhatsApp call: a line straight away, updated by the call log message if one comes
    wa('/mock/event', {'event': 'call.received', 'payload': {'id': 'CALL1', 'from': SANNE, 'timestamp': int(time.time()), 'isVideo': False, 'isGroup': False}})
    page.wait_for_selector(row('Sanne'), timeout=8000)
    assert 'Incoming voice call' in page.inner_text(row('Sanne')), page.inner_text(row('Sanne'))
    page.click(row('Sanne')); page.wait_for_selector('.system-line:has-text("Incoming voice call")')
    wa('/mock/incoming', {'from': 'sanne', 'text': '', 'extra': {'data': {'type': 'call_log', 'callOutcome': 'Missed', 'isVideoCall': False}}})
    page.wait_for_selector('.system-line:has-text("Missed voice call")', timeout=5000)
    assert page.locator('.system-line:has-text("voice call")').count() == 1, 'call line duplicated'
    # a repeat of the same call event changes nothing
    wa('/mock/event', {'event': 'call.received', 'payload': {'id': 'CALL2', 'from': SANNE, 'timestamp': int(time.time()), 'isVideo': True, 'isGroup': False}})
    page.wait_for_selector('.system-line:has-text("Incoming video call")', timeout=5000)
    sent = wa('/mock/sent')
    assert not any('call:' in json.dumps(s.get('messageIds', [])) for s in sent if s['path'] == '/api/sendSeen'), 'call ids sent as seen'
    print('whatsapp calls ok')

    # 7. Signal calls: missed, and answered on another device
    sig('/mock/envelope', {'from': 'alice', 'envelope': {'callMessage': {'offerMessage': {'id': 111, 'type': 'AUDIO_CALL', 'opaque': ''}}}})
    page.wait_for_selector(row('Alice de Vries') + ':has-text("Incoming voice call")', timeout=8000)
    sig('/mock/envelope', {'from': 'alice', 'envelope': {'callMessage': {'hangupMessage': {'id': 111, 'type': 'NORMAL', 'deviceId': 0}}}})
    page.wait_for_selector(row('Alice de Vries') + ':has-text("Missed voice call")', timeout=5000)
    sig('/mock/envelope', {'from': 'bob', 'envelope': {'callMessage': {'offerMessage': {'id': 222, 'type': 'VIDEO_CALL', 'opaque': ''}}}})
    page.wait_for_selector(row('Bob Jansen') + ':has-text("Incoming video call")', timeout=8000)
    sig('/mock/envelope', {'from': 'bob', 'envelope': {'callMessage': {'hangupMessage': {'id': 222, 'type': 'ACCEPTED', 'deviceId': 1}}}})
    page.wait_for_selector(row('Bob Jansen') + ':has-text("Video call")', timeout=5000)
    sig('/mock/envelope', {'from': 'bob', 'envelope': {'callMessage': {'hangupMessage': {'id': 222, 'type': 'NORMAL', 'deviceId': 1}}}})
    time.sleep(0.8)
    assert 'Video call' in page.inner_text(row('Bob Jansen')), page.inner_text(row('Bob Jansen'))
    print('signal calls ok')

    # 8. Signal: mark as unread stays local
    menu(page, 'Alice de Vries', 'Mark as read')
    menu(page, 'Alice de Vries', 'Mark as unread')
    until(lambda: page.locator(row('Alice de Vries') + ' .badge-dot').count() == 1, 5, 'signal mark unread')
    page.reload(); page.wait_for_selector(row('Alice de Vries'))
    assert page.locator(row('Alice de Vries') + ' .badge-dot').count() == 1, 'mark lost on reload'
    print('signal mark-unread ok')
    page.screenshot(path=S + '/e2e15.png')
    b.close()
print('ERRORS:', errors)
