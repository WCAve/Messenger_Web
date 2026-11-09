"""Edit history: your own edits, incoming Signal and WhatsApp edits; "edited" opens earlier versions, oldest marked Original."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def req(base, path, data=None):
    r = urllib.request.Request(base + path, data=json.dumps(data).encode() if data is not None else None, headers={'content-type': 'application/json'}, method='POST' if data is not None else 'GET')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
wa = lambda path, data=None: req('http://127.0.0.1:8090', path + ('&' if '?' in path else '?') + 'x-api-key=test-waha-key', data)
sig = lambda path, data=None: req('http://127.0.0.1:8080', path, data)
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
def history(msg_sel):
    page.locator(msg_sel).last.locator('button.edited-btn').click()
    page.wait_for_selector('.edit-history li')
    items = page.locator('.edit-history li').all_inner_texts()
    page.keyboard.press('Escape')
    return items
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 1000})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Familie'), timeout=20000); time.sleep(5)
    # 1. your own message, edited twice (Signal)
    page.click(row('Alice de Vries')); page.wait_for_selector('.composer textarea')
    page.fill('textarea', 'Eerste versie'); page.keyboard.press('Enter'); time.sleep(1.2)
    for t in ['Tweede versie', 'Derde versie']:
        page.click('textarea'); page.keyboard.press('ArrowUp'); time.sleep(0.3)
        page.fill('textarea', t); page.keyboard.press('Enter'); time.sleep(1.2)
    items = history('.msg.out:has-text("Derde versie")')
    print('own:', items)
    assert len(items) == 3 and 'Derde versie' in items[0] and 'Tweede versie' in items[1] and 'Eerste versie' in items[2], items
    assert items[2].startswith('Original') and items[0].startswith('Now'), items
    # 2. Alice edits a message she sent
    ts = sig('/mock/incoming', {'from': 'alice', 'text': 'Zie je om 8'})['timestamp']
    page.wait_for_selector('.msg:has-text("Zie je om 8")')
    sig('/mock/envelope', {'from': 'alice', 'envelope': {'editMessage': {'targetSentTimestamp': ts, 'dataMessage': {'timestamp': ts + 5, 'message': 'Zie je om 9'}}}})
    page.wait_for_selector('.msg:has-text("Zie je om 9") .edited-btn', timeout=8000)
    items = history('.msg:has-text("Zie je om 9")'); print('signal:', items)
    assert 'Zie je om 8' in items[1] and items[1].startswith('Original')
    # 3. Jan edits a WhatsApp message
    page.click(row('Jan Bakker')); page.wait_for_selector('.msg:has-text("Kijk eens")')
    mm = wa('/mock/incoming', {'from': 'jan', 'text': 'Ik kom om 3 uur'})
    page.wait_for_selector('.msg:has-text("Ik kom om 3 uur")')
    wa('/mock/event', {'event': 'message.edited', 'payload': {'id': 'edit1', 'from': '31655500001@c.us', 'fromMe': False, 'body': 'Ik kom om 4 uur', 'editedMessageId': mm['id']}})
    page.wait_for_selector('.msg:has-text("Ik kom om 4 uur") .edited-btn', timeout=8000)
    items = history('.msg:has-text("Ik kom om 4 uur")'); print('whatsapp:', items)
    assert 'Ik kom om 3 uur' in items[1]
    page.locator('.msg:has-text("Ik kom om 4 uur") .edited-btn').click(); page.wait_for_selector('.edit-history li')
    page.screenshot(path=S + '/e2e37.png')
    print('edit history ok')
    b.close()
print('ERRORS:', errors)
