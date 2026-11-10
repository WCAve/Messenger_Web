"""Formatting (bold/italic/…) both ways, edit box, link preview, mentions, sidebar and chat search, disappearing messages."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def mock(path, data=None):
    req = urllib.request.Request('http://127.0.0.1:8080' + path, data=json.dumps(data).encode() if data is not None else None, headers={'content-type': 'application/json'}, method='POST' if data is not None else 'GET')
    return json.loads(urllib.request.urlopen(req).read() or b'null')
def sends(): return [x for x in mock('/mock/sent') if 'recipients' in x]
def wait(cond, t=10, msg='timeout'):
    end = time.time() + t
    while time.time() < end:
        v = cond()
        if v: return v
        time.sleep(0.2)
    raise AssertionError(msg)
shot = lambda page, n: page.screenshot(path=f'{S}/shots9/{n}.png')

# lots of history for bob, with one needle far back
now = int(time.time() * 1000)
for i in range(90):
    mock('/mock/incoming', {'from': 'bob', 'text': ('the needle in the haystack' if i == 5 else f'filler message {i}'), 'ts': now - (100 - i) * 60_000})

with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 1500, 'height': 950}); page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row')

    # 1. incoming formatting + spoiler
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg:has-text("This is")')
    bubble = page.locator('.msg:has-text("This is")')
    assert bubble.locator('strong').inner_text() == 'bold', bubble.inner_html()
    assert bubble.locator('em').inner_text() == 'italic'
    assert bubble.locator('.spoiler').count() == 1
    shot(page, '01-formatting')
    bubble.locator('.spoiler').click(); assert bubble.locator('.spoiler').count() == 0, 'spoiler not revealed'
    print('incoming formatting ok')

    # 2. sending formatting
    page.click('textarea'); page.keyboard.type('*hi* _there_ ~old~ `code` ||sec||'); page.keyboard.press('Enter')
    s = wait(lambda: [x for x in sends() if 'hi' in x['message'] and 'there' in x['message']], msg='no formatted send')[-1]
    print('sent:', s['message'], s.get('text_mode'))
    assert s['message'] == '**hi** *there* ~old~ `code` ||sec||' and s['text_mode'] == 'styled', s
    out = page.locator('.msg.out').last
    wait(lambda: out.locator('strong').count() == 1 and out.locator('code').count() == 1)
    # Ctrl+B wraps the selection
    page.click('textarea'); page.keyboard.type('wrap me'); page.keyboard.press('Shift+Home'); page.keyboard.press('Control+b')
    assert page.input_value('textarea') == '*wrap me*', page.input_value('textarea')
    page.fill('textarea', '')
    # literal markers are escaped
    page.click('textarea'); page.keyboard.type('2*3 = 6 and a_b'); page.keyboard.press('Enter')
    s = wait(lambda: [x for x in sends() if '2' in x['message'] and '6' in x['message']])[-1]
    assert s['message'] == '2*3 = 6 and a_b' and not s.get('text_mode'), s
    print('outgoing formatting ok')

    # 3. edit keeps formatting in the box
    time.sleep(1.5)
    page.click('textarea'); page.keyboard.press('ArrowUp'); time.sleep(0.3)
    print('edit box:', page.input_value('textarea'))
    assert page.input_value('textarea') == '2*3 = 6 and a_b'
    page.keyboard.press('Escape')

    # 4. link preview
    page.click('.chat-row:has-text("Carol")'); page.wait_for_selector('.link-preview')
    assert 'The best trails' in page.inner_text('.link-preview')
    wait(lambda: page.evaluate("(() => { const i = document.querySelector('.link-preview img'); return i && i.complete && i.naturalWidth > 0 })()"), msg='preview image')
    shot(page, '02-preview')
    print('preview ok')

    # 5. mentions in a group
    page.click('.chat-row:has-text("Weekend")'); page.wait_for_selector('.msg')
    page.click('textarea'); page.keyboard.type('hey @Ali'); page.wait_for_selector('.mention-suggest li')
    shot(page, '03-mention-suggest')
    page.keyboard.press('Enter'); page.keyboard.type('*now* please')
    assert page.input_value('textarea') == 'hey @Alice de Vries *now* please', page.input_value('textarea')
    page.keyboard.press('Enter')
    s = wait(lambda: [x for x in sends() if 'please' in x['message']])[-1]
    print('mention send:', json.dumps(s['message']), s.get('mentions'))
    assert s['message'] == 'hey ￼ **now** please' and s['mentions'] == [{'start': 4, 'length': 1, 'author': '+31600000001'}] or s['mentions'][0]['start'] == 4, s
    out = page.locator('.msg.out:has-text("please")').last
    wait(lambda: out.locator('.mention').count() == 1)
    assert out.locator('.mention').inner_text() == '@Alice de Vries', out.locator('.mention').inner_text()
    assert out.locator('strong').inner_text() == 'now'
    # incoming mention of me
    mock('/mock/incoming', {'from': 'bob', 'group': True, 'text': '￼ can you check?', 'extra': {'mentions': [{'name': '+31600000001', 'number': '+31600000001', 'uuid': '00000000-0000-4000-8000-000000000001', 'start': 0, 'length': 1}]}})
    time.sleep(1); shot(page, '04-mentions')
    print('mentions ok')

    # 6. search in the sidebar → older stretch of history → back to latest
    page.fill('.sidebar .search input', 'needle')
    page.wait_for_selector('.search-hit'); shot(page, '05-sidebar-search')
    page.click('.search-hit'); page.wait_for_selector('.msg:has-text("the needle")')
    wait(lambda: page.locator('.to-latest').count() == 1, msg='no jump-to-latest button')
    assert page.locator('.msg:has-text("filler message 89")').count() == 0, 'latest should not be loaded yet'
    shot(page, '06-jumped')
    page.click('.to-latest'); page.wait_for_selector('.msg:has-text("filler message 89")')
    print('sidebar search ok')
    page.fill('.sidebar .search input', '')

    # in-chat search
    page.click('button[aria-label="Search in this chat"]'); page.fill('.panel input', 'filler message 12')
    page.wait_for_selector('.search-results button'); shot(page, '07-chat-search')
    page.click('.search-results button >> nth=0'); page.wait_for_selector('.msg:has-text("filler message 12")')
    print('chat search ok')
    page.click('.panel-head button[aria-label=Close]')

    # 7. disappearing messages
    page.fill('.sidebar .search input', ''); page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg')
    page.click('.chat-head-main'); page.wait_for_selector('.timer-row select')
    page.select_option('.timer-row select', '30')
    page.wait_for_selector('.timer-badge'); page.wait_for_selector('.system-line:has-text("30 seconds")')
    put = [x for x in mock('/mock/sent') if x.get('method') == 'PUT' and '/v1/contacts/' in x.get('path', '')]
    assert put and put[-1]['expiration_in_seconds'] == 30, put
    shot(page, '08-timer')
    page.click('.panel-head button[aria-label=Close]')
    page.click('textarea'); page.keyboard.type('this will vanish'); page.keyboard.press('Enter')
    page.wait_for_selector('.msg.out:has-text("this will vanish") .expiry')
    mock('/mock/incoming', {'from': 'alice', 'text': 'poof in 4', 'extra': {'expiresInSeconds': 4}})
    page.wait_for_selector('.msg:has-text("poof in 4")')
    wait(lambda: page.locator('.msg:has-text("poof in 4")').count() == 0, t=12, msg='incoming did not disappear')
    assert page.locator('.deleted-show:has-text("This message disappeared")').count() >= 1
    print('incoming disappeared')
    wait(lambda: page.locator('.msg.out:has-text("this will vanish")').count() == 0, t=40, msg='outgoing did not disappear')
    print('outgoing disappeared')
    page.reload(); page.wait_for_selector('.chat-row'); page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg')
    assert page.locator('.msg.out:has-text("this will vanish")').count() == 0
    assert page.locator('.timer-badge:has-text("30s")').count() == 1, 'timer lost after the reply'
    # group timer
    page.click('.chat-row:has-text("Weekend")'); page.wait_for_selector('.msg'); page.click('.chat-head-main'); page.wait_for_selector('.timer-row select')
    page.select_option('.timer-row select', '604800'); page.wait_for_selector('.timer-badge:has-text("1w")')
    gput = [x for x in mock('/mock/sent') if x.get('method') == 'PUT' and '/v1/groups/' in x.get('path', '')]
    assert gput and gput[-1]['expiration_time'] == 604800, gput
    print('disappearing ok')
    b.close()
print('ERRORS:', errors)
