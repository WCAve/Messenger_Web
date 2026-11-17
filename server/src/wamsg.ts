/**
 * What a WhatsApp message from WAHA says, whichever engine sent it. The top-level fields (id, from, body,
 * hasMedia, media, replyTo …) are the same for every engine; the details are in `_data`, which differs:
 *
 *   WEBJS  whatsapp-web.js's own message: { type, notifyName, mimetype, size, isViewOnce, mentionedJidList,
 *          pinParentKey, parentMsgKey … }
 *   GOWS   whatsmeow's event: { Info: { Chat, Sender, ID, PushName, … }, Message: <WhatsApp's protobuf
 *          message, Go field names: stanzaID, mentionedJID, JPEGThumbnail, PTT …> }
 *   NOWEB  Baileys: { key, pushName, message: <the same protobuf message, JS field names> }
 *
 * `waFacts` reads either into one shape, so the rest of whatsapp.ts doesn't care. The protobuf message is
 * read with JS-style names (GOWS's are converted the way WAHA itself does: "mentionedJID" → "mentionedJid").
 */
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** "mentionedJID" → "mentionedJid", "JPEGThumbnail" → "jpegThumbnail", "PTT" → "ptt" (like lodash.camelCase). */
export function camelKey(k: string): string {
  const words = k.match(/[A-Z]{2,}(?=[A-Z][a-z]|[0-9]|$)|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g);
  if (!words) return k;
  return words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('');
}

export function camelKeysDeep(x: unknown, depth = 0): Json {
  if (depth > 40) return x;
  if (Array.isArray(x)) return x.map((v) => camelKeysDeep(v, depth + 1));
  if (x && typeof x === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) out[camelKey(k)] = camelKeysDeep(v, depth + 1);
    return out;
  }
  return x;
}

/** The protobuf message (JS field names), or null for WEBJS, which doesn't pass it on. */
export function protoOf(m: Json): Json | null {
  const d = m?._data;
  if (!d || typeof d !== 'object') return null;
  if (d.Message && typeof d.Message === 'object') return camelKeysDeep(d.Message);
  if (d.message && typeof d.message === 'object') return d.message;
  return null;
}

/** Wrappers around the real content (disappearing, view-once, captioned documents, edits). */
function unwrap(msg: Json): { content: Json; viewOnce: boolean } {
  let content = msg ?? {};
  let viewOnce = false;
  for (let i = 0; i < 5; i++) {
    const inner =
      content.ephemeralMessage?.message ??
      content.viewOnceMessage?.message ??
      content.viewOnceMessageV2?.message ??
      content.viewOnceMessageV2Extension?.message ??
      content.documentWithCaptionMessage?.message ??
      content.deviceSentMessage?.message;
    if (!inner) break;
    if (content.viewOnceMessage || content.viewOnceMessageV2 || content.viewOnceMessageV2Extension) viewOnce = true;
    content = inner;
  }
  return { content, viewOnce };
}

const MEDIA_KEYS: [string, string][] = [
  ['imageMessage', 'image'],
  ['videoMessage', 'video'],
  ['ptvMessage', 'video'],
  ['audioMessage', 'audio'],
  ['documentMessage', 'document'],
  ['stickerMessage', 'sticker'],
];

export interface WaFacts {
  /**
   * WEBJS-style type: chat, image, video, ptt, audio, document, sticker, poll_creation, pinned_message,
   * call_log, gp2 (WEBJS group notice), vcard, location, or 'ignore' for things that aren't messages of
   * their own (reactions, edits, deletions, poll votes, key exchanges: they come as their own events).
   */
  type: string;
  pushName: string | null;
  mimetype: string | null;
  filename: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  gif: boolean;
  viewOnce: boolean;
  forwarded: boolean;
  forwardingScore: number;
  mentions: string[];
  /** WhatsApp's tiny preview of a photo or video (base64 JPEG) */
  thumbnail: string | null;
  pin: { unpin: boolean; parent: string | null; seconds: number | null } | null;
  /** The original's raw id, when this is WhatsApp's HD copy of a photo or video */
  hdParent: string | null;
  /** The phone number behind a privacy id (GOWS tells it with the message): [lid, pn] */
  lidPair: [string, string] | null;
}

function keyId(k: Json): string | null {
  if (!k) return null;
  if (typeof k === 'string') return k;
  if (typeof k._serialized === 'string') return k._serialized;
  if (typeof k.id === 'string') return k.id;
  if (k.id && typeof k.id === 'object') return keyId(k.id);
  return null;
}

const num = (v: unknown) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export function waFacts(m: Json): WaFacts {
  const d = m?._data ?? {};
  const proto = protoOf(m);
  if (!proto) return webjsFacts(m, d);

  const { content, viewOnce: wrappedOnce } = unwrap(proto);
  const info = d.Info ?? {};
  let type = 'ignore';
  let media: Json = null;
  for (const [k, t] of MEDIA_KEYS) {
    if (content[k]) {
      media = content[k];
      type = t;
      break;
    }
  }
  if (type === 'audio' && media?.ptt) type = 'ptt';
  if (type === 'ignore') {
    if (typeof content.conversation === 'string' || content.extendedTextMessage) type = 'chat';
    else if (content.pollCreationMessage || content.pollCreationMessageV2 || content.pollCreationMessageV3 || content.pollCreationMessageV5) type = 'poll_creation';
    else if (content.pinInChatMessage) type = 'pinned_message';
    else if (content.contactMessage || content.contactsArrayMessage) type = 'vcard';
    else if (content.locationMessage || content.liveLocationMessage) type = 'location';
  }
  const ctx = (media ?? content.extendedTextMessage ?? content.contactMessage ?? content.locationMessage ?? content.pollCreationMessageV3 ?? content.pollCreationMessage ?? {}).contextInfo ?? {};

  let pin: WaFacts['pin'] = null;
  if (content.pinInChatMessage) {
    const p = content.pinInChatMessage;
    const secs = num(proto.messageContextInfo?.messageAddOnDurationInSecs ?? content.messageContextInfo?.messageAddOnDurationInSecs);
    pin = { unpin: Number(p.type) === 2 || p.type === 'UNPIN_FOR_ALL', parent: keyId(p.key), seconds: secs && secs > 0 ? secs : null };
  }

  // HD copy: messageContextInfo.messageAssociation { associationType HD_IMAGE/VIDEO_DUAL_UPLOAD, parentMessageKey }
  const assoc = proto.messageContextInfo?.messageAssociation ?? content.messageContextInfo?.messageAssociation;
  const at = assoc?.associationType;
  const hd = assoc && (/DUAL_UPLOAD/.test(String(at)) || [5, 10].includes(Number(at)));
  const hdParent = hd ? keyId(assoc.parentMessageKey) : null;

  const sender = String(info.Sender ?? '');
  const alt = String(info.SenderAlt ?? '');
  const lidPair: [string, string] | null = sender.includes('@lid') && /@s\.whatsapp\.net|@c\.us/.test(alt) ? [sender, alt] : alt.includes('@lid') && /@s\.whatsapp\.net|@c\.us/.test(sender) ? [alt, sender] : null;

  const thumb = media?.jpegThumbnail;
  return {
    type,
    pushName: info.PushName || d.pushName || null,
    mimetype: media?.mimetype ?? null,
    filename: media?.fileName ?? null,
    size: num(media?.fileLength),
    width: num(media?.width),
    height: num(media?.height),
    gif: !!media?.gifPlayback,
    viewOnce: wrappedOnce || !!media?.viewOnce,
    forwarded: !!ctx.isForwarded,
    forwardingScore: Number(ctx.forwardingScore ?? 0) || 0,
    mentions: Array.isArray(ctx.mentionedJid) ? ctx.mentionedJid.map(String) : [],
    thumbnail: typeof thumb === 'string' && thumb.length < 40_000 ? thumb : null,
    pin,
    hdParent,
    lidPair,
  };
}

function webjsFacts(m: Json, d: Json): WaFacts {
  const t = String(d.type ?? (m.hasMedia ? 'document' : 'chat'));
  let pin: WaFacts['pin'] = null;
  if (t === 'pinned_message' || d.pinMessageType != null) {
    const s = num(d.pinExpiryDuration ?? d.pinDuration);
    pin = { unpin: Number(d.pinMessageType) === 2, parent: keyId(d.pinParentKey ?? d.parentMsgKey), seconds: s && s > 0 ? s : null };
  }
  const hdParent = /DUAL_UPLOAD/.test(String(d.associationType ?? '')) ? keyId(d.parentMsgKey) : null;
  const body = typeof d.body === 'string' ? d.body : '';
  return {
    type: pin ? 'pinned_message' : t === 'poll_creation' || d.pollName ? 'poll_creation' : t,
    pushName: d.notifyName ?? d.pushName ?? null,
    mimetype: d.mimetype ?? null,
    filename: d.filename ?? null,
    size: num(d.size),
    width: num(d.width),
    height: num(d.height),
    gif: !!d.isGif,
    viewOnce: !!(d.isViewOnce ?? m.isViewOnce),
    forwarded: !!(d.isForwarded || m.isForwarded),
    forwardingScore: Number(d.forwardingScore ?? m.forwardingScore ?? 0) || 0,
    mentions: (Array.isArray(d.mentionedJidList) ? d.mentionedJidList : Array.isArray(m.mentionedIds) ? m.mentionedIds : []).map((x: Json) => keyId(x) ?? String(x)),
    thumbnail: body.length < 40_000 && /^\/9j\//.test(body) ? body : null,
    pin,
    hdParent,
    lidPair: null,
  };
}

/** The mentions in an edit (message.edited): GOWS keeps them in the edited message inside the event. */
export function editMentions(p: Json): string[] {
  const proto = protoOf(p);
  if (!proto) return waFacts(p).mentions;
  const edited = unwrap(proto).content.protocolMessage?.editedMessage ?? unwrap(proto).content.editedMessage?.message?.protocolMessage?.editedMessage;
  if (!edited) return [];
  return waFacts({ _data: { message: edited } }).mentions;
}

/** A poll's question and options from the protobuf message (GOWS/NOWEB), or null. */
export function protoPoll(m: Json): { question: string; options: string[]; multiple: boolean } | null {
  const proto = protoOf(m);
  if (!proto) return null;
  const c = unwrap(proto).content;
  const pc = c.pollCreationMessage ?? c.pollCreationMessageV2 ?? c.pollCreationMessageV3 ?? c.pollCreationMessageV5;
  if (!pc) return null;
  const options = (pc.options ?? []).map((o: Json) => String(o.optionName ?? ''));
  if (!options.length) return null;
  return { question: String(pc.name ?? m.body ?? ''), options, multiple: Number(pc.selectableOptionsCount ?? 0) !== 1 };
}
