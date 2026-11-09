"""WhatsApp mute sync with the phone, quotes of earlier messages."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def wa(path, data=None):
    r = urllib.request.Request('http://127.0.0.1:8090' + path, data=json.dumps(data).encode() if data is not None else None, headers={'content-type': 'application/json'}, method='POST' if data is not None else 'GET')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 900})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Familie'), timeout=20000)
    # mute copied from the phone (after the history round refreshes the directory)
    end = time.time() + 15
    while time.time() < end and page.locator('.chat-row.muted:has-text("Familie")').count() == 0: time.sleep(0.3)
    assert page.locator('.chat-row.muted:has-text("Familie")').count() == 1, 'Familie not muted'
    assert page.locator('.chat-row.muted:has-text("Jan Bakker")').count() == 0
    print('mute sync ok')
    # a reply quoting a message with a mention shows names, not ids
    page.click(row('Familie')); page.wait_for_selector('.msg:has-text("jij toch")')
    hist = wa('/api/default/chats/120363000000000001%40g.us/messages?limit=20&x-api-key=test-waha-key')
    target = [m for m in hist if 'jij toch' in m['body']][0]
    wa('/mock/incoming', {'from': 'sanne', 'group': True, 'text': 'haha ja', 'extra': {'replyTo': {'id': target['id'], 'participant': '31655500001@c.us', 'body': target['body']}}})
    # and one quoting a message we don't have, with a lid mention of me
    wa('/mock/incoming', {'from': 'jan', 'group': True, 'text': 'en dit?', 'extra': {'replyTo': {'id': 'false_x_UNKNOWN123456', 'participant': '31655500002@c.us', 'body': '@99999999999999 kijk'}}})
    page.wait_for_selector('.msg:has-text("en dit?")')
    q1 = page.inner_text('.msg:has-text("haha ja") .quote'); q2 = page.inner_text('.msg:has-text("en dit?") .quote')
    print('quotes:', repr(q1), repr(q2))
    assert '@Sanne jij toch' in q1 and '3165' not in q1, q1
    assert '@You kijk' in q2 or '@Wouter kijk' in q2, q2
    b.close()
print('ERRORS:', errors)
