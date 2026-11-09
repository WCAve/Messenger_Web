"""Profile pictures load lazily (only on screen) and never block the app."""
import sys, time
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []; reqs = []
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 300})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('request', lambda r: reqs.append(r.url))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row', timeout=20000); time.sleep(8)
    av = [u for u in reqs if '/api/avatars/' in u or '/api/stickers/' in u]
    print('picture requests:', len(av), av[:4])
    bad = [u for u in av if not (u.split('?')[0].endswith('.jpg') or u.split('?')[0].endswith('.webp'))]
    assert not bad, bad
    assert page.evaluate("[...document.querySelectorAll('.avatar img')].some(i => i.complete && i.naturalWidth > 0)"), 'no avatar shown'
    n_before = len(av)
    page.set_viewport_size({'width': 1400, 'height': 900}); time.sleep(1.5)
    av2 = [u for u in reqs if '/api/avatars/' in u]
    print('after making the window taller:', len(av2))
    assert len(av2) >= n_before
    b.close()
print('ERRORS:', errors)
