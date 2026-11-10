"""Arrow up to edit, erase everything, Enter: asks, then deletes the message for everyone (Cancel keeps editing)."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def sent():
    return json.loads(urllib.request.urlopen('http://127.0.0.1:8080/mock/sent').read())
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 1000})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row:has-text("Alice")', timeout=20000)
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg')
    page.click('textarea'); page.keyboard.type('Oeps, typfout'); page.keyboard.press('Enter')
    page.wait_for_selector('.msg.out:has-text("Oeps, typfout") .tick, .msg.out:has-text("Oeps, typfout") time'); time.sleep(1.5)
    page.keyboard.press('ArrowUp'); page.wait_for_selector('.reply-preview.editing')
    page.keyboard.press('Control+a'); page.keyboard.press('Backspace')
    assert page.locator('button[aria-label="Delete message"]').count() == 1
    # Cancel: still editing, nothing deleted
    page.once('dialog', lambda d: d.dismiss()); page.keyboard.press('Enter'); time.sleep(0.5)
    assert page.locator('.reply-preview.editing').count() == 1 and page.locator('.msg.out:has-text("Oeps, typfout")').count() == 1
    # OK: deleted
    page.once('dialog', lambda d: (print('asks:', d.message), d.accept())); page.keyboard.press('Enter')
    page.wait_for_selector('.msg.out:has-text("You deleted this message")', timeout=10000)
    assert page.locator('.reply-preview.editing').count() == 0 and page.locator('.msg.out:has-text("Oeps, typfout")').count() == 0
    assert any(x.get('remote_delete_timestamp') or 'remote-delete' in x.get('path', '') for x in sent()), 'no delete sent'
    print('empty edit deletes ok')
    b.close()
print('ERRORS:', errors)
