import crypto from 'node:crypto';
import { config } from './config.js';
import { db } from './db.js';

export const SESSION_COOKIE = 'sw_session';

function hash(s: string) {
  return crypto.createHash('sha256').update(s).digest();
}

export function passwordMatches(candidate: string) {
  return crypto.timingSafeEqual(hash(candidate), hash(config.password));
}

export function createSession(): { token: string; expires: Date } {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const expires = now + config.sessionDays * 86400_000;
  db.prepare('INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)').run(hash(token).toString('hex'), now, expires);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  return { token, expires: new Date(expires) };
}

export function destroySession(token: string | undefined) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(hash(token).toString('hex'));
}

export function destroyAllSessions() {
  db.prepare('DELETE FROM sessions').run();
}

export function activeSessionCount(): number {
  return db.prepare<[number], { n: number }>('SELECT count(*) AS n FROM sessions WHERE expires_at > ?').get(Date.now())!.n;
}

export function isValidSession(token: string | undefined): boolean {
  if (!token) return false;
  const row = db.prepare<[string], { expires_at: number }>('SELECT expires_at FROM sessions WHERE token = ?').get(hash(token).toString('hex'));
  return !!row && row.expires_at > Date.now();
}

// --- brute-force protection: 10 failed attempts per IP per 15 minutes ---
const failures = new Map<string, { count: number; until: number }>();

export function loginBlocked(ip: string): number {
  const f = failures.get(ip);
  if (!f) return 0;
  if (f.until < Date.now()) {
    failures.delete(ip);
    return 0;
  }
  return f.count >= 10 ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}

export function recordLoginFailure(ip: string) {
  const f = failures.get(ip);
  if (!f || f.until < Date.now()) failures.set(ip, { count: 1, until: Date.now() + 15 * 60_000 });
  else f.count++;
}

export function clearLoginFailures(ip: string) {
  failures.delete(ip);
}
