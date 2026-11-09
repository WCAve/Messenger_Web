"""Notification pictures: the person's photo, or initials (round)."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def wa(path, data=None):
    r = urllib.request.Request('http://127.0.0.1:8090' + path, data=json.dumps(data).encode() if data is not None else None, headers={'content-type': 'application/json'}, method='POST' if data is not None else 'GET')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
STUB = """
window.__notes = [];
class FakeNotification { constructor(t, o) { window.__notes.push({ title: t, icon: o && o.icon, body: o && o.body }); } close() {} }
FakeNotification.permission = 'granted';
FakeNotification.requestPermission = async () => 'granted';
Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true });
Object.defineProperty(window, 'isSecureContext', { value: true });
"""
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1300, 'height': 900})
    page.add_init_script(STUB)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Familie'), timeout=20000); time.sleep(8)
    page.click(row('Alice de Vries')); time.sleep(0.5)
    wa('/mock/incoming', {'from': 'jan', 'text': 'met foto'})
    wa('/mock/incoming', {'from': 'sanne', 'group': 'buren', 'text': 'in de groep'})  # Familie is muted
    end = time.time() + 10
    while time.time() < end and page.evaluate('window.__notes.length') < 2: time.sleep(0.3)
    notes = page.evaluate('window.__notes')
    print([(n['title'], (n['icon'] or '')[:30]) for n in notes])
    jan = [n for n in notes if n['title'] == 'Jan Bakker'][0]; grp = [n for n in notes if 'Buren' in n['title']][0]
    assert jan['icon'].startswith('data:image/png') and len(jan['icon']) > 2000, 'no picture for Jan'
    assert grp['icon'].startswith('data:image/png'), 'no initials picture for the group'
    # the icon is Jan's picture (mostly green), not initials: sample the middle pixel
    rgb = page.evaluate("""async (src) => { const i = new Image(); i.src = src; await i.decode(); const c = document.createElement('canvas'); c.width = c.height = 192; const x = c.getContext('2d'); x.drawImage(i, 0, 0); return [...x.getImageData(96, 170, 1, 1).data].slice(0, 3); }""", jan['icon'])
    print('pixel', rgb)
    assert rgb[1] > rgb[0] and rgb[1] > rgb[2], rgb
    b.close()
print('ERRORS:', errors)
