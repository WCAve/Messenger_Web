"""Unread count in the tab icon; muted chats don't count."""
import sys, time, json, re, urllib.request, urllib.parse
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
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
    def state():
        title = page.title()
        m = re.match(r'\((\d+)\)', title)
        n = int(m.group(1)) if m else 0
        href = page.get_attribute('link[rel="icon"]', 'href')
        badge = None
        if href.startswith('data:'):
            svg = urllib.parse.unquote(href.split(',', 1)[1])
            badge = re.search(r'<text[^>]*>([^<]+)</text>', svg).group(1)
        return n, href, badge
    n, href, badge = state()
    print('start', n, badge)
    assert n > 0 and badge == (str(n) if n <= 9 else '9+'), (n, badge)
    cookies = '; '.join(f"{c['name']}={c['value']}" for c in page.context.cookies())
    def api(path, data=None):
        h = {'cookie': cookies}
        if data is not None: h['content-type'] = 'application/json'
        r = urllib.request.Request('http://localhost:3000' + path, data=json.dumps(data).encode() if data is not None else None, headers=h, method='POST' if data is not None else 'GET')
        return json.loads(urllib.request.urlopen(r).read() or b'null')
    convs = api('/api/conversations')
    unread = [c for c in convs if (c['unread'] or c['markedUnread']) and c['mutedUntil'] < time.time() * 1000]
    # muting a chat with unread messages takes it off the badge
    c = unread[0]; cnt = c['unread'] or 1
    api(f"/api/conversations/{c['id']}/flags", {'mutedUntil': int(time.time() * 1000) + 3600_000})
    until(lambda: state()[0] == n - cnt, 8, 'muted chat still counted')
    n2, _, badge2 = state()
    assert (badge2 == (str(n2) if n2 <= 9 else '9+')) if n2 else badge2 is None, (n2, badge2)
    print('muted ok', n2, badge2)
    # mute all the others with unread: plain icon again
    for c in unread[1:]:
        api(f"/api/conversations/{c['id']}/flags", {'mutedUntil': int(time.time() * 1000) + 3600_000})
    until(lambda: state()[1] == '/icon.svg', 8, 'icon not back to plain')
    assert page.title() == 'Messenger Web'
    print('plain icon ok')
    # unmute one: badge comes back
    api(f"/api/conversations/{unread[0]['id']}/flags", {'mutedUntil': 0})
    until(lambda: state()[2] == str(unread[0]['unread'] or 1), 8, 'badge not back')
    print('unmute ok')
    b.close()
print('ERRORS:', errors)
