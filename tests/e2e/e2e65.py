"""Slash commands: the list while typing "/…", Enter/Tab to pick, text commands (shrug, me, mock, spoiler on
Signal and WhatsApp), making things (poll, GIF search), chat actions (pin, mute, timer, search, export, info,
unread), unknown commands, and "//" for a message that starts with "/"."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def get(port, path): return json.loads(urllib.request.urlopen(f'http://127.0.0.1:{port}{path}').read() or b'null')
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 900})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row:has-text("Alice")', timeout=20000); time.sleep(2)
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg')
    box = page.locator('textarea')
    def typed(t): box.click(); box.fill(''); page.keyboard.type(t)
    def conv(title):
        return page.evaluate("""async (t) => { const cs = await (await fetch('/api/conversations')).json(); return (cs.conversations ?? cs).find((x) => x.title.startsWith(t)); }""", title)
    def signal_sent(): return get(8080, '/mock/sent')

    # The list: all commands for "/", narrowed while typing; Enter on "/sh" completes it
    typed('/')
    page.wait_for_selector('.cmd-suggest'); n = page.locator('.cmd-suggest li').count(); print('commands for "/":', n); assert n >= 20
    page.screenshot(path=S + '/e2e65-list.png')
    page.keyboard.type('sh')
    names = page.locator('.cmd-suggest .cmd-name').all_inner_texts(); print('"/sh":', names); assert names[0].startswith('/shrug')
    page.keyboard.press('Enter'); assert box.input_value() == '/shrug ', box.input_value()
    page.wait_for_selector('.cmd-hint'); print('hint:', page.locator('.cmd-hint').inner_text())
    page.keyboard.type('geen *idee*'); page.keyboard.press('Enter')
    page.wait_for_selector('.msg.out:has-text("¯\\\\_(ツ)_/¯")'); print('shrug sent:', page.locator('.msg.out .body').last.inner_text())
    assert page.locator('.msg.out').last.locator('strong, b').first.inner_text() == 'idee'
    assert box.input_value() == ''

    typed('/me zucht diep'); page.keyboard.press('Escape'); page.keyboard.press('Enter')
    page.wait_for_selector('.msg.out:has-text("zucht diep") em'); print('/me:', page.locator('.msg.out').last.locator('em').inner_text())

    typed('/mock dit is echt een goed idee'); page.keyboard.press('Escape'); page.keyboard.press('Enter')
    for _ in range(20):
        last = page.locator('.msg.out .body').last.inner_text()
        if last.lower().startswith('dit is echt'): break
        time.sleep(0.2)
    print('/mock:', last); assert last.lower() == 'dit is echt een goed idee' and last != last.lower() and last != last.upper()

    typed('/spoiler Bruce Willis is dood'); page.keyboard.press('Escape'); page.keyboard.press('Enter')
    page.wait_for_selector('.msg.out .spoiler'); print('Signal spoiler: hidden behind a spoiler')

    # Making things
    typed('/poll Waar eten we? | Pizza | Sushi | Thai'); page.keyboard.press('Escape'); page.keyboard.press('Enter')
    page.wait_for_selector('.msg.out .poll-q:has-text("Waar eten we?")'); print('poll made')
    typed('/gif katten'); page.keyboard.press('Escape'); page.keyboard.press('Enter')
    page.wait_for_selector('.picker-panel'); v = page.locator('.picker-panel input').first.input_value(); print('GIF search:', v); assert v == 'katten'
    page.keyboard.press('Escape')

    # This chat
    typed('/pin'); page.keyboard.press('Enter'); time.sleep(0.8); assert conv('Alice')['pinnedAt'], 'not pinned'
    typed('/unpin'); page.keyboard.press('Enter'); time.sleep(0.8); assert not conv('Alice')['pinnedAt']
    typed('/mute 8h'); page.keyboard.press('Escape'); page.keyboard.press('Enter'); time.sleep(0.8)
    left = (conv('Alice')['mutedUntil'] - time.time() * 1000) / 3600_000; print(f'muted for {left:.2f} h'); assert 7.9 < left <= 8
    typed('/unmute'); page.keyboard.press('Enter'); time.sleep(0.8); assert conv('Alice')['mutedUntil'] < time.time() * 1000
    typed('/timer 1d'); page.keyboard.press('Escape'); page.keyboard.press('Enter'); time.sleep(0.8)
    print('timer:', conv('Alice')['expireTimer']); assert conv('Alice')['expireTimer'] == 86400
    typed('/search taart'); page.keyboard.press('Escape'); page.keyboard.press('Enter')
    page.wait_for_selector('input[aria-label="Search messages"]'); assert page.locator('input[aria-label="Search messages"]').input_value() == 'taart'
    typed('/info'); page.keyboard.press('Enter'); page.wait_for_selector('.panel:has-text("Contact info")'); print('info panel open')
    typed('/export'); page.keyboard.press('Enter'); page.wait_for_selector('.dialog:has-text("Export Alice"), [role=dialog]:has-text("Export Alice")'); print('export open')
    page.keyboard.press('Escape'); time.sleep(0.3)

    # Unknown command; "//" sends a slash
    typed('/vliegen'); page.keyboard.press('Enter')
    page.wait_for_selector('.form-error:has-text("no command /vliegen"), .composer-error:has-text("no command /vliegen"), :text("no command /vliegen")')
    assert box.input_value() == '/vliegen'
    typed('//etc/hosts is een bestand'); page.keyboard.press('Enter')
    page.wait_for_selector('.msg.out:has-text("/etc/hosts is een bestand")')
    assert page.locator('.msg.out .body').last.inner_text() == '/etc/hosts is een bestand'

    # WhatsApp: no /timer; a spoiler goes behind "Read more"
    page.click('.chat-row:has-text("Jan Bakker")'); page.wait_for_selector('.msg')
    typed('/ti'); time.sleep(0.3); assert not page.locator('.cmd-suggest li:has-text("/timer")').count(), '/timer offered on WhatsApp'
    typed('/spoiler Het is de butler'); page.keyboard.press('Escape'); page.keyboard.press('Enter')
    wa = None
    for _ in range(30):
        wa = [x for x in get(8090, '/mock/sent') if 'butler' in (x.get('text') or '')]
        if wa: break
        time.sleep(0.2)
    t = wa[0]['text']; print('WhatsApp spoiler:', repr(t[:40]), '…', len(t), 'characters')
    assert t.startswith('⚠️ Spoiler') and t.count('​') >= 3000 and t.endswith('Het is de butler')

    # /unread: the chat closes and shows as unread
    typed('/unread'); page.keyboard.press('Enter'); time.sleep(0.8)
    assert conv('Jan Bakker')['markedUnread'], 'not marked unread'
    assert not page.locator('textarea').count() or page.locator('.chat-head:has-text("Jan Bakker")').count() == 0
    assert not errors, errors
    b.close()
print('e2e65 ok')
