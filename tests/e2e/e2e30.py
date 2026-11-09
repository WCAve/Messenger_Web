"""Settings main list and every settings page."""
import sys, time
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
EXPECT = {'Profile': 'input[aria-label="WhatsApp name"]', 'Chats': '.setting-row:has-text("Enter sends the message")', 'Appearance': '.emoji-styles',
          'Notifications': '.setting-row:has-text("Desktop notifications"), .insecure-help', 'Privacy': '.setting-row:has-text("Send read receipts")',
          'WhatsApp': 'button:has-text("Unlink WhatsApp")', 'History and backup': '.history-settings', 'Account': 'button:has-text("Sign out everywhere")'}
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 900})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row', timeout=20000); time.sleep(5)
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Settings")')
    titles = page.locator('.settings-nav-row strong').all_inner_texts()
    print('pages:', titles)
    assert titles == list(EXPECT), titles
    for t, sel in EXPECT.items():
        page.click(f'.settings-nav-row:has(strong:text-is("{t}"))')
        page.wait_for_selector(f'.side-head h2:text-is("{t}")'); page.wait_for_selector(sel, timeout=8000)
        assert page.locator('.settings-nav').count() == 0
        page.click('button[aria-label="Back to settings"]'); page.wait_for_selector('.settings-nav')
    # the main list says what's set
    assert 'Linked: +31600000009' in page.inner_text('.settings-nav-row:has(strong:text-is("WhatsApp"))')
    assert 'Read receipts on' in page.inner_text('.settings-nav-row:has(strong:text-is("Privacy"))')
    page.click('.settings-nav-row:has(strong:text-is("Appearance"))'); page.click('.segmented button:has-text("Dark green")')
    page.click('button[aria-label="Back to settings"]')
    assert 'Dark green' in page.inner_text('.settings-nav-row:has(strong:text-is("Appearance"))')
    page.click('button[aria-label="Back to chats"]'); page.wait_for_selector('.chat-row')
    print('settings pages ok')
    b.close()
print('ERRORS:', errors)
