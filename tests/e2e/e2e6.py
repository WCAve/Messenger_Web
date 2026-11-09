"""Signal profile: name, about, photo, removing it; group picture."""
import os, sys, time, json, urllib.request
from playwright.sync_api import sync_playwright

def goto(pg, title): pg.click(f'.settings-nav-row:has(strong:text-is("{title}"))')
def to_chats(pg):
    if pg.locator('button[aria-label="Back to settings"]').count(): pg.click('button[aria-label="Back to settings"]')
    pg.click('button[aria-label="Back to chats"]')
S = sys.argv[1]; errors = []
FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')  # test files kept in the repo
def sent(): return json.load(urllib.request.urlopen('http://localhost:8080/mock/sent'))
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 1400, 'height': 900}); page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row')
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Settings")'); goto(page, 'Profile')
    page.wait_for_selector('.profile-fields input')
    for _ in range(50):
        if page.input_value('.profile-fields input >> nth=0') == 'Wouter': break
        time.sleep(0.2)
    assert page.input_value('.profile-fields input >> nth=0') == 'Wouter'
    page.screenshot(path=f'{S}/shots6/01-profile.png')
    page.set_input_files('.profile-edit input[type=file]', f'{FIX}/photo.png')
    page.wait_for_selector('.profile-photo img[src^="data:image/jpeg"]')
    page.click('button:has-text("Save profile")'); page.wait_for_selector('text=Saved.')
    last = [x for x in sent() if x.get('path', '').startswith('/v1/profiles')][-1]; print('photo save:', last); assert last['avatarBytes'] > 1000
    page.wait_for_selector('.profile-photo img[src^="/api/avatars/self"]'); time.sleep(0.5)
    page.screenshot(path=f'{S}/shots6/02-profile-photo.png')
    # change only the about text: the photo must be kept
    page.locator('.profile-fields input').nth(1).fill('Now with a picture')
    page.click('button:has-text("Save profile")'); time.sleep(1)
    last = [x for x in sent() if x.get('path', '').startswith('/v1/profiles')][-1]; print('text-only save:', last)
    assert last['avatarBytes'] > 1000 and last['about'] == 'Now with a picture', 'photo was not kept'
    page.click('button:has-text("Remove picture")'); page.click('button:has-text("Save profile")'); time.sleep(1)
    last = [x for x in sent() if x.get('path', '').startswith('/v1/profiles')][-1]; print('remove:', last); assert last['avatarBytes'] == 0
    # group photo
    to_chats(page)
    page.click('.chat-row:has-text("Weekend")'); page.click('.chat-head-main'); page.wait_for_selector('.panel .profile-photo')
    before = page.locator('.panel .profile-photo img').get_attribute('src')
    page.set_input_files('.panel-hero input[type=file]', f'{FIX}/group.png')
    for _ in range(40):
        img = page.locator('.panel .profile-photo img')
        if img.count() and img.get_attribute('src') != before: break
        time.sleep(0.2)
    else: raise AssertionError('group picture did not change')
    last = [x for x in sent() if x.get('path', '').startswith('/v1/groups')][-1]; print('group:', last); assert last['avatarBytes'] > 1000
    time.sleep(1); page.screenshot(path=f'{S}/shots6/03-group-photo.png')
    b.close()
print('ERRORS:', errors)
