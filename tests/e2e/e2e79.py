"""The one-time move to the sticker library: stickers from the old capped list, backup stickers that fell
off it, stickers in your messages (sent ones count as used); copies once; forgetting takes all copies.
Runs stickerlib-migrate.mjs against the built server in a fresh data folder."""
import sys, os, json, subprocess, tempfile
S = sys.argv[1]
here = os.path.dirname(os.path.abspath(__file__))
dist = os.path.join(here, '..', '..', 'server', 'dist')
d = tempfile.mkdtemp(dir=S)
out = subprocess.run(['node', '--no-warnings', os.path.join(here, 'stickerlib-migrate.mjs'), dist], env={**os.environ, 'DATA_DIR': d}, capture_output=True, text=True, timeout=60)
print(out.stdout, out.stderr[-2000:])
lines = [json.loads(l) for l in out.stdout.splitlines() if l.startswith('{')]
ids, used, after = lines[0]['ids'], lines[0]['used'], lines[1]['afterForget']
stk = lambda n: f'stk-{n:024d}.webp'
assert len(ids) == 6, ids  # A (and its copy) once, B, C, D, E, X
assert set(ids) >= {'listed-b.webp', stk(1), stk(2), stk(4), 'sent-x.webp'}, ids
assert len({'listed-a.webp', stk(3)} & set(ids)) == 1, ids
assert ids[0] == 'sent-x.webp' and ids.index('listed-b.webp') < ids.index(stk(1)), ids  # newest first; recovered ones behind the listed
assert used == ['sent-x.webp'], used
assert not ({'listed-a.webp', stk(3)} & set(after)) and len(after) == 5, after
print('e2e79 ok')
