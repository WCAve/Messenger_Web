/**
 * Thin client for bbernhard/signal-cli-rest-api.
 * Only the endpoints Signal Web needs; see https://bbernhard.github.io/signal-cli-rest-api/
 */
import { config } from './config.js';

export class SignalApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
  const res = await fetch(config.signalApiUrl + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      msg = JSON.parse(text).error ?? msg;
    } catch {
      /* not json */
    }
    throw new SignalApiError(`${method} ${path} failed (${res.status}): ${msg}`, res.status);
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

const enc = encodeURIComponent;

export interface About {
  versions: string[];
  build: number;
  mode: string;
  version: string;
  capabilities?: Record<string, string[]>;
}

export interface ApiContact {
  number: string;
  uuid: string;
  name: string;
  profile_name: string;
  username: string;
  blocked: boolean;
  given_name: string;
  profile?: { given_name?: string; lastname?: string; about?: string; has_avatar?: boolean };
  nickname?: { name?: string; given_name?: string; family_name?: string };
}

export interface ApiGroup {
  name: string;
  description: string;
  id: string; // "group.<base64>" — used as recipient
  internal_id: string; // signal-cli internal id, as seen in envelopes
  members: string[];
  blocked: boolean;
  member?: boolean;
  admins?: string[];
}

export const signalApi = {
  about: () => call<About>('GET', '/v1/about', undefined, 10_000),
  accounts: () => call<string[]>('GET', '/v1/accounts', undefined, 10_000),

  /** allRecipients also returns people who aren't in your address book (e.g. group members), with their profile names. */
  contacts: (number: string, allRecipients = false) =>
    call<ApiContact[]>('GET', `/v1/contacts/${enc(number)}${allRecipients ? '?all_recipients=true' : ''}`),
  groups: (number: string) => call<ApiGroup[]>('GET', `/v1/groups/${enc(number)}`),

  send: (body: {
    number: string;
    recipients: string[];
    message: string;
    base64_attachments?: string[];
    quote_timestamp?: number;
    quote_author?: string;
    quote_message?: string;
    edit_timestamp?: number;
    text_mode?: 'normal' | 'styled';
  }) => call<{ timestamp: string | number }>('POST', '/v2/send', body, 180_000),

  react: (number: string, body: { recipient: string; reaction: string; target_author: string; timestamp: number }) =>
    call<void>('POST', `/v1/reactions/${enc(number)}`, body),
  unreact: (number: string, body: { recipient: string; reaction: string; target_author: string; timestamp: number }) =>
    call<void>('DELETE', `/v1/reactions/${enc(number)}`, body),

  receipt: (number: string, body: { recipient: string; receipt_type: 'read' | 'viewed'; timestamp: number }) =>
    call<void>('POST', `/v1/receipts/${enc(number)}`, body),

  typing: (number: string, recipient: string, started: boolean) =>
    call<void>(started ? 'PUT' : 'DELETE', `/v1/typing-indicator/${enc(number)}`, { recipient }),

  remoteDelete: (number: string, recipient: string, timestamp: number) =>
    call<unknown>('DELETE', `/v1/remote-delete/${enc(number)}`, { recipient, timestamp }),

  /** Returns a PNG with the device-link QR code. */
  async linkQr(deviceName: string): Promise<Buffer> {
    const res = await fetch(`${config.signalApiUrl}/v1/qrcodelink?device_name=${enc(deviceName)}`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new SignalApiError(`QR code request failed (${res.status}): ${await res.text()}`, res.status);
    return Buffer.from(await res.arrayBuffer());
  },

  /** Streams an attachment that signal-cli downloaded. */
  async attachment(id: string): Promise<Response> {
    const res = await fetch(`${config.signalApiUrl}/v1/attachments/${enc(id)}`, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new SignalApiError(`Attachment ${id} not available (${res.status})`, res.status);
    return res;
  },

  /** Profile picture of a person, or a group's avatar. Resolves null when there is none. */
  async avatar(number: string, kind: 'profile' | 'group', id: string): Promise<{ data: Buffer; type: string } | null> {
    const path = kind === 'group' ? `/v1/groups/${enc(number)}/${enc(id)}/avatar` : `/v1/contacts/${enc(number)}/${enc(id)}/avatar`;
    const res = await fetch(config.signalApiUrl + path, { signal: AbortSignal.timeout(30_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new SignalApiError(`avatar ${res.status}`, res.status);
    const data = Buffer.from(await res.arrayBuffer());
    if (!data.length) return null;
    return { data, type: res.headers.get('content-type') ?? 'application/octet-stream' };
  },

  receiveUrl(number: string): string {
    return config.signalApiUrl.replace(/^http/, 'ws') + `/v1/receive/${enc(number)}`;
  },
};

/** signal-cli-rest-api addresses groups as "group." + base64(internal_id). */
export function groupRecipientId(internalId: string): string {
  return 'group.' + Buffer.from(internalId, 'utf8').toString('base64');
}
