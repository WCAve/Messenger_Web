"""Mark all as read."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def req(base, path, data=None):
    r = urllib.request.Request(base + path, data=json.dumps(data).encode() if data is not None else None, headers={'content-type': 'application/json'}, method='POST' if data is not None else 'GET')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
wa = lambda path, data=None: req('http://127.0.0.1:8090', path + ('&' if '?' in path else '?') + 'x-api-key=test-waha-key', data)
sig = lambda path, data=None: req('http://127.0.0.1:8080', path, data)
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
def until(fn, secs=10, msg='timeout'):
    end = time.time() + secs
    while time.time() < end:
        if fn(): return
        time.sleep(0.3)
    raise AssertionError(msg)
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 1000})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Familie'), timeout=20000); time.sleep(6)
    cookies = '; '.join(f"{c['name']}={c['value']}" for c in page.context.cookies())
    def api(path, data=None):
        h = {'cookie': cookies}
        if data is not None: h['content-type'] = 'application/json'
        r = urllib.request.Request('http://localhost:3000' + path, data=json.dumps(data).encode() if data is not None else None, headers=h, method='POST' if data is not None else 'GET')
        return json.loads(urllib.request.urlopen(r).read() or b'null')
    # make sure there's unread on both networks, and one chat marked unread
    wa('/mock/incoming', {'from': 'jan', 'text': 'Ongelezen WhatsApp'})
    sig('/mock/incoming', {'from': 'alice', 'text': 'Unread Signal'}) if True else None
    convs = api('/api/conversations')
    readc = [c for c in convs if not c['unread'] and not c['markedUnread']][0]
    api(f"/api/conversations/{readc['id']}/flags", {'markedUnread': True})
    until(lambda: sum(1 for c in api('/api/conversations') if c['unread'] or c['markedUnread']) >= 3, 10, 'setup')
    before = [c['title'] for c in api('/api/conversations') if c['unread'] or c['markedUnread']]
    print('unread before:', before, page.title())
    seen0 = len([s for s in wa('/mock/sent') if s.get('path', '').endswith('/sendSeen')])
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Mark all as read")')
    until(lambda: not any(c['unread'] or c['markedUnread'] for c in api('/api/conversations')), 10, 'still unread')
    until(lambda: page.title() == 'Messenger Web', 5, 'title still counts')
    assert page.locator('.chat-row .unread-badge, .chat-row .badge:not(:empty)').count() == 0
    until(lambda: len([s for s in wa('/mock/sent') if s.get('path', '').endswith('/sendSeen')]) > seen0, 10, 'no WhatsApp read receipts')
    print('all read ok')
    # nothing left: the menu item is greyed out
    page.click('button[aria-label=Menu]')
    assert page.locator('button[role=menuitem]:has-text("Mark all as read")').is_disabled()
    print('disabled ok')
    b.close()
print('ERRORS:', errors)
