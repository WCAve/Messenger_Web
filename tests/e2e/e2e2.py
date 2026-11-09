"""Composer and message toolbar: GIFs, hover toolbar, quick reactions, emoji picker search."""
import os, sys, time, json, base64
from playwright.sync_api import sync_playwright
S = sys.argv[1]
FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')  # test files kept in the repo
GIF = open(f'{FIX}/fake.gif','rb').read()
errors = []
def fake_giphy(route):
    url = route.request.url
    if 'api.giphy.com' in url:
        q = 'search' if '/search' in url else 'trending'
        data = [{'id': f'g{i}', 'title': f'{q} gif {i}', 'images': {
            'fixed_width': {'url': f'https://media.giphy.com/media/g{i}/200w.gif', 'width': '200', 'height': str(120 + (i % 3) * 30)},
            'downsized': {'url': f'https://media.giphy.com/media/g{i}/giphy-downsized.gif'}}} for i in range(12)]
        return route.fulfill(status=200, content_type='application/json', body=json.dumps({'data': data, 'meta': {'status': 200}}),
                             headers={'access-control-allow-origin': '*'})
    return route.fulfill(status=200, content_type='image/gif', body=GIF, headers={'access-control-allow-origin': '*'})

def shot(page, name):
    page.screenshot(path=f'{S}/shots2/{name}.png')

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1768, 'height': 1000})
    ctx.route('https://*.giphy.com/**', fake_giphy)
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    page.goto('http://localhost:3000/')
    page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row')
    page.click('.chat-row:has-text("Weekend")')
    page.wait_for_selector('.gif-video')
    time.sleep(1.2)
    shot(page, '01-group-fullwidth')
    # hover toolbar: move from bubble onto toolbar and click a button
    msg = page.locator('.msg.in:has-text("I can do snacks")')
    msg.scroll_into_view_if_needed(); time.sleep(0.3)
    box = msg.locator('.bubble').bounding_box()
    page.mouse.move(box['x'] + box['width'] - 5, box['y'] + box['height'] / 2)
    tb = msg.locator('.actions').bounding_box()
    steps = 12
    for i in range(1, steps + 1):  # slow drag across the gap
        page.mouse.move(box['x'] + box['width'] - 5 + (tb['x'] + 10 - (box['x'] + box['width'] - 5)) * i / steps, box['y'] + box['height'] / 2)
    assert msg.locator('.actions').is_visible(), 'toolbar disappeared while moving onto it'
    msg.locator('button[aria-label=React]').click()
    page.wait_for_selector('.quick-react')
    shot(page, '02-hover-react')
    page.locator('.quick-react button.more').click()
    page.wait_for_selector('.picker-panel')
    page.fill('.picker-search input', 'party')
    time.sleep(0.3)
    shot(page, '03-react-more')
    page.locator('.emoji-cell').first.click()
    page.wait_for_selector('.msg:has-text("I can do snacks") .reaction.mine')
    # header → group info
    page.click('.chat-head-main')
    page.wait_for_selector('.panel .member')
    time.sleep(0.8)
    shot(page, '04-group-info')
    page.click('.panel .link-btn:has-text("Read more")')
    page.click('.media-tabs button:has-text("Media")')
    time.sleep(0.3)
    shot(page, '05-group-info-expanded')
    # emoji autocomplete
    page.click('textarea')
    page.keyboard.type('Haha :lau')
    page.wait_for_selector('.emoji-suggest')
    shot(page, '06-suggest')
    page.keyboard.press('Enter')
    val = page.input_value('textarea')
    assert '😆' in val, val
    page.keyboard.type('and :thumbsup: done :fire')
    page.keyboard.press('ArrowDown'); page.keyboard.press('Tab')
    val = page.input_value('textarea'); print('composer:', val)
    page.keyboard.press('Enter')
    time.sleep(0.5)
    # message info on the sent message
    out = page.locator('.msg.out').last
    out.hover()
    out.locator('button[aria-label="Message info"]').click()
    page.wait_for_selector('.panel h2:has-text("Message info")')
    time.sleep(4.5)
    shot(page, '07-message-info')
    page.click('.panel-head button[aria-label=Close]')
    # emoji panel + GIF tab
    page.click('button[aria-label=Emoji]')
    page.wait_for_selector('.emoji-grid')
    shot(page, '08-emoji-panel')
    page.click('.picker-tabs button:has-text("GIF")')
    page.wait_for_selector('.gif-cell img')
    time.sleep(0.6)
    shot(page, '09-gif-panel')
    page.fill('.picker-search input', 'cats')
    time.sleep(1)
    page.locator('.gif-cell').nth(2).click()
    page.wait_for_selector('.msg.out .gif-tag', timeout=8000)
    time.sleep(1)
    shot(page, '10-gif-sent')
    # direct chat info
    page.click('.chat-row:has-text("Alice")')
    page.click('.chat-head-main')
    page.wait_for_selector('.panel-hero')
    time.sleep(0.8)
    shot(page, '11-contact-info')
    # medium width overlay + mobile
    page.set_viewport_size({'width': 1000, 'height': 800}); time.sleep(0.5)
    shot(page, '12-medium-overlay')
    m = b.new_context(viewport={'width': 390, 'height': 800}, color_scheme='dark', storage_state=ctx.storage_state())
    m.route('https://*.giphy.com/**', fake_giphy)
    mp = m.new_page(); mp.on('pageerror', lambda e: errors.append(str(e)))
    mp.goto('http://localhost:3000/'); mp.wait_for_selector('.chat-row')
    mp.click('.chat-row:has-text("Weekend")'); mp.wait_for_selector('.msg'); time.sleep(1)
    shot(mp, '13-mobile-group')
    mp.click('.chat-head-main'); mp.wait_for_selector('.panel .member'); time.sleep(0.6)
    shot(mp, '14-mobile-info')
    b.close()
print('ERRORS:', errors)
