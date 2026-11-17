"""Quick reactions: by default the ones you react with most (filled up with the usual ones), from your own
reactions; Settings → Chats switches between "Usual" and "Most used"."""
import sys, time
from playwright.sync_api import sync_playwright
S = sys.argv[1]; errors = []
def goto(pg, title): pg.click(f'.settings-nav-row:has(strong:text-is("{title}"))')
def to_chats(pg):
    if pg.locator('button[aria-label="Back to settings"]').count(): pg.click('button[aria-label="Back to settings"]')
    pg.click('button[aria-label="Back to chats"]')
with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1400, 'height': 900})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:3000/'); page.fill('input[type=password]', 'testpassword'); page.click('button:has-text("Sign in")')
    page.wait_for_selector('.chat-row:has-text("Alice")', timeout=20000); time.sleep(2)
    q = page.evaluate("fetch('/api/reactions/quick').then((r) => r.json())"); print('at the start:', q)
    assert q['mostUsed'] is True and len(q['list']) == 7

    # React: 🔥 three times, 🎉 twice (on different messages)
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg')
    page.evaluate("""async () => {
        const cs = await (await fetch('/api/conversations')).json();
        const c = (cs.conversations ?? cs).find((x) => x.title.startsWith('Alice'));
        const ms = await (await fetch(`/api/conversations/${c.id}/messages`)).json();
        const ids = (ms.messages ?? ms).filter((m) => !m.deleted && m.kind !== 'system').map((m) => m.id);
        const react = (id, emoji) => fetch(`/api/messages/${id}/reactions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ emoji }) });
        for (const id of ids.slice(0, 3)) await react(id, '🔥');
        for (const id of ids.slice(3, 5)) await react(id, '🎉');
    }""")
    q = page.evaluate("fetch('/api/reactions/quick').then((r) => r.json())"); print('after reacting:', q['list'])
    assert q['list'][:2] == ['🔥', '🎉'] and len(q['list']) == 7 and len(set(q['list'])) == 7

    # The row above a message shows them (fresh page: asked once)
    page.reload(); page.wait_for_selector('.chat-row:has-text("Alice")', timeout=20000)
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg')
    def row():
        msg = page.locator('.msg.in').first
        msg.hover(); msg.locator('button[aria-label="React"]').click()
        msg.locator('.quick-react').wait_for()
        r = msg.locator('.quick-react button:not(.more)').all_inner_texts()
        page.keyboard.press('Escape'); page.mouse.move(5, 5); time.sleep(0.7)
        return [x.strip() for x in r]
    r = row(); print('row (most used):', r); assert r[:2] == ['🔥', '🎉']

    # Settings → Chats: Usual
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Settings")'); goto(page, 'Chats')
    page.wait_for_selector('[role=radiogroup][aria-label="Quick reactions"]')
    print('preview:', page.locator('.quick-preview').inner_text())
    page.screenshot(path=S + '/e2e67-settings.png')
    page.click('[aria-label="Quick reactions"] button:has-text("Usual")'); time.sleep(0.8)
    assert page.locator('.quick-preview').inner_text().split() == ['❤️', '👍', '👎', '😂', '😮', '😢', '🙏'], page.locator('.quick-preview').inner_text()
    to_chats(page); time.sleep(0.5)
    page.click('.chat-row:has-text("Alice")'); page.wait_for_selector('.msg')
    r = row(); print('row (usual):', r); assert r == ['❤️', '👍', '👎', '😂', '😮', '😢', '🙏']

    # And back
    page.click('button[aria-label=Menu]'); page.click('button[role=menuitem]:has-text("Settings")'); goto(page, 'Chats')
    page.click('[aria-label="Quick reactions"] button:has-text("Most used")'); time.sleep(0.8)
    assert page.locator('.quick-preview').inner_text().split()[:2] == ['🔥', '🎉']
    assert not errors, errors
    b.close()
print('e2e67 ok')
