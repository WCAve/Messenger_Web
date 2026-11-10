"""WhatsApp messages sent before you last read a chat stay read when they come in (again) as new; new ones
don't; WhatsApp is told so the phone clears them; reading on the phone counts too; the dot is untouched."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
JAN, SANNE = '31655500001@c.us', '31655500002@c.us'
def wa(path, data=None):
    r = urllib.request.Request('http://127.0.0.1:8090' + path, data=json.dumps(data).encode() if data is not None else None, headers={'content-type': 'application/json'}, method='POST' if data is not None else 'GET')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
def wait(cond, t=10, msg='timeout'):
    end = time.time() + t
    while time.time() < end:
        v = cond()
        if v: return v
        time.sleep(0.2)
    raise AssertionError(msg)
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
now = int(time.time() * 1000)
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 1000})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Jan Bakker'), timeout=20000); time.sleep(10)  # history import done
    badge = lambda t: page.locator(row(t) + ' .badge:not(.badge-dot)').all_inner_texts()
    # Read Jan's chat here, then leave it
    page.click(row('Jan Bakker')); wait(lambda: not badge('Jan Bakker'), msg='Jan not read'); time.sleep(0.5)
    page.click(row('Familie')); time.sleep(0.5)
    # An old message comes in as new (an hour old): stays read, and WhatsApp hears it's read
    old = wa('/mock/incoming', {'from': 'jan', 'text': 'Oud bericht opnieuw', 'extra': {'ts': now - 3600_000}})
    time.sleep(1.5)
    assert not badge('Jan Bakker'), badge('Jan Bakker')
    seen = wait(lambda: [x for x in wa('/mock/sent') if x['path'] == '/api/sendSeen' and old['id'] in (x.get('messageIds') or [])], 8, 'no seen sent')
    print('old one stays read, seen sent:', seen[-1]['messageIds'])
    # A new message: unread as always
    wa('/mock/incoming', {'from': 'jan', 'text': 'Echt nieuw'}); time.sleep(1)
    assert badge('Jan Bakker') == ['1'], badge('Jan Bakker')
    # One sent a minute before you read the chat (still being sent): unread too
    page.click(row('Jan Bakker')); wait(lambda: not badge('Jan Bakker')); page.click(row('Familie')); time.sleep(0.5)
    wa('/mock/incoming', {'from': 'jan', 'text': 'Net onderweg', 'extra': {'ts': int(time.time() * 1000) - 60_000}}); time.sleep(1)
    assert badge('Jan Bakker') == ['1'], badge('Jan Bakker')
    print('new ones unread ok')
    # Read on the phone (WhatsApp says 0 unread) also counts
    page.click(row('Jan Bakker')); time.sleep(0.5)  # not Familie: it's open, and an open chat reads everything
    s0 = badge('Familie')
    wa('/mock/event', {'event': 'engine.event', 'payload': {'event': 'unread_count', 'data': {'id': '120363000000000001@g.us', 'unreadCount': 0}}}); time.sleep(1)
    wa('/mock/incoming', {'from': 'sanne', 'group': True, 'text': 'Oude in de groep', 'extra': {'ts': now - 7200_000}}); time.sleep(1.5)
    print('familie before/after:', s0, badge('Familie'))
    assert badge('Familie') == s0, badge('Familie')
    wa('/mock/incoming', {'from': 'sanne', 'group': True, 'text': 'Nieuwe in de groep'}); time.sleep(1.5)
    print('familie after a new one:', badge('Familie'))
    assert badge('Familie') != s0
    # "Mark as unread" (the dot) still works
    page.click(row('Jan Bakker')); wait(lambda: not badge('Jan Bakker')); page.click(row('Familie')); time.sleep(0.5)
    page.hover(row('Jan Bakker')); page.click(row('Jan Bakker') + ' .row-menu-btn'); page.click('.row-menu button:has-text("Mark as unread")'); time.sleep(0.8)
    assert page.locator(row('Jan Bakker') + ' .badge-dot').count() == 1
    print('dot ok')
    b.close()
print('ERRORS:', errors)
