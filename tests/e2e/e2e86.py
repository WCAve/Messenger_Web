"""Group chats: the sender's picture beside their messages (once per row), their name and picture open
their profile in the side panel (name, number, "Message"), and a profile picture opens big; also in a
one-to-one chat's contact info."""
import sys, time, json
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 1000})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Familie'), timeout=20000); time.sleep(1)

    # WhatsApp group: pictures beside incoming messages, one per row of messages from the same person
    page.click(row('Familie')); page.wait_for_selector('.msg.in')
    ins = page.locator('.msg.in').count(); firsts = page.locator('.msg.in:not(.cont)').count()
    assert page.locator('.msg.in.with-avatar').count() == ins, 'incoming without room for a picture'
    assert page.locator('.msg.in .msg-avatar').count() == firsts, (page.locator('.msg.in .msg-avatar').count(), firsts)
    assert not page.locator('.msg.out .msg-avatar').count(), 'own messages got a picture'
    page.screenshot(path=S + '/e2e86-group.png')

    # The name opens the profile (Jan has a picture; Sanne doesn't, so hers isn't clickable)
    page.locator('.msg.in .author-name:text-is("Sanne")').first.click(); page.wait_for_selector('.person-panel h3:text-is("Sanne")'); time.sleep(1)
    assert not page.locator('.person-panel .profile-photo.view').count(), 'no picture, still clickable'
    name = page.locator('.msg.in .author-name:text-is("Jan Bakker")').first; who = name.inner_text().strip(); name.click()
    page.wait_for_selector(f'.person-panel h3:text-is("{who}")'); print('profile from name:', who, page.locator('.person-panel .panel-hero').inner_text().replace('\n', ' | '))
    page.screenshot(path=S + '/e2e86-profile.png')
    # The picture opens it big
    page.click('.person-panel .profile-photo.view'); page.wait_for_selector('.lightbox img[src*="/api/avatars/"]')
    assert who in page.locator('.lightbox header').inner_text()
    page.keyboard.press('Escape'); page.wait_for_selector('.lightbox', state='detached')
    # The picture beside a message opens the profile too; "group info" goes back to the group
    page.click('.person-panel button[aria-label=Close]'); page.wait_for_selector('.person-panel', state='detached')
    page.locator('.msg.in .msg-avatar').first.click(); page.wait_for_selector('.person-panel')
    page.click('.person-panel button:has-text("group info")'); page.wait_for_selector('aside.panel[aria-label="Group info"]')
    print('picture → profile, back to group ok')

    # "Message" opens the one-to-one chat
    page.locator('.msg.in .author-name:text-is("Jan Bakker")').first.click(); page.wait_for_selector('.person-panel')
    page.click('.person-panel button:has-text("Message")')
    page.wait_for_selector(f'.chat-head .chat-title:text-is("{who}"), .chat-head-text:has-text("{who}")'); print('message ok')

    # Signal group: same
    page.click(row('Weekend plans')); page.wait_for_selector('.msg.in .msg-avatar')
    page.locator('.msg.in .author-name').first.click(); page.wait_for_selector('.person-panel h3')
    print('signal profile:', page.locator('.person-panel .panel-hero').inner_text().replace('\n', ' | '))

    # One-to-one chat: contact info picture opens big (when there is one)
    page.click(row('Jan Bakker')); page.click('.chat-head-main'); page.wait_for_selector('aside.panel[aria-label="Contact info"]')
    if page.locator('aside.panel .profile-photo.view').count():
        page.click('aside.panel .profile-photo.view'); page.wait_for_selector('.lightbox img'); page.keyboard.press('Escape')
        print('contact picture big ok')
    assert not errors, errors
    b.close()
print('e2e86 ok')
