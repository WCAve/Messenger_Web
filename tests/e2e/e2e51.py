"""Signal group changes show as lines in the chat ("Alice added Kees", "Bob left", "You changed the group
name to …"), like WhatsApp's: Signal only says "it changed", so they come from comparing before and after."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def sig(path, data):
    r = urllib.request.Request('http://127.0.0.1:8080' + path, data=json.dumps(data).encode(), headers={'content-type': 'application/json'}, method='POST')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
sig('/mock/contact', {'number': '+31644444445', 'uuid': '11111111-0000-4000-8000-000000000005', 'name': 'Kees van Dam'})
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 1000})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row:has-text("Weekend plans")', timeout=20000); time.sleep(2)
    page.click('.chat-row:has-text("Weekend plans")'); page.wait_for_selector('.msg')
    lines = lambda: page.locator('.msg.system, .system-line, .msg-system').all_inner_texts()
    def expect(text, t=15):
        end = time.time() + t
        while time.time() < end:
            if any(text in x for x in lines()): return
            time.sleep(0.3)
        raise AssertionError(f'no line "{text}" in {lines()}')
    sig('/mock/signal-group-change', {'who': 'alice', 'add': ['+31644444445']}); expect('Alice de Vries added Kees van Dam')
    sig('/mock/signal-group-change', {'who': 'alice', 'remove': ['+31633333333']}); expect('Alice de Vries removed Carol')
    sig('/mock/signal-group-change', {'who': 'bob', 'remove': ['+31622222222']}); expect('Bob Jansen left')
    sig('/mock/signal-group-change', {'who': 'alice', 'name': 'Weekendje weg'}); expect('Alice de Vries changed the group name to “Weekendje weg”')
    # From here: "You …"
    cid = page.evaluate('() => fetch("/api/conversations").then(r => r.json())')
    cid = [c for c in (cid.get('conversations', cid) if isinstance(cid, dict) else cid) if c['title'] == 'Weekendje weg'][0]['id']
    r = page.evaluate('([id]) => fetch(`/api/conversations/${id}/group`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({action: "rename", name: "Weekend!"})}).then(r => r.status)', [cid])
    print('rename status', r); expect('You changed the group name to “Weekend!”')
    page.screenshot(path=S + '/e2e51.png')
    print('lines:', [x for x in lines() if 'added' in x or 'left' in x or 'removed' in x or 'name' in x])
    # Nothing doubled after another refresh
    page.evaluate('() => fetch("/api/directory/refresh", {method: "POST"})'); time.sleep(2)
    assert sum('Bob Jansen left' in x for x in lines()) == 1
    print('signal group lines ok')
    b.close()
print('ERRORS:', errors)
