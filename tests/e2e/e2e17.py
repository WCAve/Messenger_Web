"""WhatsApp: number check in New chat, pins from the phone, view-once, group event lines, native forwarding, block/unblock."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright

def goto(pg, title): pg.click(f'.settings-nav-row:has(strong:text-is("{title}"))')
def to_chats(pg):
    if pg.locator('button[aria-label="Back to settings"]').count(): pg.click('button[aria-label="Back to settings"]')
    pg.click('button[aria-label="Back to chats"]')
S = sys.argv[1]; errors = []
def wa(path, data=None):
    r = urllib.request.Request('http://127.0.0.1:8090' + path, data=json.dumps(data).encode() if data is not None else None, headers={'content-type': 'application/json'}, method='POST' if data is not None else 'GET')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
JAN = '31655500001@c.us'; SANNE = '31655500002@c.us'; GROUP = '120363000000000001@g.us'; ME = '31600000009@c.us'
def until(fn, secs=10, msg='timeout'):
    end = time.time() + secs
    while time.time() < end:
        if fn(): return
        time.sleep(0.3)
    raise AssertionError(msg)
def ev(event, payload): wa('/mock/event', {'event': event, 'payload': payload})
def notice(kind, typ, author, recips, body='', nid=None):
    nid = nid or f'false_{GROUP}_N{int(time.time()*1000)}_{typ}'
    ev('engine.event', {'event': kind, 'data': {'id': {'_serialized': nid, 'remote': GROUP}, 'chatId': GROUP, 'type': typ, 'author': author, 'recipientIds': recips, 'body': body, 'timestamp': int(time.time())}})
    return nid

with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 900})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('dialog', lambda d: d.accept())
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Familie'), timeout=20000); time.sleep(8)

    # 6. number check
    page.click('button[aria-label="New WhatsApp chat"]'); page.fill('input[aria-label="Name or phone number"]', '+31699990000')
    page.click('.chat-row:has-text("on WhatsApp")')
    page.wait_for_selector("text=isn't on WhatsApp", timeout=8000)
    page.fill('input[aria-label="Name or phone number"]', '+31699991234')
    page.click('.chat-row:has-text("on WhatsApp")'); page.wait_for_selector('.chat-head:has-text("+31699991234")')
    assert any(s['path'] == '/api/contacts/check-exists' and s['phone'] == '31699990000' for s in wa('/mock/sent'))
    print('number check ok')

    # 7. pins copied from the phone
    wa('/mock/pin', {'jid': JAN, 'pinned': True})
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Settings")'); goto(page, 'WhatsApp')
    page.click('button:has-text("Refresh contacts and groups")'); page.wait_for_selector('text=Contacts and groups updated', timeout=15000)
    to_chats(page)
    until(lambda: page.locator(row('Jan Bakker') + ' .row-icons svg[aria-label="Pinned"], ' + row('Jan Bakker') + ' .row-icons [title="Pinned"]').count() > 0 or 'Pinned' in (page.locator(row('Jan Bakker')).inner_html()), 10, 'pin not copied')
    wa('/mock/pin', {'jid': JAN, 'pinned': False})
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Settings")'); goto(page, 'WhatsApp')
    page.click('button:has-text("Refresh contacts and groups")'); page.wait_for_selector('text=Contacts and groups updated', timeout=15000)
    to_chats(page)
    until(lambda: 'Pinned' not in page.locator(row('Jan Bakker')).inner_html(), 10, 'unpin not copied')
    print('pins ok')

    # 8a. view once
    wa('/mock/incoming', {'from': 'jan', 'text': '', 'media': 'image/jpeg', 'extra': {'data': {'isViewOnce': True, 'type': 'image'}}})
    page.click(row('Jan Bakker')); page.wait_for_selector('.msg:has-text("View-once photo")', timeout=5000)
    assert page.locator('.msg:has-text("View-once photo") img').count() == 0
    print('view once ok')
    # 8b. group system lines (live, through the engine event), deduplicated with the history message
    page.click(row('Familie')); page.wait_for_selector('.msg:has-text("jij toch")')
    notice('group_join', 'add', JAN, [SANNE])
    page.wait_for_selector('.system-line:has-text("Jan Bakker added Sanne")', timeout=5000)
    notice('group_leave', 'leave', SANNE, [SANNE])
    page.wait_for_selector('.system-line:has-text("Sanne left")', timeout=5000)
    notice('group_admin_changed', 'promote', SANNE, [ME])
    page.wait_for_selector(".system-line:has-text(\"You're now an admin\")", timeout=5000)
    nid = notice('group_update', 'subject', JAN, [], 'Familie 🎉')
    page.wait_for_selector('.system-line:has-text("Jan Bakker changed the group name to “Familie 🎉”")', timeout=5000)
    wa('/mock/incoming', {'from': 'jan', 'group': True, 'text': 'Familie 🎉', 'payload': {'id': nid}, 'extra': {'data': {'type': 'gp2', 'subtype': 'subject', 'author': JAN}}})
    time.sleep(1)
    assert page.locator('.system-line:has-text("changed the group name")').count() == 1, 'duplicate group line'
    notice('group_update', 'announce', ME, [], 'on')
    page.wait_for_selector('.system-line:has-text("You changed this group\'s settings to allow only admins")', timeout=5000)
    print('group lines ok')

    # 9. forwarded label in, native forward out
    wa('/mock/incoming', {'from': 'sanne', 'text': 'Doorgestuurd grapje', 'extra': {'data': {'isForwarded': True, 'forwardingScore': 1}}})
    wa('/mock/incoming', {'from': 'sanne', 'text': 'Kettingbrief', 'extra': {'data': {'isForwarded': True, 'forwardingScore': 7}}})
    page.click(row('Sanne')); page.wait_for_selector('.msg:has-text("Kettingbrief")')
    assert page.locator('.msg:has-text("Doorgestuurd grapje") .forwarded:text-is("Forwarded")').count() == 1
    assert page.locator('.msg:has-text("Kettingbrief") .forwarded:has-text("Forwarded many times")').count() == 1
    page.hover('.msg:has-text("Doorgestuurd grapje") .bubble'); page.click('.msg:has-text("Doorgestuurd grapje") button[aria-label=Forward]')
    page.click('.forward-row:has-text("Jan Bakker")'); page.click('.dialog-actions button.primary')
    time.sleep(1.5)
    fw = [s for s in wa('/mock/sent') if s['path'] == '/api/forwardMessage']
    assert fw and fw[-1]['chatId'] == JAN and 'false_' in fw[-1]['messageId'], fw
    # to Signal it's a copy
    page.hover('.msg:has-text("Doorgestuurd grapje") .bubble'); page.click('.msg:has-text("Doorgestuurd grapje") button[aria-label=Forward]')
    page.click('.forward-row:has-text("Alice")'); page.click('.dialog-actions button.primary')
    page.click(row('Jan Bakker')); page.wait_for_selector('.msg.out:has-text("Doorgestuurd grapje") .forwarded')
    page.click(row('Alice de Vries')); page.wait_for_selector('.msg:has-text("Doorgestuurd grapje")')
    assert page.locator('.msg:has-text("Doorgestuurd grapje") .forwarded').count() == 0
    print('forwarding ok')

    # 10. block / unblock
    page.click(row('Sanne')); page.click('.chat-head-main')
    page.click('button.panel-action:has-text("Block Sanne")')
    page.wait_for_selector('.blocked-bar', timeout=5000)
    assert any(s['path'] == '/api/contacts/block' and s['contactId'] == SANNE for s in wa('/mock/sent'))
    page.wait_for_selector('button.panel-action:has-text("Unblock Sanne")')
    page.reload(); page.wait_for_selector(row('Sanne')); page.click(row('Sanne')); page.wait_for_selector('.blocked-bar')
    page.click('.blocked-bar button'); page.wait_for_selector('.composer textarea, .composer [contenteditable]', timeout=5000)
    assert any(s['path'] == '/api/contacts/unblock' for s in wa('/mock/sent'))
    print('block ok')
    page.screenshot(path=S + '/e2e17.png')
    b.close()
print('ERRORS:', errors)
