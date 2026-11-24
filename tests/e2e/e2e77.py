"""Reading on your phone clears the unread count here, on GOWS (whatsmeow's "read-self" receipts and
"mark chat as read/unread", which WAHA only passes on as raw engine events)."""
# server-env: MOCK_WA_ENGINE=GOWS
import sys, time, json, urllib.request
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def wa(path, data):
    r = urllib.request.Request('http://127.0.0.1:8090' + path, data=json.dumps(data).encode(), headers={'content-type': 'application/json'}, method='POST')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
raw = lambda mid: mid.split('_')[2]
iso = lambda: datetime.now(timezone.utc).isoformat()
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
def badge(t):
    b = page.locator(row(t) + ' .badge')
    return b.inner_text().strip() if b.count() else ''
def until(fn, what, secs=10):
    end = time.time() + secs
    while time.time() < end:
        if fn(): return
        time.sleep(0.25)
    raise AssertionError('timed out: ' + what)
raw_event = lambda name, data: wa('/mock/event', {'event': 'engine.event', 'payload': {'event': name, 'data': data}})
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1300, 'height': 900}); page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Familie'), timeout=20000); time.sleep(4)

    # Read on the phone, one chat: read-self receipt for the newest messages
    m1 = wa('/mock/incoming', {'from': 'jan', 'text': 'Een'}); m2 = wa('/mock/incoming', {'from': 'jan', 'text': 'Twee'})
    until(lambda: badge('Jan Bakker') not in ('', '0'), 'Jan unread')
    raw_event('events.Receipt', {'Chat': '31655500001@s.whatsapp.net', 'Sender': '31600000009@s.whatsapp.net', 'IsFromMe': True, 'IsGroup': False, 'MessageIDs': [raw(m2['id'])], 'Timestamp': iso(), 'Type': 'read-self'})
    until(lambda: badge('Jan Bakker') == '', 'Jan read after read-self'); print('read-self ok')

    # A receipt of another kind (someone else read ours) changes nothing
    m3 = wa('/mock/incoming', {'from': 'jan', 'text': 'Drie'}); until(lambda: badge('Jan Bakker') == '1', 'Jan 1 unread')
    raw_event('events.Receipt', {'Chat': '31655500001@s.whatsapp.net', 'IsFromMe': False, 'MessageIDs': [raw(m3['id'])], 'Timestamp': iso(), 'Type': 'read'})
    time.sleep(1); assert badge('Jan Bakker') == '1', badge('Jan Bakker')

    # Group: the whole chat marked read on the phone, then marked unread
    wa('/mock/incoming', {'from': 'sanne', 'group': True, 'text': 'Groepsbericht'}); until(lambda: badge('Familie') not in ('', '0'), 'Familie unread')
    raw_event('events.MarkChatAsRead', {'JID': '120363000000000001@g.us', 'Timestamp': iso(), 'Action': {'read': True, 'messageRange': {'lastMessageTimestamp': int(time.time())}}, 'FromFullSync': False})
    until(lambda: badge('Familie') == '', 'Familie read'); print('mark chat read ok')
    raw_event('events.MarkChatAsRead', {'JID': '120363000000000001@g.us', 'Timestamp': iso(), 'Action': {'read': False}, 'FromFullSync': False})
    until(lambda: page.locator(row('Familie') + ' .badge, ' + row('Familie') + ' .unread-dot').count() > 0, 'Familie marked unread')
    print('mark chat unread ok')
    page.screenshot(path=S + '/e2e77.png')
    assert not errors, errors
    b.close()
print('e2e77 ok')
