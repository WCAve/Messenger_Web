"""The message toolbar (and its reaction row) can be reached on a slanted path with animations off: it stays
a moment after the pointer leaves the message; pointing at another message hides it at once."""
import sys, time
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={'width': 1400, 'height': 900}, reduced_motion='reduce')
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row:has-text("Alice")', timeout=20000); time.sleep(2)
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg')
    assert page.evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches")
    msg = page.locator('.msg.in:has(.quote)').first
    bub = msg.locator('.bubble').bounding_box()
    toolbar = msg.locator('.actions')
    # On the text at the bottom left of the bubble: the toolbar shows (centred on the right)
    page.mouse.move(bub['x'] + 20, bub['y'] + bub['height'] - 12)
    assert toolbar.is_visible()
    tb = toolbar.bounding_box()
    # Slanted towards the toolbar: out of the bubble well below the toolbar first
    page.mouse.move(bub['x'] + bub['width'] + 10, bub['y'] + bub['height'] + 14, steps=6)
    time.sleep(0.15)
    assert toolbar.is_visible(), 'gone while on the way to it'
    page.mouse.move(tb['x'] + tb['width'] / 2, tb['y'] + tb['height'] / 2, steps=6)
    time.sleep(0.6)  # longer than the grace period: on the toolbar it stays
    assert toolbar.is_visible(), 'gone while on it'
    print('toolbar reached on a slanted path')

    # The reaction row: open it, leave on a slant, reach it, react
    msg.locator('button[aria-label="React"]').click()
    qr = msg.locator('.quick-react'); qr.wait_for()
    q = qr.bounding_box()
    page.mouse.move(q['x'] + q['width'] + 30, tb['y'] - 4, steps=5)  # beside it, outside the message
    time.sleep(0.15)
    assert qr.is_visible(), 'reaction row gone while on the way to it'
    first = qr.locator('button').first
    fb = first.bounding_box(); page.mouse.move(fb['x'] + fb['width'] / 2, fb['y'] + fb['height'] / 2, steps=5)
    page.mouse.down(); page.mouse.up()
    page.wait_for_selector('.msg.in:has(.quote) .reactions .reaction.mine', timeout=5000)
    print('reacted through the reaction row')

    # Leaving for good: gone after the grace period; another message: at once
    page.mouse.move(700, 450); page.mouse.move(bub['x'] + 20, bub['y'] + bub['height'] - 12)
    assert toolbar.is_visible()
    page.mouse.move(bub['x'] + bub['width'] + 200, bub['y'] + bub['height'] + 120, steps=3)
    time.sleep(0.8)
    assert not toolbar.is_visible(), 'still there after leaving'
    page.mouse.move(bub['x'] + 20, bub['y'] + bub['height'] - 12); assert toolbar.is_visible()
    other = page.locator('.msg.out').first.locator('.bubble').bounding_box()
    page.mouse.move(other['x'] + 10, other['y'] + 10)
    assert not toolbar.is_visible(), 'two toolbars at once'
    print('hides after leaving, and at once for another message')
    assert not errors, errors
    b.close()
print('e2e66 ok')
