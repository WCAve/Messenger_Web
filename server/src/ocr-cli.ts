/**
 * Reading the text in images by hand, to check the sticker OCR on the server:
 *   docker exec signal-web node server/dist/ocr-cli.js /data/attachments/<file> [more files]
 * Prints, per file, how long it took and the lines found. Used by tests/docker-smoke.sh too.
 */
import { readSticker } from './ocr.js';

for (const f of process.argv.slice(2)) {
  const t0 = Date.now();
  try {
    const lines = await readSticker(f);
    console.log(JSON.stringify({ file: f, ms: Date.now() - t0, lines }));
  } catch (e) {
    console.log(JSON.stringify({ file: f, ms: Date.now() - t0, error: (e as Error).message }));
  }
}
