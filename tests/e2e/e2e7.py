"""Browser notifications: permission states, the settings hint, notifications for new messages."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright

def goto(pg, title): pg.click(f'.settings-nav-row:has(strong:text-is("{title}"))')
def to_chats(pg):
    if pg.locator('button[aria-label="Back to settings"]').count(): pg.click('button[aria-label="Back to settings"]')
    pg.click('button[aria-label="Back to chats"]')
S, IP = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "192.0.2.2"); errors = []
SPY = """window.__notes = []; const N = window.Notification;
class Spy extends N { constructor(t, o) { super(t, o); window.__notes.push({ title: t, body: o && o.body }); } }
Object.defineProperty(Spy, 'permission', { get: () => N.permission }); Spy.requestPermission = (...a) => N.requestPermission(...a);
window.Notification = Spy;"""
def login(page, url):
    page.goto(url); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")'); page.wait_for_selector('.chat-row')
with sync_playwright() as p:
    b = p.chromium.launch()
    # 1) plain http on a LAN address: not a secure context
    c1 = b.new_context(viewport={'width': 1300, 'height': 850}); pg = c1.new_page(); pg.on('pageerror', lambda e: errors.append(str(e)))
    login(pg, f'http://{IP}:3000/')
    assert pg.evaluate('window.isSecureContext') is False
    pg.wait_for_selector('.notify-banner:has-text("Notifications need HTTPS")')
    pg.screenshot(path=f'{S}/shots7/01-insecure-banner.png')
    pg.click('.notify-banner .link-btn'); pg.wait_for_selector('.insecure-help')
    time.sleep(0.3); pg.screenshot(path=f'{S}/shots7/02-insecure-settings.png')
    c1.close()
    # 2) secure context, not asked yet: banner asks; denied hides it
    c2 = b.new_context(viewport={'width': 1300, 'height': 850}); pg = c2.new_page(); login(pg, 'http://localhost:3000/')
    perm = pg.evaluate('Notification.permission'); time.sleep(0.5)
    print('headless permission:', perm, '| banner shown:', pg.locator('.notify-banner').count())
    if perm == 'default':
        pg.wait_for_selector('.notify-banner:has-text("Turn on desktop notifications")')
    else:
        assert pg.locator('.notify-banner').count() == 0
        pg.click('button[aria-label=Menu]'); pg.click('button[role=menuitem]:has-text("Settings")'); goto(pg, 'Notifications')
        print('settings hint:', pg.locator('.setting-row:has-text("Desktop notifications") small').inner_text())
    c2.close()
    # 3) granted: no banner, test button, real notification for an incoming message
    b2 = p.chromium.launch(channel='chromium')  # new headless mode: honours granted notification permission
    c3 = b2.new_context(viewport={'width': 1300, 'height': 850}, permissions=['notifications']); c3.add_init_script(SPY)
    pg = c3.new_page(); login(pg, 'http://localhost:3000/')
    assert pg.locator('.notify-banner').count() == 0
    pg.click('button[aria-label=Menu]'); pg.click('button[role=menuitem]:has-text("Settings")'); goto(pg, 'Notifications')
    pg.click('button:has-text("Send a test notification")'); time.sleep(0.3)
    urllib.request.urlopen(urllib.request.Request('http://localhost:8080/mock/incoming', data=json.dumps({'from': 'bob', 'text': 'Are you there?'}).encode(), headers={'content-type': 'application/json'}))
    time.sleep(1.5)
    notes = pg.evaluate('window.__notes'); print('notifications:', notes)
    assert any(n['title'] == 'Messenger Web' for n in notes) and any('Are you there?' in (n['body'] or '') for n in notes)
    b2.close(); b.close()
print('ERRORS:', errors)
