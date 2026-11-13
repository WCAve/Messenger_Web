"""Missed WhatsApp messages: ones WAHA has but never sent as an event are fetched by the refresh button
and automatically after WhatsApp reconnects; read state follows the phone; nothing is stored twice."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
JAN, SANNE, GROUP, ME = '31655500001@c.us', '31655500002@c.us', '120363000000000001@g.us', '31600000009@c.us'
def wa(path, data=None):
    r = urllib.request.Request('http://127.0.0.1:8090' + path, data=json.dumps(data).encode() if data is not None else None, headers={'content-type': 'application/json'}, method='POST' if data is not None else 'GET')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
def missed_group(raw, body):
    return {'message': {'id': f'false_{GROUP}_{raw}_{SANNE}', 'timestamp': int(time.time()), 'from': GROUP, 'fromMe': False, 'to': ME,
                        'participant': SANNE, 'body': body, 'hasMedia': False, '_data': {'type': 'chat', 'notifyName': 'Sanne'}}}
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 1000})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Familie'), timeout=20000); time.sleep(10)  # history rounds done
    btn = page.locator('button[aria-label="Check WhatsApp for missed messages"]')
    assert btn.count() == 1
    # Two messages WAHA has, that never came as events (this app was down)
    wa('/mock/history', {'chat': JAN, 'id': f'false_{JAN}_MISSED0001', 'body': 'Gemist bericht één'})
    time.sleep(1.1)
    wa('/mock/history', {'chat': JAN, 'id': f'false_{JAN}_MISSED0002', 'body': 'Gemist bericht twee'})
    wa('/mock/history', missed_group('MISSED0003', 'Gemist in de groep'))
    assert 'Gemist bericht twee' not in page.locator(row('Jan Bakker')).inner_text()
    btn.click()
    page.wait_for_selector('.missed-note', timeout=20000)
    note = page.locator('.missed-note').inner_text(); print('note:', note)
    assert note.startswith('Found 3 missed messages in 2 chats'), note
    page.screenshot(path=S + '/e2e40.png', clip={'x': 0, 'y': 0, 'width': 420, 'height': 360})
    assert 'Gemist bericht twee' in page.locator(row('Jan Bakker')).inner_text()
    assert 'Gemist in de groep' in page.locator(row('Familie')).inner_text()
    page.click(row('Jan Bakker')); time.sleep(1)
    texts = page.locator('.msg .text, .bubble').all_inner_texts()
    assert sum('Gemist bericht één' in t for t in texts) == 1 and sum('Gemist bericht twee' in t for t in texts) == 1, texts
    # Again: nothing new, nothing doubled
    time.sleep(0.5); page.wait_for_selector('.missed-note', state='detached', timeout=15000)
    btn.click(); page.wait_for_selector('.missed-note', timeout=20000)
    note = page.locator('.missed-note').inner_text(); print('again:', note)
    assert note.startswith('Nothing missed'), note
    # A hole: missed while down, then a newer one came in live. The chat's newest message is here,
    # but the older one is still fetched.
    wa('/mock/history', {'message': {'id': f'false_{SANNE}_MISSED0005', 'timestamp': int(time.time()) - 120, 'from': SANNE, 'fromMe': False,
                                     'to': ME, 'body': 'Gat in het gesprek', 'hasMedia': False, '_data': {'type': 'chat', 'notifyName': 'Sanne'}}})
    wa('/mock/incoming', {'from': 'sanne', 'text': 'Live erna'}); time.sleep(1.5)
    page.wait_for_selector('.missed-note', state='detached', timeout=15000)
    btn.click(); page.wait_for_selector('.missed-note', timeout=20000)
    note = page.locator('.missed-note').inner_text(); print('hole:', note)
    assert note.startswith('Found 1 missed message in 1 chat'), note
    page.click(row('Sanne')); time.sleep(1)
    msgs = page.locator('.messages').inner_text()
    assert 'Gat in het gesprek' in msgs and msgs.index('Gat in het gesprek') < msgs.index('Live erna'), msgs[-300:]
    page.click(row('Jan Bakker')); time.sleep(0.5)
    # WhatsApp is down for a while and a message arrives meanwhile; after it's back, new messages come in
    # straight away (moving "last event" on) and only then the catch-up runs: it still looks back to
    # before the interruption. (The tests run with a 2-second margin instead of 10 minutes.)
    wa('/mock/incoming', {'from': 'jan', 'text': 'Laatste voor de storing'}); time.sleep(2.5)  # "last event" is saved at most every second in tests
    wa('/mock/status', {'status': 'STOPPED'}); time.sleep(3)
    wa('/mock/history', {'message': {'id': f'false_{JAN}_MISSED0004', 'timestamp': int(time.time()) - 20, 'from': JAN, 'fromMe': False, 'to': ME,
                                     'body': 'Terwijl alles uit stond', 'hasMedia': False, '_data': {'type': 'chat', 'notifyName': 'Jan'}}})
    wa('/mock/status', {'status': 'WORKING'})
    wa('/mock/incoming', {'from': 'jan', 'text': 'Eerste na de storing'})
    for _ in range(40):
        if 'Terwijl alles uit stond' in page.locator('.messages').inner_text(): break
        time.sleep(0.5)
    else:
        raise AssertionError('not fetched after reconnecting')
    print('missed messages ok')
    b.close()
print('ERRORS:', errors)
