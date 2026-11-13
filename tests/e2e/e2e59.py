"""Big files: uploaded in pieces with progress; a video too big for the network is made smaller on the
server to fit; files that can't be sent say so straight away (and can't be sent); the piece upload
picks up where it was."""
# server-env: SEND_LIMIT_MB=3 MAX_FILE_MB=40
import sys, time, json, os, base64, subprocess, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def get(port, path):
    return json.loads(urllib.request.urlopen(f'http://127.0.0.1:{port}{path}').read() or b'null')
# A 20 s 720p video of about 30 MB (more than "in one go" and far more than the 3 MB limit here)
vid = os.path.join(S, 'Vakantie.mp4')
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440',
                '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '12M', '-c:a', 'aac', '-shortest', vid], check=True)
print('video:', os.path.getsize(vid) // 1024 // 1024, 'MB')
assert os.path.getsize(vid) > 22 * 1024 * 1024
big = os.path.join(S, 'Archief.zip'); huge = os.path.join(S, 'Enorm.bin')
with open(big, 'wb') as f: f.truncate(25 * 1024 * 1024)
with open(huge, 'wb') as f: f.truncate(45 * 1024 * 1024)
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 900})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row:has-text("Alice")', timeout=20000); time.sleep(3)
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg')

    # 1. Files that can't be sent: said straight away, and the send button stays off
    page.set_input_files('input[type=file][multiple]', [big, huge])
    page.wait_for_selector('.pending-file.unsendable >> nth=1')
    notes = page.locator('.shrink-note.problem').all_inner_texts(); print('problems:', notes)
    assert 'Too big to send' in notes[0] and '3 MB' in notes[0], notes
    assert 'Too big: 45.0 MB (at most 40 MB)' in notes[1], notes
    page.locator('.pending-files').screenshot(path=S + '/e2e59-problems.png')
    page.click('textarea'); page.keyboard.type('mag niet')
    assert page.locator('button.send-btn').is_disabled()
    page.keyboard.press('Enter'); time.sleep(1)
    assert not [x for x in get(8080, '/mock/sent') if 'mag niet' in (x.get('message') or '')], 'sent anyway'
    page.click('.pending-file .remove'); page.click('.pending-file .remove')
    page.fill('textarea', '')

    # 2. A big video: the note, upload progress, then made smaller on the server
    page.set_input_files('input[type=file][multiple]', vid)
    page.wait_for_selector('.shrink-note:has-text("Big video")')
    print('note:', page.locator('.shrink-note').inner_text())
    page.click('textarea'); page.keyboard.type('Filmpje'); page.keyboard.press('Enter')
    page.wait_for_selector('.upload-progress', timeout=5000)
    page.locator('.pending-files').screenshot(path=S + '/e2e59-progress.png')
    print('progress:', page.locator('.upload-progress').inner_text())
    sent = None
    for _ in range(240):
        s = [x for x in get(8080, '/mock/sent') if x.get('base64_attachments')]
        if s: sent = s[0]; break
        time.sleep(0.5)
    assert sent, 'video not sent'
    head = sent['base64_attachments'][0].split('base64,', 1)[0]
    size = sent['attachment_sizes'][0]; print('sent:', head, size // 1024, 'KB')
    assert head == 'data:video/mp4;filename=Vakantie.mp4;', head
    assert size <= 3 * 1024 * 1024, size
    # the message shows the smaller file
    page.wait_for_selector('.msg.out:has-text("Filmpje") video', timeout=10000)
    stored = page.evaluate("""async () => {
        const cs = await (await fetch('/api/conversations')).json();
        const c = (cs.conversations ?? cs).find((x) => x.title.startsWith('Alice'));
        const ms = await (await fetch(`/api/conversations/${c.id}/messages`)).json();
        const m = (ms.messages ?? ms).find((x) => x.body === 'Filmpje');
        const file = await (await fetch(`/api/attachments/${encodeURIComponent(m.attachments[0].id)}`)).arrayBuffer();
        let bin = ''; const u = new Uint8Array(file);
        for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000));
        return { status: m.status, att: m.attachments[0], data: btoa(bin) };
    }""")
    print('stored:', stored['status'], stored['att'])
    assert stored['att']['size'] == size and stored['att']['contentType'] == 'video/mp4'
    out = os.path.join(S, 'e2e59-small.mp4'); open(out, 'wb').write(base64.b64decode(stored['data']))
    probe = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,height:format=duration', '-of', 'json', out], capture_output=True, check=True).stdout)
    print('probe:', probe)
    assert {s['codec_type'] for s in probe['streams']} == {'video', 'audio'}
    assert abs(float(probe['format']['duration']) - 20) < 1.5
    print('video made smaller ok')

    # 3. Pieces: one out of step gets told where to go on from; a finished upload can be sent
    r = page.evaluate("""async () => {
        const post = (url, body, headers) => fetch(url, { method: 'POST', headers, body }).then(async (r) => [r.status, await r.json()]);
        const [, start] = await post('/api/uploads', JSON.stringify({ name: 'a.txt', type: 'text/plain', size: 10 }), { 'content-type': 'application/json' });
        const up = (off, text) => post(`/api/uploads/${start.id}`, text, { 'x-messenger-upload': '1', 'x-offset': String(off) });
        const a = await up(0, 'hello');
        const b = await up(0, 'hello');            // sent twice: out of step
        const c = await up(5, 'world!');           // more than the file's size
        const d = await up(5, 'world');
        const e = await post(`/api/uploads/${start.id}`, 'x', { 'x-offset': '10' }); // no upload header
        return { a, b, c, d, e, id: start.id };
    }""")
    print('pieces:', r)
    assert r['a'] == [200, {'received': 5}] and r['b'][0] == 409 and r['b'][1]['received'] == 5
    assert r['c'][0] == 413 and r['d'] == [200, {'received': 10}] and r['e'][0] == 400
    print('pieces ok')

    assert not errors, errors
    b.close()
print('e2e59 ok')
