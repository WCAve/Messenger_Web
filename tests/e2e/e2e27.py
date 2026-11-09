"""Group management on both networks, and member labels (existing, live updates, your own)."""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def req(base, path, data=None):
    r = urllib.request.Request(base + path, data=json.dumps(data).encode() if data is not None else None, headers={'content-type': 'application/json'}, method='POST' if data is not None else 'GET')
    return json.loads(urllib.request.urlopen(r).read() or b'null')
wa = lambda path, data=None: req('http://127.0.0.1:8090', path + ('&' if '?' in path else '?') + 'x-api-key=test-waha-key', data)
sig = lambda path, data=None: req('http://127.0.0.1:8080', path, data)
row = lambda t: f'.chat-row-wrap:has(.chat-title:text-is("{t}"))'
FAM = '120363000000000001@g.us'
def until(fn, secs=10, msg='timeout'):
    end = time.time() + secs
    while time.time() < end:
        if fn(): return
        time.sleep(0.3)
    raise AssertionError(msg)
wsent = lambda path: [s for s in wa('/mock/sent') if s.get('path', '').endswith(path)]

with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 1000})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('dialog', lambda d: d.accept())
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector(row('Familie'), timeout=20000); time.sleep(6)
    panel = 'aside.panel'
    def open_info(title):
        page.click(row(title)); page.wait_for_selector('.chat-head')
        time.sleep(0.5)
        if page.locator(panel + ' h4:has-text("members")').count() == 0:
            page.click('.chat-head .chat-head-main, .chat-head button.head-title, .chat-head h2', timeout=5000)
        page.wait_for_selector(panel + ' h4:has-text("members")')

    # ---------- WhatsApp: Familie ----------
    open_info('Familie')
    # labels that already exist: WhatsApp lists them by privacy id, members are listed by number
    page.wait_for_selector(panel + ' .member-row:has-text("Sanne") .member-label:text("Organiser")', timeout=8000)
    page.wait_for_selector(panel + ' .member-row:has-text("You") .member-label:text("Papa")', timeout=8000)
    assert page.input_value(panel + ' input[aria-label="Your member label"]') == 'Papa'
    page.wait_for_selector('.msg .author:has-text("Sanne") .author-label:text("Organiser")', timeout=8000)
    # a label changed on someone's phone: arrives only as a live update
    wa('/mock/label-event', {'group': FAM, 'id': '33333333333333@lid', 'pn': '31655500001@c.us', 'tag': 'Kok'})
    page.wait_for_selector(panel + ' .member-row:has-text("Jan Bakker") .member-label:text("Kok")', timeout=10000)
    print('existing labels ok')
    # rename
    page.click(panel + ' button[aria-label="Edit group name"]')
    page.fill(panel + ' input[aria-label="Edit group name"]', 'Familie 🏡'); page.keyboard.press('Enter')
    until(lambda: any(s.get('subject') == 'Familie 🏡' for s in wsent('/subject')), 8, 'not renamed')
    page.wait_for_selector(row('Familie 🏡'), timeout=8000)
    # description
    page.click(panel + ' button[aria-label="Edit group description"]')
    page.fill(panel + ' textarea[aria-label="Edit group description"]', 'Nieuwe beschrijving')
    page.click(panel + ' button[aria-label=Save]')
    until(lambda: any(s.get('description') == 'Nieuwe beschrijving' for s in wsent('/description')), 8, 'description not set')
    page.wait_for_selector(panel + ' .panel-text:text("Nieuwe beschrijving")')
    print('wa info ok')
    # promote Jan
    page.click(panel + ' button[aria-label="Options for Jan Bakker"]'); page.click('.member-menu button:has-text("Make group admin")')
    page.wait_for_selector(panel + ' .member-row:has-text("Jan Bakker") .admin-badge', timeout=8000)
    # settings
    page.select_option(panel + ' select[aria-label="Send messages"]', 'admins')
    until(lambda: any(s.get('adminsOnly') is True for s in wsent('/messages-admin-only')), 8, 'setting not sent')
    page.click(panel + ' .group-settings .setting-row:has-text("Approve new members") input')
    until(lambda: any(s.get('newMembersApprovalRequired') is True for s in wsent('/membership-approval')), 8, 'approval not sent')
    print('wa admin ok')
    # invite link and reset
    old = page.inner_text(panel + ' .invite-link .link-text')
    assert 'chat.whatsapp.com/FamilieInvite' in old, old
    page.click(panel + ' .invite-link button:has-text("Reset link")')
    until(lambda: page.inner_text(panel + ' .invite-link .link-text') != old, 8, 'link not reset')
    # join request
    wa('/mock/join-request', {'group': FAM, 'who': '88888888888888@lid'})
    page.wait_for_selector(panel + ' .join-requests:has-text("Privé Pieter")', timeout=8000)
    page.click(panel + ' button[aria-label="Approve Privé Pieter"]')
    page.wait_for_selector(panel + ' .member-row:has-text("Privé Pieter")', timeout=8000)
    assert page.locator(panel + ' .join-requests').count() == 0
    print('wa link + requests ok')
    # my label
    page.fill(panel + ' input[aria-label="Your member label"]', 'Opa'); page.click(panel + ' .my-label button:has-text("Save")')
    page.wait_for_selector(panel + ' .member-row:has-text("You") .member-label:text("Opa")', timeout=8000)
    # remove Pieter again
    page.click(panel + ' button[aria-label="Options for Privé Pieter"]'); page.click('.member-menu button:has-text("Remove from group")')
    until(lambda: page.locator(panel + ' .member-row:has-text("Privé Pieter")').count() == 0, 8, 'not removed')
    # add Pieter with the picker
    page.click(panel + ' button:has-text("Add members")')
    page.fill(panel + ' input[aria-label="Search contacts"]', 'Pieter'); page.click(panel + ' .person:has-text("Privé Pieter")')
    page.click(panel + ' .add-members button:has-text("Add 1")')
    page.wait_for_selector(panel + ' .member-row:has-text("Privé Pieter")', timeout=8000)
    print('wa members ok')

    # someone else made it admins-only and you're no longer admin: the composer says so
    wa('/mock/group-set', {'group': FAM, 'patch': {'msgAdmins': True}, 'myRole': 'participant'})
    page.wait_for_selector('.blocked-bar:has-text("Only admins can send messages")', timeout=10000)
    until(lambda: page.locator(panel + ' .group-settings').count() == 0, 8, 'still shows admin settings')
    wa('/mock/group-set', {'group': FAM, 'patch': {'msgAdmins': False}, 'myRole': 'admin'})
    page.wait_for_selector('.composer textarea', timeout=10000)
    print('wa admins-only ok')

    # leave and rejoin with the link
    link = page.inner_text(panel + ' .invite-link .link-text')
    page.click(panel + ' button:has-text("Leave group")')
    page.wait_for_selector('.blocked-bar:has-text("no longer in this group")', timeout=10000)
    page.wait_for_selector(panel + ' :text("You\'re no longer in this group")')
    page.click('button[aria-label="New WhatsApp chat"]')
    page.click('.chat-row:has-text("Join a WhatsApp group with a link")')
    wa('/mock/group-set', {'group': FAM, 'patch': {'approval': False}})
    page.fill('input[aria-label="WhatsApp group link"]', 'https://' + link)
    page.wait_for_selector('.join-preview:has-text("Familie 🏡")', timeout=8000)
    page.click('.join-preview button:has-text("Join group")')
    page.wait_for_selector('.composer textarea', timeout=10000)
    until(lambda: page.locator('.blocked-bar').count() == 0, 8, 'still left')
    print('wa leave + join ok')

    # new WhatsApp group
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("New group")')
    page.click('.network-switch button:has-text("WhatsApp group")')
    page.fill('input[aria-label="Search contacts"]', 'Jan'); page.click('.person:has-text("Jan Bakker")')
    page.click('.sticky-actions button:has-text("Next")')
    page.fill('input[aria-label="Group name"]', 'Fietsclub'); page.click('button:has-text("Create group")')
    page.wait_for_selector('.chat-head:has-text("Fietsclub")', timeout=10000)
    c = [s for s in wa('/mock/sent') if s.get('path') == '/api/default/groups' and s.get('method') == 'POST'][-1]
    assert c['name'] == 'Fietsclub' and c['participants'] == [{'id': '31655500001@c.us'}], c
    print('wa new group ok')

    # ---------- Signal: Weekend plans ----------
    open_info('Weekend plans')
    page.select_option(panel + ' select[aria-label="Add members"]', 'admins')
    until(lambda: sig('/mock/signal-groups')[list(sig('/mock/signal-groups'))[0]]['permissions']['add_members'] == 'only-admins', 8, 'signal permission')
    page.click(panel + ' .invite-link button:has-text("Turn link on")')
    page.wait_for_selector(panel + ' .invite-link .link-text:has-text("signal.group")', timeout=8000)
    page.click(panel + ' .group-settings .setting-row:has-text("Approve new members") input')
    until(lambda: list(sig('/mock/signal-groups').values())[0]['link'] == 'enabled-with-approval', 8, 'approval link')
    sig('/mock/signal-join-request', {'who': '+31699999999'})
    page.click(panel + ' button[aria-label="Edit group name"]'); page.fill(panel + ' input[aria-label="Edit group name"]', 'Weekend!'); page.keyboard.press('Enter')
    page.wait_for_selector(row('Weekend!'), timeout=8000)
    page.wait_for_selector(panel + ' .join-requests', timeout=8000)
    page.click(panel + ' .join-requests button:has-text("Approve")')
    until(lambda: '+31699999999' in list(sig('/mock/signal-groups').values())[0]['members'], 8, 'not approved')
    page.click(panel + ' button[aria-label="Options for Bob Jansen"]'); page.click('.member-menu button:has-text("Dismiss as admin")')
    until(lambda: page.locator(panel + ' .member-row:has-text("Bob Jansen") .admin-badge').count() == 0, 8, 'bob still admin')
    print('signal admin ok')
    page.click(panel + ' button:has-text("Leave group")')
    page.wait_for_selector('.blocked-bar:has-text("no longer in this group")', timeout=10000)
    print('signal leave ok')
    # new Signal group
    page.click('button[aria-label="New Signal chat"]'); page.click('.chat-row:has-text("New Signal group")')
    assert page.locator('.network-switch').count() == 0  # the + already said which network
    page.click('.person:has-text("Alice de Vries")'); page.click('.person:has-text("Bob Jansen")')
    page.click('.sticky-actions button:has-text("Next (2)")')
    page.fill('input[aria-label="Group name"]', 'Picknick'); page.click('button:has-text("Create group")')
    page.wait_for_selector('.chat-head:has-text("Picknick")', timeout=10000)
    page.wait_for_selector('.composer textarea')
    print('signal new group ok')
    page.screenshot(path=S + '/e2e27.png')
    b.close()
print('ERRORS:', errors)
