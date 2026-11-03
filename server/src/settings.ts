/**
 * Settings that change what Signal Web sends to other people. The container's environment variables
 * are the defaults; changes made in the Settings screen are stored in the database and win.
 */
import { config } from './config.js';
import { kvGet, kvSet } from './db.js';

const DEFAULTS = {
  sendReadReceipts: config.sendReadReceipts,
  sendTypingIndicators: config.sendTypingIndicators,
};
export type ServerSettings = typeof DEFAULTS;

export function getSettings(): ServerSettings {
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS) as (keyof ServerSettings)[]) {
    const v = kvGet(`setting:${k}`);
    if (v === 'true' || v === 'false') out[k] = v === 'true';
  }
  return out;
}

export function updateSettings(patch: Partial<Record<keyof ServerSettings, unknown>>): ServerSettings {
  for (const k of Object.keys(DEFAULTS) as (keyof ServerSettings)[]) {
    if (typeof patch[k] === 'boolean') kvSet(`setting:${k}`, String(patch[k]));
  }
  return getSettings();
}
