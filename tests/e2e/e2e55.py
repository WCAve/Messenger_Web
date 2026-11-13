"""Reply privately: on someone's group message, opens your one-to-one chat with them with that message in
the reply bar; sent as a reply to the group message (WhatsApp: its id; Signal: its time + author + text).
The quote names the group and clicking it opens the group there. Private replies from others too."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def post(port, path, data=None):
    r = urllib.request.Request(f'http://127.0.0.1:{port}' + path, data=json.dumps(data).encode() if data is not None else None, headers={'content-type': 'application/json'}, method='POST' if data is not None else 'GET')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 900})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Familie'), timeout=20000); time.sleep(6)
    title = lambda: page.locator('.chat-head-main .chat-title, .chat-head-main strong, .chat-head-main h2').first.inner_text()

    def reply_privately(group, text_in_msg, answer):
        page.click(row(group)); m = page.locator(f'.msg:has-text("{text_in_msg}")').last
        m.wait_for(); m.hover(); m.locator('button[aria-label="Reply privately"]').click()
        page.wait_for_selector('.reply-preview:has-text("Replying privately to")', timeout=10000)
        bar = page.locator('.reply-preview').inner_text(); print('bar:', bar.replace('\n', ' | '))
        assert group in bar and text_in_msg in bar
        page.click('textarea'); page.keyboard.type(answer); page.keyboard.press('Enter')
        mine = page.locator(f'.msg.out:has-text("{answer}")'); mine.wait_for()
        q = mine.locator('.quote').inner_text(); print('quote:', q.replace('\n', ' | ')); assert group in q and text_in_msg in q
        return mine

    # Signal: Bob's message in Weekend plans
    ts = int(time.time() * 1000)
    post(8080, '/mock/incoming', {'from': 'bob', 'group': True, 'text': 'Wie rijdt er zaterdag?', 'ts': ts})
    time.sleep(1)
    mine = reply_privately('Weekend plans', 'Wie rijdt er zaterdag?', 'Ik kan rijden, privé gezegd')
    print('signal chat:', title())
    for _ in range(40):
        sent = [x for x in post(8080, '/mock/sent') if 'privé gezegd' in str(x.get('message'))]
        if sent: break
        time.sleep(0.25)
    sent = sent[-1]
    print('signal send:', {k: sent.get(k) for k in ('recipients', 'quote_timestamp', 'quote_author', 'quote_message')})
    assert sent['quote_timestamp'] == ts and sent['quote_author'] in ('+31622222222', 'bbbbbbbb-0000-4000-8000-00000000000b') and sent['quote_message'] == 'Wie rijdt er zaterdag?'
    assert sent['recipients'] in (['+31622222222'], ['bbbbbbbb-0000-4000-8000-00000000000b'])
    mine.locator('.quote').click(); time.sleep(1)
    assert page.locator('.msg:has-text("Wie rijdt er zaterdag?")').count() and 'Weekend plans' in page.locator('.chat-head-main').inner_text()
    print('signal ok')

    # WhatsApp: Sanne's message in Familie
    gm = post(8090, '/mock/incoming', {'from': 'sanne', 'group': True, 'text': 'Wie neemt de taart mee?'})
    post(8090, '/mock/history', {'message': gm})  # WhatsApp Web has it (the mock only keeps what's put in its history)
    time.sleep(1)
    reply_privately('Familie', 'Wie neemt de taart mee?', 'Ik neem hem mee')
    for _ in range(40):
        sent = [x for x in post(8090, '/mock/sent') if x['path'] == '/api/sendText' and 'Ik neem hem mee' in str(x.get('text'))]
        if sent: break
        time.sleep(0.25)
    sent = sent[-1]
    print('whatsapp send:', {k: sent.get(k) for k in ('chatId', 'reply_to')})
    assert sent['chatId'] == '31655500002@c.us' and sent.get('reply_to') == gm['id'], sent
    print('whatsapp ok')

    # Someone privately replies to a group message (here: Jan, to Sanne's message in Familie)
    page.click(row('Jan Bakker'))
    post(8090, '/mock/incoming', {'from': 'jan', 'text': 'Lekker! (privé)', 'extra': {'replyTo': {'id': gm['id'], 'participant': '31655500002@c.us', 'body': 'Wie neemt de taart mee?'}}})
    page.wait_for_selector('.msg:has-text("Lekker! (privé)") .quote', timeout=10000)
    q = page.locator('.msg:has-text("Lekker! (privé)") .quote').inner_text(); print('incoming private reply quote:', q.replace('\n', ' | '))
    page.screenshot(path=S + '/e2e55.png')
    assert 'Familie' in q and 'Wie neemt de taart mee?' in q
    page.locator('.msg:has-text("Lekker! (privé)") .quote').click(); time.sleep(1)
    assert 'Familie' in page.locator('.chat-head-main').inner_text()
    print('incoming ok')
    b.close()
print('ERRORS:', errors)
