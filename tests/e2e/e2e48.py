"""Names from your phone that Signal passes on without their middle part ("Mary Ruijter" for "Mary de Ruijter")
are filled in from their Signal profile or your WhatsApp contact for the same number; short names you chose stay."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def post(port, path, data):
    r = urllib.request.Request(f'http://127.0.0.1:{port}' + path, data=json.dumps(data).encode(), headers={'content-type': 'application/json'}, method='POST')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
# Signal: the names as your phone passes them on
post(8080, '/mock/contact', {'number': '+31644444441', 'uuid': '11111111-0000-4000-8000-000000000001', 'name': 'Mary Ruijter', 'given': 'Mary', 'profileGiven': 'Mary', 'profileLast': 'de Ruijter'})
post(8080, '/mock/contact', {'number': '+31644444442', 'uuid': '11111111-0000-4000-8000-000000000002', 'name': 'Eize Van Vegt', 'given': 'Eize Van', 'profileGiven': 'Eize'})
post(8080, '/mock/contact', {'number': '+31644444443', 'uuid': '11111111-0000-4000-8000-000000000003', 'name': 'Amber van der Vegt', 'given': 'Amber', 'profileGiven': 'Amber', 'profileLast': 'Albers'})
post(8080, '/mock/contact', {'number': '+31644444444', 'uuid': '11111111-0000-4000-8000-000000000004', 'name': 'Mama', 'profileGiven': 'Els', 'profileLast': 'de Wit'})
post(8080, '/mock/contact', {'number': '+31644444445', 'uuid': '11111111-0000-4000-8000-000000000005', 'name': 'Kees', 'profileGiven': 'Kees', 'profileLast': 'van Dam'})
# WhatsApp has Eize's name whole
post(8090, '/mock/contact', {'key': 'eize', 'id': '31644444442@c.us', 'name': 'Eize van der Vegt', 'pushname': 'Eize'})
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row:has-text("Alice")', timeout=20000); time.sleep(6)
    call = lambda method, path: page.evaluate('([m, p]) => fetch(p, {method: m, headers: {"content-type": "application/json"}, body: m === "POST" ? "{}" : undefined}).then(r => r.json())', [method, path])
    call('POST', '/api/whatsapp/refresh')
    contacts = {c['number']: c['name'] for c in call('POST', '/api/directory/refresh')['contacts']}
    for n in ('+31644444441', '+31644444442', '+31644444443', '+31644444444', '+31644444445'): print(n, '→', contacts.get(n))
    assert contacts['+31644444441'] == 'Mary de Ruijter'      # from her Signal profile
    assert contacts['+31644444442'] == 'Eize van der Vegt'    # from WhatsApp
    assert contacts['+31644444443'] == 'Amber van der Vegt'   # already whole; her profile is another name
    assert contacts['+31644444444'] == 'Mama'                 # a name you chose stays
    assert contacts['+31644444445'] == 'Kees'                 # one word: stays
    print('names ok')
    b.close()
print('ERRORS:', errors)
