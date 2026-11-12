"""GIFs (sent as looping videos, like WhatsApp and Signal do) open large when clicked, and keep looping there."""
import sys, time
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 1000})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row:has-text("Weekend plans")', timeout=20000)
    page.click('.chat-row:has-text("Weekend plans")'); page.wait_for_selector('.gif-video', timeout=10000)
    btn = page.locator('button.img-btn:has(.gif-video)').first
    assert btn.locator('.gif-tag').inner_text() == 'GIF'
    btn.click(); page.wait_for_selector('.lightbox video', timeout=5000)
    v = page.locator('.lightbox video')
    print('attrs:', v.evaluate('v => [v.loop, v.muted, v.controls, v.getAttribute("src")]'))
    assert v.evaluate('v => v.loop && v.muted && !v.controls')
    assert page.locator('.lightbox-count').count() == 0  # GIFs aren't stepped through
    page.screenshot(path=S + '/e2e50.png')
    page.keyboard.press('Escape'); time.sleep(0.3); assert page.locator('.lightbox').count() == 0
    print('gif opens large ok')
    b.close()
print('ERRORS:', errors)
