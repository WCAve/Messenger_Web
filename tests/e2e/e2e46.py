"""Exporting chats: pick several (⋮ → Export chats) or one (chat info), all four formats, photos in a media
folder and small ones built into the web page; deleted and edited show only as such; a date range."""
import sys, time, json, zipfile, io, csv, re, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def sig(path, data):
    r = urllib.request.Request('http://127.0.0.1:8080' + path, data=json.dumps(data).encode(), headers={'content-type': 'application/json'}, method='POST')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 1000}, accept_downloads=True)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Jan Bakker'), timeout=20000); time.sleep(8)
    # Alice: a deleted message and an edited one
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.img-btn')
    ts = int(time.time() * 1000)
    sig('/mock/incoming', {'from': 'alice', 'text': 'Geheim, niet exporteren', 'ts': ts}); page.wait_for_selector('.msg:has-text("Geheim, niet")')
    sig('/mock/incoming', {'from': 'alice', 'text': '', 'extra': {'remoteDelete': {'timestamp': ts}}}); page.wait_for_selector('.deleted-show')
    page.click('textarea'); page.keyboard.type('Typfoutt'); page.keyboard.press('Enter'); page.wait_for_selector('.msg.out:has-text("Typfoutt")'); time.sleep(1.5)
    page.keyboard.press('ArrowUp'); page.wait_for_selector('.reply-preview.editing'); time.sleep(0.3); page.keyboard.press('Backspace'); time.sleep(0.3); page.keyboard.press('Enter')
    page.wait_for_selector('.msg.out:has-text("edited")', timeout=10000)

    def export(open_it, pick=(), dates=None, media=True):
        open_it()
        page.wait_for_selector('.dialog.export, .dialog:has(.export)')
        for t in pick:
            page.click(f'.export-chat:has(.export-chat-title:text-is("{t}")) input')
        if not media: page.click('.export-option:has-text("Photos and files") input')
        if dates:
            page.fill('input[aria-label="From"]', dates[0]); page.fill('input[aria-label="To"]', dates[1])
        with page.expect_download(timeout=60000) as dl:
            page.click('.dialog-actions button.primary')
        path = dl.value.path(); name = dl.value.suggested_filename
        page.wait_for_selector('.export-done'); print('done:', page.locator('.export-done').inner_text())
        page.screenshot(path=S + f'/e2e46-{len(pick)}.png')
        page.click('.dialog-actions button:has-text("Close")')
        return name, zipfile.ZipFile(path)

    # Several chats from the menu
    name, z = export(lambda: (page.click('button[aria-label=Menu]'), page.click('[role=menuitem]:has-text("Export chats")')), pick=('Alice de Vries', 'Familie'))
    names = z.namelist(); print(name, len(names)); print('\n'.join(n for n in names if 'media/' not in n))
    assert re.match(r'Messenger export \d{4}-\d\d-\d\d\.zip', name)
    assert z.testzip() is None
    root = names[0].split('/')[0]
    a, f = f'{root}/Alice de Vries (Signal)', f'{root}/Familie (WhatsApp)'
    for d in (a, f):
        for ext in ('txt', 'html', 'json', 'csv'): assert f'{d}/chat.{ext}' in names, (d, ext)
    txt = z.read(f'{a}/chat.txt').decode()
    print(txt[-400:])
    assert re.search(r'^\d\d-\d\d-\d{4} \d\d:\d\d - Alice de Vries: This message was deleted$', txt, re.M), 'deleted line'
    assert 'Geheim' not in txt and 'Typfoutt' not in txt
    assert re.search(r'You: Typfout <This message was edited>$', txt, re.M), 'edited'
    assert '(file attached)' in txt
    data = json.loads(z.read(f'{a}/chat.json'))
    assert data['chat']['network'] == 'signal' and data['messages']
    dele = [m for m in data['messages'] if m.get('deleted')]; assert dele and dele[-1]['text'] is None
    photo = [x for m in data['messages'] for x in (m.get('attachments') or []) if x['type'] == 'Photo' and x['file']][0]
    assert f"{a}/{photo['file']}" in names and len(z.read(f"{a}/{photo['file']}")) > 100, photo
    html = z.read(f'{a}/chat.html').decode()
    assert 'data:image/' in html and 'href="media/' in html and 'This message was deleted' in html and 'Geheim' not in html and 'edited · ' in html
    rows = list(csv.reader(io.StringIO(z.read(f'{a}/chat.csv').decode('utf-8-sig'))))
    assert rows[0][:5] == ['Date', 'Time', 'Sender', 'From me', 'Text'] and len(rows) == len(data['messages']) + 1
    fam = json.loads(z.read(f'{f}/chat.json')); print('familie messages:', len(fam['messages']))
    assert fam['chat']['kind'] == 'group' and len(fam['messages']) > 1
    # look at the web page as someone who unpacked it would
    page2 = b.new_page()
    page2.set_content(html); time.sleep(0.5)
    page2.screenshot(path=S + '/e2e46-html.png', full_page=False)
    assert page2.locator('.bubble img').count() >= 1 and page2.locator('.row.out').count() >= 1
    page2.close()
    print('several chats ok')

    # One chat from chat info, without photos, only today
    today = time.strftime('%Y-%m-%d')
    name, z = export(lambda: (page.click('.chat-head-main'), page.click('.panel-action:has-text("Export chat")')), dates=(today, today), media=False)
    names = z.namelist(); print(names)
    assert not any('/media/' in n for n in names)
    data = json.loads(z.read([n for n in names if n.endswith('chat.json')][0]))
    assert all(m['sentAt'][:10] >= time.strftime('%Y-%m-%d', time.gmtime(time.time() - 86400)) for m in data['messages'])
    assert any('Typfout' == m.get('text') for m in data['messages'])
    txt = z.read([n for n in names if n.endswith('chat.txt')][0]).decode()
    print('one chat ok')
    b.close()
print('ERRORS:', errors)
