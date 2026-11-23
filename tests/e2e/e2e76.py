"""Member tags keep up on GOWS (which says nothing when someone changes theirs): the app looks again while
the group talks, and a tag change remembered from WEBJS days doesn't hide the newer tag."""
# server-env: MOCK_WA_ENGINE=GOWS WA_LABELS_EVERY_MS=2000
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def wa(path, data):
    r = urllib.request.Request('http://127.0.0.1:8090' + path, data=json.dumps(data).encode(), headers={'content-type': 'application/json'}, method='POST')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
SANNE_LID = '22222222222222@lid'
label = lambda: page.locator('.msg .author:has-text("Sanne") .author-label').last
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1300, 'height': 900}); page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row-wrap:has(.chat-title:text-is("Familie"))', timeout=20000); time.sleep(4)
    page.click('.chat-row-wrap:has(.chat-title:text-is("Familie"))'); page.wait_for_selector('.msg')
    wa('/mock/incoming', {'from': 'sanne', 'group': True, 'text': 'Hoi allemaal'})
    page.wait_for_selector('.msg .author:has-text("Sanne") .author-label:text("Organiser")', timeout=10000); print('tag at start ok')

    # Sanne changes her tag: GOWS says nothing; the next message in the group brings it in
    wa('/mock/tag', {'id': SANNE_LID, 'tag': 'Kok'}); time.sleep(2.5)
    wa('/mock/incoming', {'from': 'sanne', 'group': True, 'text': 'Ik kook vanavond'})
    page.wait_for_selector('.msg .author-label:text("Kok")', timeout=10000); print('changed tag ok')

    # And takes it off
    wa('/mock/tag', {'id': SANNE_LID, 'tag': None}); time.sleep(2.5)
    wa('/mock/incoming', {'from': 'sanne', 'group': True, 'text': 'Zonder titel'})
    for _ in range(40):
        if not page.locator('.msg .author-label:text("Kok")').count(): break
        time.sleep(0.25)
    assert not page.locator('.msg .author-label').count(), page.locator('.msg .author-label').all_inner_texts()
    print('tag taken off ok')
    assert not errors, errors
    b.close()
print('e2e76 ok')
