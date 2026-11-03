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
  /** Optional: which account to use when the Signal API holds more than one. */
  signalNumber: process.env.SIGNAL_NUMBER?.trim() || undefined,
  /** Password for the web UI. Required. */
  password: process.env.APP_PASSWORD ?? '',
  dataDir,
  dbPath: path.join(dataDir, 'signal-web.db'),
  attachmentsDir: path.join(dataDir, 'attachments'),
  deviceName: process.env.DEVICE_NAME ?? 'Signal Web',
  /** Set to true when served over HTTPS (e.g. behind a reverse proxy) so the session cookie gets the Secure flag. */
  secureCookies: bool(process.env.SECURE_COOKIES, false),
  sessionDays: Number(process.env.SESSION_DAYS ?? 30),
  /** Send read receipts to senders when you open a chat. */
  sendReadReceipts: bool(process.env.SEND_READ_RECEIPTS, true),
  /** Send typing indicators while you type. */
  sendTypingIndicators: bool(process.env.SEND_TYPING_INDICATORS, true),
  /** Max upload size for outgoing attachments, in MB. */
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB ?? 100),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  /** Giphy API key for the GIF picker (free at developers.giphy.com). Without it the GIF tab explains how to add one. */
  giphyApiKey: process.env.GIPHY_API_KEY?.trim() || null,
  /** Giphy content rating: g, pg, pg-13 or r. */
  giphyRating: process.env.GIPHY_RATING?.trim() || 'pg-13',
};
