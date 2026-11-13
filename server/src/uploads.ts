/**
 * Big files you send are uploaded in pieces (a few MB each), so a reverse proxy's upload limit doesn't
 * matter and the browser never has to hold the whole file as text. The web app:
 *
 *   POST /api/uploads            { name, type, size }  → { id, chunkMb }
 *   POST /api/uploads/:id        one piece, raw, with header x-offset (where it goes) → { received }
 *   then sends the message with  attachments: [{ upload: id, name, type }]
 *
 * Pieces are appended to DATA_DIR/uploads/<id>.part; a piece for the wrong place gets 409 with how much
 * arrived, so the browser can go on from there. Unfinished uploads are cleared after a day (and when
 * the server starts: the list of uploads lives in memory).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import { HttpError, type Ctx } from './http.js';

const MAX_PIECE = 16 * 1024 * 1024;
const DAY = 24 * 3600_000;

interface Upload {
  name: string;
  type: string;
  size: number;
  created: number;
  busy: boolean;
}
const uploads = new Map<string, Upload>();

const partFile = (id: string) => path.join(config.uploadsDir, `${id}.part`);

export function clearUploads() {
  fs.rmSync(config.uploadsDir, { recursive: true, force: true });
  fs.mkdirSync(config.uploadsDir, { recursive: true });
}

function sweep() {
  for (const [id, u] of uploads) {
    if (Date.now() - u.created < DAY) continue;
    uploads.delete(id);
    fs.rmSync(partFile(id), { force: true });
  }
}

export function startUpload(body: unknown) {
  sweep();
  const b = (body ?? {}) as { name?: unknown; type?: unknown; size?: unknown };
  const size = Number(b.size);
  if (!Number.isSafeInteger(size) || size <= 0) throw new HttpError(400, 'Bad file size');
  if (size > config.maxFileMb * 1024 * 1024) throw new HttpError(413, `Files can be at most ${config.maxFileMb} MB`);
  const id = crypto.randomBytes(12).toString('hex');
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  fs.writeFileSync(partFile(id), '');
  uploads.set(id, {
    name: String(b.name || 'file').replace(/[;,\r\n/\\]/g, '_').slice(0, 120),
    type: String(b.type || 'application/octet-stream').replace(/[^\w.+/-]/g, ''),
    size,
    created: Date.now(),
    busy: false,
  });
  return { id, chunkMb: 8 };
}

export async function receivePiece(ctx: Ctx) {
  const id = ctx.params.id;
  const u = uploads.get(id);
  if (!u) throw new HttpError(404, 'This upload is gone; try again');
  if (u.busy) throw new HttpError(409, 'Still receiving the previous piece');
  const file = partFile(id);
  const have = fs.statSync(file).size;
  const offset = Number(ctx.req.headers['x-offset']);
  if (offset !== have) {
    ctx.status = 409;
    return { error: 'Out of step', received: have };
  }
  u.busy = true;
  let got = 0;
  const limit = Math.min(MAX_PIECE, u.size - have);
  const counter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      got += chunk.length;
      if (got > limit) return done(new HttpError(413, 'Piece too large'));
      done(null, chunk);
    },
  });
  try {
    await pipeline(ctx.req, counter, fs.createWriteStream(file, { flags: 'a' }));
  } catch (e) {
    fs.truncateSync(file, have); // half a piece: forget it, the browser sends it again
    throw e instanceof HttpError ? e : new HttpError(400, `Upload failed: ${(e as Error).message}`);
  } finally {
    u.busy = false;
  }
  return { received: have + got };
}

/** A finished upload, moved to `dest` (the attachments folder). Throws when it's unknown or incomplete. */
export function takeUpload(id: string, dest: (u: { name: string; type: string; size: number }) => string) {
  const u = typeof id === 'string' ? uploads.get(id) : undefined;
  if (!u) throw new HttpError(400, 'That file upload is gone; add the file again');
  const file = partFile(id);
  if (u.busy || fs.statSync(file).size !== u.size) throw new HttpError(400, `${u.name} hasn't finished uploading`);
  uploads.delete(id);
  const to = dest(u);
  try {
    fs.renameSync(file, to);
  } catch {
    fs.copyFileSync(file, to); // another disk
    fs.rmSync(file, { force: true });
  }
  return u;
}

export function cancelUpload(id: string) {
  if (!uploads.delete(id)) return;
  fs.rmSync(partFile(id), { force: true });
}
