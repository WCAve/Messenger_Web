/**
 * Settings that change what Signal Web sends to other people. The container's environment variables
 * are the defaults; changes made in the Settings screen are stored in the database and win.
 */
import { config } from './config.js';
import { kvGet, kvSet } from './db.js';

const DEFAULTS = {
  sendReadReceipts: config.sendReadReceipts,
  sendTypingIndicators: config.sendTypingIndicators,
  sendLinkPreviews: config.sendLinkPreviews,
  // WhatsApp history import: how many chats, and messages per chat. 0 = as many as WhatsApp gives.
  waHistoryChats: config.wahaHistoryChats,
  waHistoryMessages: config.wahaHistoryMessages,
  // Forward WhatsApp messages the way WhatsApp does (with the "Forwarded" label) instead of sending a copy.
  waNativeForward: true,
  // Download files from imported history in the background (otherwise: when someone opens them).
  waHistoryMedia: false,
};
export type ServerSettings = typeof DEFAULTS;

export function getSettings(): ServerSettings {
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS) as (keyof ServerSettings)[]) {
    const v = kvGet(`setting:${k}`);
    if (typeof DEFAULTS[k] === 'number') {
      if (v !== undefined && /^\d+$/.test(v)) (out as Record<string, unknown>)[k] = Number(v);
    } else if (v === 'true' || v === 'false') (out as Record<string, unknown>)[k] = v === 'true';
  }
  return out;
}

export function updateSettings(patch: Partial<Record<keyof ServerSettings, unknown>>): ServerSettings {
  for (const k of Object.keys(DEFAULTS) as (keyof ServerSettings)[]) {
    const v = patch[k];
    if (typeof DEFAULTS[k] === 'number') {
      if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100_000) kvSet(`setting:${k}`, String(v));
    } else if (typeof v === 'boolean') kvSet(`setting:${k}`, String(v));
  }
  return getSettings();
}
