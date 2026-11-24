// Run by e2e79.py: the one-time move from the old 500-sticker list (kv wa_stickers) to the library.
// DATA_DIR is a fresh folder; the old list has 2 stickers, the disk 4 backup stickers ("stk-…") of which
// one is a copy, and one sticker sits in a message you sent.
import fs from 'node:fs';
import path from 'node:path';
const dir = process.env.DATA_DIR;
const dist = path.resolve(process.argv[2]);
const { kvSet } = await import(path.join(dist, 'db.js'));
const { config } = await import(path.join(dist, 'config.js'));
fs.mkdirSync(config.attachmentsDir, { recursive: true });
const put = (id, body) => fs.writeFileSync(path.join(config.attachmentsDir, id), body);
const stk = (n) => `stk-${String(n).padStart(24, '0')}.webp`;
put('listed-a.webp', 'A'); put('listed-b.webp', 'B');
put(stk(1), 'C'); put(stk(2), 'D'); put(stk(3), 'A'); // a copy of listed-a
put(stk(4), 'E');
put('sent-x.webp', 'X');
kvSet('wa_stickers', JSON.stringify([{ id: 'listed-a.webp', at: 2_000_000 }, { id: 'listed-b.webp', at: 1_000_000 }]));
const store = await import(path.join(dist, 'store.js'));
const conv = store.getOrCreateWaChat('31600000001@c.us').id;
store.insertMessage({ conversationId: conv, sentTs: 5_000_000, author: 'self', outgoing: true, body: '', attachments: [{ id: 'sent-x.webp', contentType: 'image/webp', size: 1, sticker: true }], status: 'sent', read: true });
const lib = await import(path.join(dist, 'stickerlib.js'));
lib.migrateStickerLib(console.log);
const list = lib.listLibrary();
const top = lib.topStickers();
console.log(JSON.stringify({ ids: list.map((s) => s.id), used: top.used.map((t) => t.pick.localId) }));
lib.forgetFromLibrary(['listed-a.webp']);
console.log(JSON.stringify({ afterForget: lib.listLibrary().map((s) => s.id) }));
