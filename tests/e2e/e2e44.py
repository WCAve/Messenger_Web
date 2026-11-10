"""Ctrl+F: search in the open chat; again in the box: the browser's own; Escape clears, then closes; without a chat open: the chat list search."""
import sys, time
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 1000})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row:has-text("Alice")', timeout=20000); time.sleep(1)
    focused = lambda: page.evaluate('() => document.activeElement && (document.activeElement.getAttribute("aria-label") || document.activeElement.placeholder || document.activeElement.tagName)')
    # No chat open: the chat list search
    page.keyboard.press('Control+f'); time.sleep(0.3)
    print('no chat:', focused()); assert focused() == 'Search chats and messages'
    page.keyboard.press('Escape')
    # A chat open, typing in the message box: Ctrl+F opens search in this chat
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg'); page.click('textarea'); page.keyboard.type('half getypt')
    page.keyboard.press('Control+f'); page.wait_for_selector('input[aria-label="Search messages"]'); time.sleep(0.3)
    print('chat:', focused()); assert focused() == 'Search messages'
    page.keyboard.type('bold'); page.wait_for_selector('.search-results li, .search-result', timeout=10000)
    # Back in the message box, Ctrl+F returns to the open search box with the text selected
    page.click('textarea'); page.keyboard.press('Meta+f'); time.sleep(0.3)
    assert focused() == 'Search messages'
    assert page.evaluate('() => { const e = document.activeElement; return e.selectionStart === 0 && e.selectionEnd === e.value.length }')
    # Escape: clears, then closes; the half-typed message is untouched
    page.keyboard.press('Escape'); time.sleep(0.2); assert page.input_value('input[aria-label="Search messages"]') == ''
    page.keyboard.press('Escape'); time.sleep(0.3); assert page.locator('input[aria-label="Search messages"]').count() == 0
    assert page.input_value('textarea') == 'half getypt'
    print('ctrl+f ok')
    b.close()
print('ERRORS:', errors)
