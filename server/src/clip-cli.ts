/**
 * Picture search by hand, with the downloaded model (Settings → Stickers):
 *   docker exec signal-web node server/dist/clip-cli.js "search words" /data/attachments/<file> [more files]
 * Prints how well each picture matches the words (higher is better; only comparable with each other).
 * Used by tests/docker-smoke.sh too.
 */
import { embedImage, embedText } from './clip.js';

const [query, ...files] = process.argv.slice(2);
const q = await embedText(query ?? '');
if (!q) {
  console.log(JSON.stringify({ error: 'no picture search model installed' }));
  process.exit(1);
}
for (const f of files) {
  const v = await embedImage(f);
  let s = 0;
  for (let i = 0; v && i < v.length; i++) s += v[i] * q[i];
  console.log(JSON.stringify({ query, file: f, score: Math.round(s * 1000) / 1000 }));
}
