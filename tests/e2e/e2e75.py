"""The formatting button in the message box (no tooltip on the box any more): bold/italic/… around the
selection, again to take it off, nothing selected → a pair with the cursor between; Ctrl+B / Ctrl+I;
no spoiler for WhatsApp."""
import sys, time
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1300, 'height': 900}); page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row:has-text("Alice")', timeout=20000); time.sleep(1)
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg')
    ta = page.locator('textarea')
    assert ta.get_attribute('title') is None, 'tooltip still there'
    val = lambda: ta.input_value()
    def select(s, e): page.evaluate(f"(() => {{ const t = document.querySelector('textarea'); t.focus(); t.setSelectionRange({s}, {e}); }})()")
    ta.click(); page.keyboard.type('hallo wereld ')
    select(6, 13)  # "wereld " (the space stays outside)
    page.click('button[aria-label=Formatting]'); page.wait_for_selector('.format-menu')
    labels = page.locator('.format-menu button .fmt-sample').all_inner_texts(); print('menu:', labels)
    assert labels == ['Bold', 'Italic', 'Strikethrough', 'Monospace', 'Spoiler'], labels
    page.screenshot(path=S + '/e2e75-menu.png')
    page.click('.format-menu button:has-text("Bold")')
    assert val() == 'hallo *wereld* ', val()
    page.click('button[aria-label=Formatting]'); page.click('.format-menu button:has-text("Bold")')  # selection kept: off again
    assert val() == 'hallo wereld ', val()
    select(0, 5); page.keyboard.press('Control+i'); assert val() == '_hallo_ wereld ', val()
    page.keyboard.press('End'); page.keyboard.press('Control+b'); page.keyboard.type('vet')
    assert val() == '_hallo_ wereld *vet*', val()
    page.keyboard.press('Enter')
    page.wait_for_selector('.msg.out:has-text("hallo wereld vet") strong:has-text("vet")'); page.wait_for_selector('.msg.out:has-text("hallo wereld vet") em:has-text("hallo")')
    print('signal formatting ok')
    page.click('.chat-row:has-text("Jan Bakker")'); page.wait_for_selector('.msg')
    page.click('button[aria-label=Formatting]'); page.wait_for_selector('.format-menu')
    assert 'Spoiler' not in page.locator('.format-menu').inner_text()
    page.keyboard.press('Escape'); time.sleep(0.2); assert not page.locator('.format-menu').count()
    print('whatsapp menu ok')
    assert not errors, errors
    b.close()
print('e2e75 ok')
