"""Thumbnails: the chat shows small versions (photos at most 720 px wide, turned the way the phone held them;
a still for videos), with a blurred preview in the message while they load. The viewer opens the original."""
import sys, time, json, os, io, base64, subprocess
from playwright.sync_api import sync_playwright
from PIL import Image
S = sys.argv[1]; errors = []
big = os.path.join(S, 'Groot.png'); Image.new('RGB', (2400, 1600), (40, 160, 90)).save(big)
turned = os.path.join(S, 'Telefoon.jpg')
im = Image.new('RGB', (4000, 3000), (220, 40, 40)); im.paste((40, 40, 220), (0, 0, 2000, 1500))
ex = Image.Exif(); ex[0x0112] = 6; im.save(turned, exif=ex.tobytes(), quality=80)
vid = os.path.join(S, 'Clip.mp4')
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=10', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', vid], check=True)
print('sizes:', os.path.getsize(big), os.path.getsize(turned))
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 900})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row:has-text("Alice")', timeout=20000); time.sleep(2)
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg')
    for f, text in [(big, 'groot'), (turned, 'telefoon'), (vid, 'clip')]:
        page.set_input_files('input[type=file][multiple]', f); time.sleep(0.5)
        page.click('textarea'); page.keyboard.type(text); page.keyboard.press('Enter')
        page.wait_for_selector(f'.msg.out:has-text("{text}")')
    stored = None
    for _ in range(60):
        stored = page.evaluate("""async () => {
            const cs = await (await fetch('/api/conversations')).json();
            const c = (cs.conversations ?? cs).find((x) => x.title.startsWith('Alice'));
            const ms = await (await fetch(`/api/conversations/${c.id}/messages`)).json();
            return Object.fromEntries((ms.messages ?? ms).filter((m) => ['groot', 'telefoon', 'clip'].includes(m.body)).map((m) => [m.body, m.attachments[0]]));
        }""")
        if len(stored) == 3 and all((a.get('tiny') or '').startswith('data:image/jpeg;base64,') for a in stored.values()): break
        time.sleep(0.25)
    print('blur previews:', {k: len(v.get('tiny') or '') for k, v in stored.items()})
    assert all((a.get('tiny') or '').startswith('data:image/jpeg;base64,') and len(a['tiny']) < 3000 for a in stored.values()), stored

    def thumb(a, kind):
        r = page.evaluate("""async ([id, kind]) => {
            const r = await fetch(`/api/attachments/${encodeURIComponent(id)}/thumb?kind=${kind}`);
            const buf = new Uint8Array(await r.arrayBuffer()); let s = '';
            for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
            return { type: r.headers.get('content-type'), cache: r.headers.get('cache-control'), data: btoa(s), size: buf.length };
        }""", [a['id'], kind])
        return r, Image.open(io.BytesIO(base64.b64decode(r['data'])))
    r, img = thumb(stored['groot'], 'image'); print('photo thumb:', r['type'], r['size'], img.size, r['cache'])
    assert r['type'] == 'image/jpeg' and img.size == (720, 480) and 'immutable' in r['cache']
    r, img = thumb(stored['telefoon'], 'image'); print('turned photo thumb:', img.size, img.getpixel((10, 10)), img.getpixel((700, 10)))
    assert img.size == (720, 960)
    assert img.getpixel((700, 10))[2] > 150 and img.getpixel((10, 10))[0] > 150, 'turned the wrong way'
    r, img = thumb(stored['clip'], 'video'); print('video still:', r['type'], img.size)
    assert r['type'] == 'image/jpeg' and img.size in ((720, 405), (720, 406))

    # the chat shows the small versions; the viewer the original
    srcs = page.eval_on_selector_all('.msg.out .img-btn img', 'els => els.map((e) => e.getAttribute("src"))'); print('chat images:', srcs[-2:])
    assert all('/thumb?kind=image' in s for s in srcs[-2:])
    page.wait_for_selector('.msg.out:has-text("clip") .video')
    poster = page.eval_on_selector('.msg.out:has-text("clip") .video', 'el => (el.querySelector("video")?.getAttribute("poster")) ?? el.querySelector(".video-wait img")?.getAttribute("src")')
    print('video cover:', poster); assert '/thumb?kind=video' in poster
    page.click('.msg.out:has-text("telefoon") .img-btn')
    page.wait_for_selector('.lightbox img, .photo-overlay img', timeout=5000)
    big_src = page.eval_on_selector('.lightbox img, .photo-overlay img', 'e => e.getAttribute("src")'); print('viewer:', big_src)
    assert '/thumb' not in big_src
    page.keyboard.press('Escape')
    page.screenshot(path=S + '/e2e62.png')
    assert not errors, errors
    b.close()
print('e2e62 ok')
