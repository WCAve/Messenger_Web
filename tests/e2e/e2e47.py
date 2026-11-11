"""Pages of messages never split a moment: two people sending in the same instant both arrive, whichever
way the chat is paged (older, newer, around a message). Checked on the API, with tiny pages."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def sig(path, data):
    r = urllib.request.Request('http://127.0.0.1:8080' + path, data=json.dumps(data).encode(), headers={'content-type': 'application/json'}, method='POST')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
T = int(time.time() * 1000) - 30 * 24 * 3600_000  # older than everything else in the chat
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row:has-text("Weekend plans")', timeout=20000); time.sleep(1)
    for who, text, ts in (('alice', 'Eerst', T), ('bob', 'Tegelijk van Bob', T + 1000), ('carol', 'Tegelijk van Carol', T + 1000), ('alice', 'Daarna', T + 2000)):
        sig('/mock/incoming', {'from': who, 'group': True, 'text': text, 'ts': ts})
    time.sleep(1.5)
    get = lambda path: page.evaluate('p => fetch(p).then(r => r.json())', path)
    convs = get('/api/conversations'); convs = convs.get('conversations', convs) if isinstance(convs, dict) else convs
    cid = [c for c in convs if c['title'] == 'Weekend plans'][0]['id']
    texts = lambda ms: [m['body'] for m in ms]
    both = lambda ms: 'Tegelijk van Bob' in texts(ms) and 'Tegelijk van Carol' in texts(ms)
    # older: the page is cut between the two; both come along
    older = get(f'/api/conversations/{cid}/messages?before={T + 2001}&limit=2'); print('older:', texts(older))
    assert texts(older)[-1] == 'Daarna' and both(older), texts(older)
    rest = get(f'/api/conversations/{cid}/messages?before={older[0]["sentAt"]}&limit=2'); print('then:', texts(rest))
    assert texts(rest) == ['Eerst']
    # newer
    newer = get(f'/api/conversations/{cid}/messages?after={T - 1}&limit=2'); print('newer:', texts(newer))
    assert texts(newer)[0] == 'Eerst' and both(newer), texts(newer)
    nxt = get(f'/api/conversations/{cid}/messages?after={newer[-1]["sentAt"]}&limit=1'); assert texts(nxt) == ['Daarna'], texts(nxt)
    # around
    around = get(f'/api/conversations/{cid}/messages?around={T + 2000}&limit=2')['messages']; print('around:', texts(around))
    assert both(around) and 'Daarna' in texts(around), texts(around)
    print('paging ok')
    b.close()
print('ERRORS:', errors)
