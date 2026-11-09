"""WhatsApp HD photo/video pairs shown as one message (either order), reactions on the HD copy."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def req(base, path, data=None):
    r = urllib.request.Request(base + path, data=json.dumps(data).encode() if data is not None else None, headers={'content-type': 'application/json'}, method='POST' if data is not None else 'GET')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
wa = lambda path, data=None: req('http://127.0.0.1:8090', path + ('&' if '?' in path else '?') + 'x-api-key=test-waha-key', data)
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
raw = lambda mid: mid.split('_')[2]
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
    page.click(row('Familie')); page.wait_for_selector('.msg:has-text("jij toch")')
    n0 = page.locator('.msg').count()
    # 1. an HD video from your phone: the original, then the HD copy pointing to it
    a = wa('/mock/incoming', {'group': True, 'from': 'jan', 'text': '', 'media': 'video/mp4', 'extra': {'fromMe': True, 'data': {'size': 1000}}, 'payload': {'source': 'app'}})
    hd = wa('/mock/incoming', {'group': True, 'from': 'jan', 'text': '', 'media': 'video/mp4', 'extra': {'fromMe': True, 'data': {'size': 5000, 'associationType': 'HD_VIDEO_DUAL_UPLOAD', 'parentMsgKey': {'fromMe': True, 'id': raw(a['id'])}}}, 'payload': {'source': 'app'}})
    time.sleep(3)
    print('after HD pair:', page.locator('.msg').count() - n0)
    assert page.locator('.msg').count() == n0 + 1, page.locator('.msg').count() - n0
    # a reaction on the HD copy lands on the one message shown
    wa('/mock/event', {'event': 'message.reaction', 'payload': {'id': 'r1', 'from': '31655500001@c.us', 'participant': '31655500001@c.us', 'fromMe': False, 'reaction': {'text': '😂', 'messageId': hd['id']}}})
    page.wait_for_selector('.msg.out:last-of-type .reactions, .msg.out .reactions', timeout=6000)
    print('reaction ok')
    # 2. the other way round: the HD copy arrives first
    a2_raw = 'ABCDEF0123456789ABCDEF0123456789'
    wa('/mock/incoming', {'group': True, 'from': 'jan', 'text': '', 'media': 'image/jpeg', 'extra': {'fromMe': True, 'data': {'associationType': 'HD_IMAGE_DUAL_UPLOAD', 'parentMsgKey': {'id': a2_raw}}}, 'payload': {'source': 'app'}})
    time.sleep(1.5)
    wa('/mock/incoming', {'group': True, 'from': 'jan', 'text': '', 'media': 'image/jpeg', 'extra': {'fromMe': True}, 'payload': {'source': 'app', 'id': f'true_120363000000000001@g.us_{a2_raw}_31600000009@c.us'}})
    time.sleep(2.5)
    print('after reversed pair:', page.locator('.msg').count() - n0)
    assert page.locator('.msg').count() == n0 + 2
    page.reload(); page.wait_for_selector(row('Familie')); page.click(row('Familie')); page.wait_for_selector('.msg:has-text("jij toch")'); time.sleep(1)
    assert page.locator('.msg').count() == n0 + 2, page.locator('.msg').count() - n0
    print('hd pairs ok')
    b.close()
print('ERRORS:', errors)
