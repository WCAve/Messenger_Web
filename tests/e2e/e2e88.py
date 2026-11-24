"""The app can be installed (Chrome's own check: manifest, icons, display), and its icons load."""
import sys, json
from playwright.sync_api import sync_playwright
S = sys.argv[1]
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page()
    page.goto('http://localhost:3000/'); page.wait_for_selector('input[type=password]')
    cdp = page.context.new_cdp_session(page)
    m = cdp.send('Page.getAppManifest'); man = json.loads(m.get('data') or '{}')
    print('manifest errors:', m.get('errors'), '| name:', man.get('name'))
    assert not m.get('errors'), m.get('errors')
    errs = cdp.send('Page.getInstallabilityErrors')['installabilityErrors']
    print('installability errors:', errs)
    assert not errs, errs
    for icon in man['icons']:
        r = page.request.get('http://localhost:3000' + icon['src']); assert r.ok and r.headers['content-type'].startswith('image/'), icon
    assert page.locator('link[rel=manifest][crossorigin=use-credentials]').count() == 1
    b.close()
print('e2e88 ok')
