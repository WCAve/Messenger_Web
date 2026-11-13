/**
 * Everything the container's environment variables control, in one object. The full list with
 * explanations is in README.md (Configuration). Settings a user can change in the app live in
 * settings.ts (stored in the database, the environment gives the defaults).
 */
import path from 'node:path';

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

const dataDir = process.env.DATA_DIR ?? '/data';

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  /** Base URL of the signal-cli-rest-api container (must run in json-rpc / json-rpc-native mode). */
  signalApiUrl: (process.env.SIGNAL_API_URL ?? 'http://signal-api:8080').replace(/\/+$/, ''),
  /** Signal can be switched off (SIGNAL_API_URL=off) to use only WhatsApp. */
  signalEnabled: !['', 'off', 'none', 'false'].includes((process.env.SIGNAL_API_URL ?? 'x').trim().toLowerCase()),
  /** WAHA (WhatsApp HTTP API). Leave WAHA_URL empty to run without WhatsApp. */
  wahaUrl: (process.env.WAHA_URL ?? '').trim().replace(/\/+$/, ''),
  wahaApiKey: process.env.WAHA_API_KEY?.trim() ?? '',
  wahaSession: process.env.WAHA_SESSION?.trim() || 'default',
  /** How many recent chats (and messages per chat) to import from WhatsApp when it's first linked. */
  wahaHistoryChats: Number(process.env.WAHA_HISTORY_CHATS ?? 40),
  wahaHistoryMessages: Number(process.env.WAHA_HISTORY_MESSAGES ?? 40),
  /** Optional: which account to use when the Signal API holds more than one. */
  signalNumber: process.env.SIGNAL_NUMBER?.trim() || undefined,
  /** Password for the web UI. Required. */
  password: process.env.APP_PASSWORD ?? '',
  dataDir,
  dbPath: path.join(dataDir, 'signal-web.db'),
  attachmentsDir: path.join(dataDir, 'attachments'),
  deviceName: process.env.DEVICE_NAME ?? 'Messenger Web',
  /** Serve HTTPS directly: paths to a PEM certificate (chain) and private key. */
  tlsCertFile: process.env.TLS_CERT_FILE?.trim() || null,
  tlsKeyFile: process.env.TLS_KEY_FILE?.trim() || null,
  /** Set to true when served over HTTPS (e.g. behind a reverse proxy) so the session cookie gets the Secure flag. */
  secureCookies: bool(process.env.SECURE_COOKIES, !!(process.env.TLS_CERT_FILE && process.env.TLS_KEY_FILE)),
  sessionDays: Number(process.env.SESSION_DAYS ?? 30),
  /** Send read receipts to senders when you open a chat. */
  sendReadReceipts: bool(process.env.SEND_READ_RECEIPTS, true),
  /** Send typing indicators while you type. */
  sendTypingIndicators: bool(process.env.SEND_TYPING_INDICATORS, true),
  /** Max upload size for outgoing attachments, in MB. */
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB ?? 100),
  /** Biggest file you can pick to send, in MB (uploaded in pieces; big videos are made smaller to fit). */
  maxFileMb: Number(process.env.MAX_FILE_MB ?? 2048),
  /** Biggest file Signal and WhatsApp take as an attachment, in MB; bigger videos are shrunk to fit. */
  sendLimitMb: Number(process.env.SEND_LIMIT_MB ?? 95),
  /** The same for WhatsApp: WAHA takes at most 50 MB per request, and a file grows by a third as text (base64). */
  waSendLimitMb: Number(process.env.WA_SEND_LIMIT_MB ?? 36),
  uploadsDir: path.join(dataDir, 'uploads'),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  /** Giphy API key for the GIF picker (free at developers.giphy.com). Without it the GIF tab explains how to add one. */
  giphyApiKey: process.env.GIPHY_API_KEY?.trim() || null,
  /** Tests only: let link previews reach private addresses and skip certificate checks. */
  linkPreviewInsecure: process.env.LINK_PREVIEW_INSECURE === '1',
  /** Default for "Send link previews" (the server fetches pages you link to). */
  sendLinkPreviews: bool(process.env.SEND_LINK_PREVIEWS, true),
  /** Giphy content rating: g, pg, pg-13 or r. */
  giphyRating: process.env.GIPHY_RATING?.trim() || 'pg-13',
};
