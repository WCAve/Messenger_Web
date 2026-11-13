"""Photos and videos keep their space while they load: sizes are known up front (from the browser for photos
you send, filled in by the server for videos), so a chat full of media doesn't jump while it opens. Videos
load only when scrolled near."""
import sys, time, json, os, subprocess
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
from PIL import Image
Image.new('RGB', (300, 500), (200, 60, 60)).save(os.path.join(S, 'Staand.png'))
Image.new('RGB', (600, 300), (60, 60, 200)).save(os.path.join(S, 'Liggend.png'))
vid = os.path.join(S, 'Kort.mp4')
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=10', '-f', 'lavfi', '-i', 'sine', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', vid], check=True)
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 900})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row:has-text("Alice")', timeout=20000); time.sleep(2)
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg')
    for f, text in [('Staand.png', 'staand'), ('Liggend.png', 'liggend'), ('Kort.mp4', 'filmpje')]:
        page.set_input_files('input[type=file][multiple]', os.path.join(S, f)); time.sleep(0.4)
        page.click('textarea'); page.keyboard.type(text); page.keyboard.press('Enter')
        page.wait_for_selector(f'.msg.out:has-text("{text}")')
    # the server knows every size (the video's is filled in after sending)
    atts = None
    for _ in range(40):
        atts = page.evaluate("""async () => {
            const cs = await (await fetch('/api/conversations')).json();
            const c = (cs.conversations ?? cs).find((x) => x.title.startsWith('Alice'));
            const ms = await (await fetch(`/api/conversations/${c.id}/messages`)).json();
            return (ms.messages ?? ms).filter((m) => ['staand', 'liggend', 'filmpje'].includes(m.body)).map((m) => [m.body, m.attachments[0].width, m.attachments[0].height]);
        }""")
        if all(w and h for _, w, h in atts): break
        time.sleep(0.25)
    print('sizes:', atts)
    assert sorted(atts) == [['filmpje', 360, 640], ['liggend', 600, 300], ['staand', 300, 500]], atts

    # Open the chat fresh, with every file held back for 3 s: the bubbles already have their final size
    held = []; release = False
    def slow(route):
        if release: route.continue_()
        else: held.append(route)  # released after measuring
    ctx2 = b.new_context(viewport={'width': 1400, 'height': 900})  # a fresh browser: nothing cached
    page = ctx2.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
    page.route('**/api/attachments/**', slow)
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row:has-text("Alice")', timeout=20000)
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg.out:has-text("filmpje")')
    time.sleep(0.3)
    sel = {t: f'.msg.out:has-text("{t}") .bubble' for t in ['staand', 'liggend', 'filmpje']}
    before = {t: page.locator(s).bounding_box() for t, s in sel.items()}
    loaded_early = page.evaluate("[...document.querySelectorAll('.msg img')].filter((i) => i.src.includes('/api/attachments/') && i.complete && i.naturalWidth).length")
    print('before:', {t: (round(v['width']), round(v['height'])) for t, v in before.items()}, 'images loaded already:', loaded_early)
    assert loaded_early == 0, 'measured too late'
    page.screenshot(path=S + '/e2e61-before.png')
    print('held back:', len(held))
    release = True
    for r in held: r.continue_()
    for _ in range(80):  # (wait_for_function isn't allowed by the app's security policy)
        if page.evaluate("[...document.querySelectorAll('.msg img')].filter((i) => i.src.includes('/api/attachments/')).every((i) => i.complete && i.naturalWidth)"): break
        time.sleep(0.25)
    else: raise AssertionError('images never loaded')
    time.sleep(1.5)
    after = {t: page.locator(s).bounding_box() for t, s in sel.items()}
    print('after: ', {t: (round(v['width']), round(v['height'])) for t, v in after.items()})
    page.screenshot(path=S + '/e2e61-after.png')
    for t in sel:
        assert abs(before[t]['height'] - after[t]['height']) < 1 and abs(before[t]['width'] - after[t]['width']) < 1, (t, before[t], after[t])
    # shapes: portrait photo taller than wide, landscape wider than tall, the video portrait
    img = lambda t: page.locator(f'.msg.out:has-text("{t}") .img-btn img').bounding_box()
    assert img('staand')['height'] > img('staand')['width'] and img('liggend')['width'] > img('liggend')['height']
    v = page.locator('.msg.out:has-text("filmpje") .video').bounding_box(); print('video box:', v)
    assert v['height'] > v['width']
    assert not errors, errors
    b.close()
print('e2e61 ok')
