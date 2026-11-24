"""The one-time repair for GOWS: your own group messages that landed in "Message yourself" go back to
their group (or are dropped when the group has them already); real notes to yourself stay; only once.
Runs gows-selffix.mjs against the built server in a fresh data folder."""
import sys, os, json, subprocess, tempfile
S = sys.argv[1]
here = os.path.dirname(os.path.abspath(__file__))
d = tempfile.mkdtemp(dir=S)
out = subprocess.run(['node', '--no-warnings', os.path.join(here, 'gows-selffix.mjs'), os.path.join(here, '..', '..', 'server', 'dist')], env={**os.environ, 'DATA_DIR': d}, capture_output=True, text=True, timeout=60)
print(out.stdout, out.stderr[-2000:])
r = json.loads([l for l in out.stdout.splitlines() if l.startswith('{')][-1])
assert r['r'] == {'moved': 1, 'dropped': 1}, r
assert r['self'] == ['really a note to self'], r
assert r['group'] == ['misplaced in group', 'misplaced, already there'], r
assert r['again'] == {'moved': 0, 'dropped': 0}, r
print('e2e82 ok')
