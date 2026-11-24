"""WAHA's GOWS engine (no browser): messages in whatsmeow's shape (mentions, photo with preview, forwarded,
voice note, view-once, poll), reactions/edits/deletions, privacy ids with their number, group changes as
lines, a missed call, a pin from the phone; what GOWS can't do is greyed out or hidden (pinning, blocking,
archiving only here), and Settings says so."""
# server-env: MOCK_WA_ENGINE=GOWS
import sys, time, json, urllib.request
from datetime import datetime, timezone
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
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
raw = lambda mid: mid.split('_')[2]
iso = lambda: datetime.now(timezone.utc).isoformat()
JAN, SANNE, GROUP = '31655500001@c.us', '31655500002@c.us', '120363000000000001@g.us'
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 1000})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Jan Bakker'), timeout=20000); time.sleep(6)

    # Settings: the engine and what it can't do
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Settings")'); page.click('.settings-nav-row:has(strong:text-is("WhatsApp"))')
    page.wait_for_selector('text=GOWS'); note = page.locator('p:has-text("only work on your phone")').inner_text(); print('settings:', note)
    assert 'pinning messages' in note and 'blocking' in note
    page.click('button[aria-label="Back to settings"]'); page.click('button[aria-label="Back to chats"]')

    # History in GOWS shape: the poll in Familie
    page.click(row('Familie')); page.wait_for_selector('.msg:has-text("Hoe laat?") .poll', timeout=8000); print('poll from history ok')

    # Incoming, GOWS-shaped
    wa('/mock/incoming', {'from': 'jan', 'group': True, 'text': '@31655500002 kom je ook?', 'extra': {'data': {'mentionedJidList': [SANNE]}}})
    page.wait_for_selector('.msg:has-text("kom je ook") .mention:has-text("@Sanne")'); print('mention ok')
    page.click(row('Jan Bakker')); page.wait_for_selector('.msg')
    wa('/mock/incoming', {'from': 'jan', 'text': 'Kettingbrief', 'media': 'image/png', 'extra': {'data': {'isForwarded': True, 'forwardingScore': 7}}})
    page.wait_for_selector('.msg:has-text("Kettingbrief") .forwarded:has-text("Forwarded many times")')
    page.wait_for_selector('.msg:has-text("Kettingbrief") img'); print('photo + forwarded ok')
    wa('/mock/incoming', {'from': 'jan', 'text': '', 'media': 'audio/ogg; codecs=opus'})
    page.wait_for_selector('.msg .voice .voice-badge:not(.audio-file)', timeout=8000); print('voice note ok')
    wa('/mock/incoming', {'from': 'jan', 'text': '', 'media': 'image/jpeg', 'extra': {'data': {'isViewOnce': True}}})
    page.wait_for_selector('.msg:has-text("View-once photo")'); print('view-once ok')

    # A reaction comes as a message too (GOWS): no empty message; the reaction event shows it
    n = page.locator('.msg').count()
    target = wa('/mock/incoming', {'from': 'jan', 'text': 'Reageer hierop'})
    page.wait_for_selector('.msg:has-text("Reageer hierop")')
    wa('/mock/incoming', {'from': 'jan', 'text': '', 'extra': {'data': {'type': 'reaction', 'target': target['id'], 'emoji': '😂'}}})
    wa('/mock/event', {'event': 'message.reaction', 'payload': {'id': 'r1', 'from': JAN, 'fromMe': False, 'reaction': {'text': '😂', 'messageId': target['id']}}})
    page.wait_for_selector('.msg:has-text("Reageer hierop") .reactions'); time.sleep(0.5)
    assert page.locator('.msg').count() == n + 1, page.locator('.msg').count() - n
    print('reaction ok')

    # Edit and delete (GOWS gives the raw id)
    wa('/mock/event', {'event': 'message.edited', 'payload': {'id': 'e1', 'from': JAN, 'fromMe': False, 'body': 'Reageer hierop!!', 'editedMessageId': raw(target['id']),
        '_data': {'Info': {'Chat': '31655500001@s.whatsapp.net', 'ID': 'E1'}, 'Message': {'protocolMessage': {'type': 14, 'key': {'ID': raw(target['id'])}, 'editedMessage': {'conversation': 'Reageer hierop!!'}}}}}})
    page.wait_for_selector('.msg:has-text("Reageer hierop!!")'); print('edit ok')
    gone = wa('/mock/incoming', {'from': 'jan', 'text': 'Oeps verkeerd'}); page.wait_for_selector('.msg:has-text("Oeps verkeerd")')
    wa('/mock/event', {'event': 'message.revoked', 'payload': {'after': None, 'before': None, 'revokedMessageId': raw(gone['id'])}})
    page.wait_for_selector('.msg:has-text("This message was deleted")'); print('delete ok')

    # A pin from the phone still shows (GOWS can't pin from here)
    wa('/mock/incoming', {'from': 'jan', 'text': '', 'extra': {'data': {'type': 'pinned_message', 'pinMessageType': 1, 'pinParentKey': {'_serialized': target['id']}, 'pinExpiryDuration': 604800}}})
    page.wait_for_selector('.pinned-bar:has-text("Reageer hierop!!")'); print('pin from phone ok')
    assert not page.locator('.pinned-bar button[aria-label="Unpin"]').count(), 'unpin offered on GOWS'
    m = page.locator('.msg.in:has-text("Kettingbrief")'); m.hover()
    btn = m.locator('button[aria-label="Pin"]'); assert btn.get_attribute('aria-disabled') == 'true' and 'GOWS' in btn.get_attribute('title')

    # A missed call: GOWS says the call ended without being picked up
    wa('/mock/event', {'event': 'call.received', 'payload': {'id': 'CALL1', 'from': JAN, 'timestamp': int(time.time()), 'isVideo': False, '_data': {'CallID': 'CALL1'}}})
    page.wait_for_selector('.system-line:has-text("Incoming voice call")')
    wa('/mock/event', {'event': 'call.rejected', 'payload': {'id': 'CALL1', 'from': JAN, 'timestamp': int(time.time()), 'isVideo': False, '_data': {'CallID': 'CALL1', 'Reason': 'timeout'}}})
    page.wait_for_selector('.system-line:has-text("Missed voice call")'); print('missed call ok')

    # No blocking, no "about" asked; archiving works here without asking WAHA
    page.click('.chat-head-main'); page.wait_for_selector('.info-panel, aside'); time.sleep(1)
    assert not page.locator('button:has-text("Block Jan")').count(), 'block offered on GOWS'
    assert not [x for x in wa('/mock/sent') if x['path'] == '/api/contacts/about'], 'asked for about'
    page.keyboard.press('Escape')

    # Group changes become lines (from GOWS's group events)
    page.click(row('Familie')); page.wait_for_selector('.msg')
    wa('/mock/event', {'event': 'group.v2.participants', 'payload': {'group': {'id': GROUP}, 'type': 'leave', 'timestamp': int(time.time()), 'participants': [{'id': SANNE, 'role': 'left'}],
        '_data': {'JID': GROUP, 'Sender': '31655500001@s.whatsapp.net', 'Timestamp': iso(), 'Leave': ['31655500002@s.whatsapp.net']}}})
    page.wait_for_selector('.system-line:has-text("removed Sanne")'); print('removed line:', page.locator('.system-line:has-text("removed Sanne")').inner_text())
    wa('/mock/event', {'event': 'group.v2.update', 'payload': {'group': {'id': GROUP, 'subject': 'Familie 2'}, 'timestamp': int(time.time()),
        '_data': {'JID': GROUP, 'Sender': '31600000009@s.whatsapp.net', 'Timestamp': iso(), 'Name': {'Name': 'Familie 2'}}}})
    page.wait_for_selector('.system-line:has-text("You changed the group name to “Familie 2”")'); print('rename line ok')
    page.screenshot(path=S + '/e2e72-group.png')

    # A privacy id with its number: lands in that person's chat
    wa('/mock/contact', {'key': 'sannelid', 'id': '77777777777777@lid', 'pushname': 'Sanne'})
    wa('/mock/incoming', {'from': 'sannelid', 'text': 'Hoi via lid', 'extra': {'data': {'senderAlt': SANNE, 'notifyName': 'Sanne'}}})
    until(lambda: page.locator(row('Sanne') + ':has-text("Hoi via lid")').count(), 'lid chat under Sanne')
    convs = page.evaluate("fetch('/api/conversations').then(r => r.json())")
    lst = convs if isinstance(convs, list) else convs.get('conversations', [])
    assert not [c for c in lst if '7777777' in json.dumps(c)], 'chat kept under the privacy id'
    print('lid ok')

    # Your own messages sent from the phone: in their chat, not in "Message yourself" (GOWS has the chat
    # in "from", and in groups you in "to")
    wa('/mock/incoming', {'from': 'jan', 'group': True, 'text': 'Van mijn telefoon in de groep', 'extra': {'fromMe': True, 'source': 'app'}})
    wa('/mock/incoming', {'from': 'jan', 'text': 'Van mijn telefoon aan Jan', 'extra': {'fromMe': True, 'source': 'app'}})
    page.click(row('Familie')); page.wait_for_selector('.msg.out:has-text("Van mijn telefoon in de groep")')
    page.click(row('Jan Bakker')); page.wait_for_selector('.msg.out:has-text("Van mijn telefoon aan Jan")')
    assert not [c for c in page.evaluate("fetch('/api/conversations').then(r => r.json())") if 'Van mijn telefoon' in json.dumps(c) and c.get('title') not in ('Familie', 'Jan Bakker')]
    print('own messages from the phone ok')

    # Archive: here only (WAHA isn't asked: GOWS can't)
    jan = [c for c in lst if c.get('title') == 'Jan Bakker'][0]
    r = page.evaluate("id => fetch('/api/conversations/' + id + '/flags', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({archived: true})}).then(r => r.status)", jan['id'])
    assert r == 200, r
    until(lambda: not page.locator(row('Jan Bakker')).count(), 'Jan archived')
    assert not [x for x in wa('/mock/sent') if 'archive' in x['path']], 'asked WAHA to archive'
    print('archive here only ok')
    assert not errors, errors
    b.close()
print('e2e72 ok')
