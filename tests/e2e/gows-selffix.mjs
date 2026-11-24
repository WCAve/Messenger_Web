// Run by e2e82.py: the one-time repair of your own GOWS group messages that landed in "Message yourself".
import path from 'node:path';
const dist = path.resolve(process.argv[2]);
const { kvSet } = await import(path.join(dist, 'db.js'));
const store = await import(path.join(dist, 'store.js'));
const wa = await import(path.join(dist, 'whatsapp.js'));
kvSet('wa_me', '31600000009@c.us,99999999999999@lid');
const me = store.getOrCreateWaChat('31600000009@c.us');
const group = store.getOrCreateWaChat('120363000000000001@g.us', 'Familie');
const add = (conv, ts, ext, body) => store.insertMessage({ conversationId: conv, sentTs: ts, author: 'self', outgoing: true, body, extId: ext, status: 'sent', read: true });
add(me.id, 1000, 'true_120363000000000001@g.us_AAAA1111_31600000009@c.us', 'misplaced in group');
add(me.id, 2000, 'true_120363000000000001@g.us_BBBB2222_31600000009@c.us', 'misplaced, already there');
add(group.id, 2000, 'true_120363000000000001@g.us_BBBB2222', 'misplaced, already there');
add(me.id, 3000, 'true_31600000009@c.us_CCCC3333', 'really a note to self');
const r = wa.repairGowsSelfChat();
const { db } = await import(path.join(dist, 'db.js'));
const rows = (id) => db.prepare('SELECT body FROM messages WHERE conversation_id = ? ORDER BY sent_ts').all(id).map((x) => x.body);
console.log(JSON.stringify({ r, self: rows(me.id), group: rows(group.id), again: wa.repairGowsSelfChat() }));
