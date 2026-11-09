"""WhatsApp basics: chat list, history, send, reactions, edit/delete, attachments, groups, new chat, forward, links, menus, unlinking."""
import os, sys, time, json, urllib.request
from playwright.sync_api import sync_playwright

def goto(pg, title): pg.click(f'.settings-nav-row:has(strong:text-is("{title}"))')
def to_chats(pg):
    if pg.locator('button[aria-label="Back to settings"]').count(): pg.click('button[aria-label="Back to settings"]')
    pg.click('button[aria-label="Back to chats"]')
S = sys.argv[1]; errors = []
FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')  # test files kept in the repo
def req(base, path, data=None):
    r = urllib.request.Request(base + path, data=json.dumps(data).encode() if data is not None else None, headers={'content-type': 'application/json'}, method='POST' if data is not None else 'GET')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
wa = lambda path, data=None: req('http://127.0.0.1:8090', path, data)
sig = lambda path, data=None: req('http://127.0.0.1:8080', path, data)
def wsent(pred): return [x for x in wa('/mock/sent') if pred(x)]
def wait(cond, t=10, msg='timeout'):
    end = time.time() + t
    while time.time() < end:
        v = cond()
        if v: return v
        time.sleep(0.2)
    raise AssertionError(msg)
shot = lambda page, n: page.screenshot(path=f'{S}/shots11/{n}.png')
row = lambda title: f'.chat-row-wrap:has(.chat-title:text-is("{title}"))'

with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 1500, 'height': 950}); page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: m.type == 'error' and '404' not in m.text and errors.append(m.text))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Jan Bakker'), timeout=15000)
    assert page.locator(row('Jan Bakker') + ' .net-whatsapp').count() == 1
    assert page.locator(row('Alice de Vries') + ' .net-signal').count() == 1
    assert page.locator(row('Privé Pieter')).count() == 1
    page.wait_for_selector(row('Familie'), timeout=20000)  # its history reaches WAHA a few seconds after linking
    # a group first seen through a new message gets its name right away
    wa('/mock/incoming', {'from': 'jan', 'group': 'buren', 'text': 'Feestje bij nummer 12!'})
    page.wait_for_selector(row('Buren'), timeout=8000)
    assert page.inner_text(row('Jan Bakker') + ' .badge') == '2'
    assert page.locator(row('WhatsApp group')).count() == 0, 'a group without a name'
    shot(page, '01-list')
    print('chat list ok')

    # history, formatting, media, quote; opening marks read on WhatsApp
    page.click(row('Jan Bakker')); page.wait_for_selector('.msg:has-text("Kijk eens")')
    f = page.locator('.msg:has-text("Dit is")')
    assert f.locator('strong').inner_text() == 'vet' and f.locator('em').inner_text() == 'schuin'
    wait(lambda: page.evaluate("[...document.querySelectorAll('.msg img')].some(i => i.complete && i.naturalWidth > 0)"), msg='image')
    assert page.locator('.msg .quote:has-text("Hoi! Kom je zaterdag ook?")').count() == 1
    wait(lambda: wsent(lambda x: x['path'] == '/api/sendSeen' and x['chatId'] == '31655500001@c.us'), msg='no sendSeen')
    shot(page, '02-jan')
    print('history ok')

    # sending with formatting; ticks; reply and typing
    page.click('textarea'); page.keyboard.type('Tot *zaterdag* dan'); page.keyboard.press('Enter')
    s = wait(lambda: wsent(lambda x: x['path'] == '/api/sendText' and 'zaterdag' in x['text']))[-1]
    assert s['text'] == 'Tot *zaterdag* dan', s
    out = page.locator('.msg.out:has-text("Tot zaterdag dan")').last
    wait(lambda: out.locator('.status.read').count() == 1, msg='no read ticks')
    assert out.locator('strong').inner_text() == 'zaterdag'
    wait(lambda: 'typing' in page.inner_text('.chat-head'), t=6, msg='no typing')
    page.wait_for_selector('.msg:has-text("Ontvangen")', timeout=8000)
    assert page.locator('.msg.out:has-text("Tot zaterdag dan")').count() == 1, 'own message duplicated'
    print('send ok')

    # sticker tab hidden, picker still works
    # WhatsApp chats get the same picker as Signal (Signal packs included)
    page.click('button[aria-label=Emoji]'); page.click('.picker-tabs button:has-text("Stickers")'); page.wait_for_selector('nav.sticker-packs button[title="Blob faces"]'); assert page.locator('nav.sticker-packs button[aria-label="Send an image as a sticker"]').count() == 1; page.click('button[aria-label=Emoji]')

    # reaction both ways
    m = page.locator('.msg:has-text("Hoi! Kom je")').first; m.hover(); m.locator('button[aria-label=React]').click(); page.click('.quick-react button:has-text("👍")')
    r = wait(lambda: wsent(lambda x: x['path'] == '/api/reaction'))[-1]; assert r['reaction'] == '👍' and r['messageId'].startswith('false_31655500001@c.us_'), r
    hoi = [x for x in wa('/api/default/chats/31655500001%40c.us/messages?limit=50&x-api-key=test-waha-key') if 'Hoi' in x['body']][0]
    wa('/mock/event', {'event': 'message.reaction', 'payload': {'id': 'r1', 'from': '31655500001@c.us', 'participant': '31655500001@c.us', 'fromMe': False, 'reaction': {'text': '😂', 'messageId': hoi['id']}}})
    wait(lambda: '😂' in page.inner_text('.msg:has-text("Hoi! Kom je") .reactions'))
    print('reactions ok')

    # edit and delete
    time.sleep(0.5)
    page.click('textarea'); page.keyboard.press('ArrowUp'); time.sleep(0.3)
    assert page.input_value('textarea') == 'Tot *zaterdag* dan', page.input_value('textarea')
    page.fill('textarea', 'Tot *zondag* dan'); page.keyboard.press('Enter')
    e = wait(lambda: wsent(lambda x: x['method'] == 'PUT' and '/messages/' in x['path']))[-1]
    assert e['text'] == 'Tot *zondag* dan', e
    page.on('dialog', lambda d: d.accept())
    m = page.locator('.msg.out:has-text("Tot zondag dan")').last; m.hover(); m.locator('button[aria-label="Delete for everyone"]').click()
    wait(lambda: wsent(lambda x: x['method'] == 'DELETE' and '/messages/' in x['path']))
    # incoming revoke
    mm = wa('/mock/incoming', {'from': 'jan', 'text': 'oeps verkeerde chat'})
    page.wait_for_selector('.msg:has-text("oeps verkeerde chat")')
    # WEBJS: "after" is the deletion notice, "before" the deleted message, revokedMessageId its short id
    raw = mm['_data']['id']['id']
    wa('/mock/event', {'event': 'message.revoked', 'payload': {'after': {'id': 'false_31655500001@c.us_NOTICE1234', '_data': {'protocolMessageKey': {'id': raw}}}, 'before': {'id': mm['id']}, 'revokedMessageId': raw}})
    wait(lambda: page.locator('.msg:has-text("oeps verkeerde chat")').count() == 0)
    print('edit/delete ok')

    # attachment
    page.set_input_files('input[type=file][multiple]', f'{FIX}/photo.png'); page.click('textarea'); page.keyboard.type('foto noreply'); page.keyboard.press('Enter')
    a = wait(lambda: wsent(lambda x: x['path'] == '/api/sendImage'))[-1]
    assert a['caption'] == 'foto noreply' and a['file']['mimetype'] == 'image/png', a
    print('attachment ok')

    # group: mention, poll
    page.click(row('Familie')); page.wait_for_selector('.poll')
    assert page.locator('.mention:has-text("@Sanne")').count() >= 1
    assert page.locator('.poll button:has-text("End poll")').count() == 0
    page.locator('.poll-option:has-text("15:00")').click()
    v = wait(lambda: wsent(lambda x: x['path'] == '/api/sendPollVote'))[-1]; assert v['votes'] == ['15:00'], v
    page.click('textarea'); page.keyboard.type('@Ja'); page.wait_for_selector('.mention-suggest li'); page.keyboard.press('Enter'); page.keyboard.type('kom je? noreply'); page.keyboard.press('Enter')
    s = wait(lambda: wsent(lambda x: x['path'] == '/api/sendText' and 'kom je?' in x['text']))[-1]
    assert s['text'] == '@31655500001 kom je? noreply' and s['mentions'] == ['31655500001@c.us'], s
    # group ticks: delivered once someone has it, read only once both members have read it
    g = page.locator('.msg.out:has-text("kom je? noreply")').last
    wait(lambda: g.locator('.status.delivered').count() == 1, msg='no delivered ticks')
    time.sleep(0.5); assert g.locator('.status.read').count() == 0, 'read after one reader'
    wait(lambda: g.locator('.status.read').count() == 1, msg='no read ticks after both read')
    g.hover(); g.locator('button[aria-label="Message info"]').click(); page.wait_for_selector('.panel:has-text("Read by")')
    wait(lambda: 'Sanne' in page.inner_text('.panel') and 'Jan Bakker' in page.inner_text('.panel'), msg='read-by list'); info = page.inner_text('.panel'); assert 'Jan Bakker' in info and 'Sanne' in info, info
    page.click('.panel-head button[aria-label=Close]')
    assert wsent(lambda x: x.get('path', '').endswith('/subscribe')), 'no presence subscription'
    shot(page, '03-group')
    print('group ok')

    # new WhatsApp chat by number
    page.click('button[aria-label="New WhatsApp chat"]'); page.fill('input[aria-label="Name or phone number"]', '+31655500077')
    page.click('.chat-row:has-text("on WhatsApp")'); page.wait_for_selector('.chat-head:has-text("+31655500077")')
    page.click('textarea'); page.keyboard.type('Hallo nieuw nummer'); page.keyboard.press('Enter')
    wait(lambda: wsent(lambda x: x['path'] == '/api/sendText' and x['chatId'] == '31655500077@c.us'))
    print('new chat ok')

    # forward a Signal message into WhatsApp
    page.click(row('Carol')); page.wait_for_selector('.link-preview')
    m = page.locator('.msg:has(.link-preview)').first; m.hover(); m.locator('button[aria-label=Forward]').click()
    page.click('.forward-row:has-text("Jan Bakker")'); page.click('.dialog button:has-text("Forward")')
    wait(lambda: wsent(lambda x: 'trail-guide' in str(x.get('text', ''))))
    print('forward ok')

    # settings: unlink and link again
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Settings")'); goto(page, 'WhatsApp')
    page.wait_for_selector('.settings-section:has-text("WhatsApp") dd:has-text("+31600000009")')
    shot(page, '04-settings')
    page.click('button:has-text("Unlink WhatsApp")')
    page.wait_for_selector('.wa-qr'); wait(lambda: page.evaluate("document.querySelector('.wa-qr').naturalWidth > 0"))
    shot(page, '05-qr')
    page.wait_for_selector('.settings-section:has-text("WhatsApp") dd:has-text("+31600000009")', timeout=15000)
    print('link ok')
    # menus: one at a time, closed by a click elsewhere
    to_chats(page)
    page.hover(row('Jan Bakker')); page.click(row('Jan Bakker') + ' .row-menu-btn'); page.wait_for_selector('.row-menu')
    page.click('button[aria-label="Chat options"]'); page.wait_for_selector('.head-menu')
    assert page.locator('.row-menu').count() == 0, 'two menus open'
    page.mouse.click(900, 400); time.sleep(0.2)
    assert page.locator('.menu[role=menu]').count() == 0, 'menu stayed open'
    page.click('button[aria-label="Chat options"]'); page.wait_for_selector('.head-menu')
    page.click('button[aria-label=Menu]'); time.sleep(0.2)
    assert page.locator('.head-menu').count() == 0 and page.locator('.menu[role=menu]').count() == 1
    page.keyboard.press('Escape'); time.sleep(0.2); assert page.locator('.menu[role=menu]').count() == 0
    # the button only shows on hover, and the active chat's row doesn't show it on its own
    page.mouse.move(900, 400); time.sleep(0.3)
    op = page.evaluate("getComputedStyle(document.querySelector('.chat-row-wrap.active .row-menu-btn') || document.querySelector('.row-menu-btn')).opacity")
    assert op == '0', op
    print('menus ok')
    b.close()
print('ERRORS:', errors)
