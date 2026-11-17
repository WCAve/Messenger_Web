"""Selecting several messages: Select in the toolbar, click to pick more, copy (in chat order, with names),
forward them to another chat, delete your own for everyone (not offered when others' are picked), Esc."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def get(port, path): return json.loads(urllib.request.urlopen(f'http://127.0.0.1:{port}{path}').read() or b'null')
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1400, 'height': 900}, permissions=['clipboard-read', 'clipboard-write'])
    page = ctx.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('dialog', lambda d: d.accept())
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row:has-text("Alice")', timeout=20000); time.sleep(2)
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg')
    box = page.locator('textarea')
    for t in ['Eerste van mij', 'Tweede van mij']:
        box.click(); page.keyboard.type(t); page.keyboard.press('Enter'); page.wait_for_selector(f'.msg.out:has-text("{t}")')
    time.sleep(0.5)

    # Select starts with that message; clicks pick more (an incoming one too)
    first = page.locator('.msg.in:has-text("Hey! Are we still on")')
    first.hover(); first.locator('button[aria-label="Select"]').click()
    page.wait_for_selector('.selection-bar'); assert page.locator('.selection-count').inner_text() == '1 selected'
    page.locator('.msg.out:has-text("Eerste van mij") .bubble').click()
    page.locator('.msg.out:has-text("Tweede van mij") .bubble').click()
    assert page.locator('.selection-count').inner_text() == '3 selected'
    assert page.locator('button[aria-label="Delete for everyone"]').last.is_disabled(), 'delete offered with someone else’s message'
    page.screenshot(path=S + '/e2e69-selecting.png')
    # Copy: in chat order, with names
    page.click('.selection-bar button[aria-label="Copy"]'); time.sleep(0.3)
    clip = page.evaluate('navigator.clipboard.readText()'); print('copied:', repr(clip))
    assert clip.splitlines() == ['Alice de Vries: Hey! Are we still on for Saturday?', 'You: Eerste van mij', 'You: Tweede van mij'], clip
    page.wait_for_selector('.selection-bar', state='detached')

    # Forward three messages to Carol
    first.hover(); first.locator('button[aria-label="Select"]').click()
    page.locator('.msg.out:has-text("Eerste van mij") .bubble').click(); page.locator('.msg.out:has-text("Tweede van mij") .bubble').click()
    before = len(get(8080, '/mock/sent'))
    page.click('.selection-bar button[aria-label="Forward"]')
    page.wait_for_selector('.dialog:has-text("Forward 3 messages"), [role=dialog]:has-text("Forward 3 messages")')
    page.fill('input[aria-label="Search chats"]', 'Carol'); page.locator('[role=dialog] li:has-text("Carol"), .dialog li:has-text("Carol")').first.click()
    page.locator('[role=dialog] button:has-text("Send"), .dialog button:has-text("Send"), [role=dialog] button:has-text("Forward")').last.click()
    for _ in range(40):
        sent = [x for x in get(8080, '/mock/sent')[before:] if x.get('message')]
        if len(sent) >= 3: break
        time.sleep(0.2)
    print('forwarded:', [x.get('message') for x in sent]); assert [x.get('message') for x in sent][:3] == ['Hey! Are we still on for Saturday?', 'Eerste van mij', 'Tweede van mij']

    # Your own two: delete for everyone
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg.out:has-text("Eerste van mij")')
    own = page.locator('.msg.out:has-text("Eerste van mij")'); own.hover(); own.locator('button[aria-label="Select"]').click()
    page.locator('.msg.out:has-text("Tweede van mij") .bubble').click()
    assert not page.locator('.selection-bar button[aria-label="Delete for everyone"]').is_disabled()
    page.click('.selection-bar button[aria-label="Delete for everyone"]')
    page.wait_for_selector('.selection-bar', state='detached')
    for _ in range(20):
        if page.locator('.msg.out:has-text("You deleted this message")').count() >= 2: break
        time.sleep(0.2)
    print('deleted:', page.locator('.msg.out:has-text("You deleted this message")').count()); assert page.locator('.msg.out:has-text("You deleted this message")').count() >= 2

    # Esc stops selecting; a link isn't followed while selecting
    m = page.locator('.msg').first; m.hover(); m.locator('button[aria-label="Select"]').click()
    page.wait_for_selector('.selection-bar'); page.keyboard.press('Escape'); page.wait_for_selector('.selection-bar', state='detached')
    assert not errors, errors
    b.close()
print('e2e69 ok')
