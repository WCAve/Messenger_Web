/**
 * Exporting chats (the Export window, components/Export.tsx). Runs in the browser: it pages through each
 * chat's messages, fetches the photos and files, makes small versions of the photos for the web page, and
 * puts it all in one ZIP (zip.ts), with a folder per chat:
 *
 *   chat.txt   WhatsApp's own export format ("11-11-2026 12:05 - Jan: Hoi"), readable by chat-statistics tools
 *   chat.html  looks like the chat; small photos built in, the full ones in media/ when clicked
 *   chat.json  everything per message, for programs
 *   chat.csv   one row per message, for Excel or Google Sheets
 *   media/     the photos, videos and files (when "Photos and files" is on)
 *
 * Deleted messages are exported as "This message was deleted" and edits only as "edited": what a deleted
 * message said and earlier versions of edited ones stay out (the owner's choice).
 */
import { api, attachmentUrl } from './api';
import { ZipWriter } from './zip';
import type { Attachment, Conversation, Message, StyleRange } from './types';

export type ExportFormat = 'txt' | 'html' | 'json' | 'csv';
export const EXPORT_FORMATS: { id: ExportFormat; label: string; hint: string }[] = [
  { id: 'html', label: 'Web page (.html)', hint: 'Looks like the chat, with photos. Opens in any browser.' },
  { id: 'txt', label: 'Text (.txt)', hint: 'WhatsApp’s own export format.' },
  { id: 'json', label: 'JSON (.json)', hint: 'Everything, for programs.' },
  { id: 'csv', label: 'Spreadsheet (.csv)', hint: 'One row per message, for Excel or Google Sheets.' },
];

export interface ExportOptions {
  formats: ExportFormat[];
  media: boolean; // photos and files in media/, and small photos in the web page
  from?: number; // ms, inclusive
  to?: number; // ms, exclusive
}

export interface ExportProgress {
  chat: number; // 1-based
  chats: number;
  title: string;
  messages: number;
  files: number;
  step: 'messages' | 'files' | 'writing';
}

/** A file in media/, or why it isn't there. */
interface MediaFile {
  path?: string; // relative to the chat's folder
  thumb?: string; // data: URL, for the web page
  missing?: boolean; // not on the server (never downloaded from WhatsApp, or gone)
}

const PAGE = 200;
const THUMB = 400; // px, longest side

export async function exportChats(chats: Conversation[], opts: ExportOptions, onProgress: (p: ExportProgress) => void, signal: AbortSignal): Promise<Blob> {
  const zip = new ZipWriter();
  const stamp = dateStamp(Date.now());
  const root = `Messenger export ${stamp}`;
  const usedFolders = new Set<string>();
  for (const [i, conv] of chats.entries()) {
    const progress: ExportProgress = { chat: i + 1, chats: chats.length, title: conv.title, messages: 0, files: 0, step: 'messages' };
    onProgress(progress);
    let folder = safeName(`${conv.title} (${conv.network === 'whatsapp' ? 'WhatsApp' : 'Signal'})`);
    for (let n = 2; usedFolders.has(folder); n++) folder = safeName(`${conv.title} (${conv.network === 'whatsapp' ? 'WhatsApp' : 'Signal'}) ${n}`);
    usedFolders.add(folder);
    const dir = `${root}/${folder}`;

    // Messages, oldest first
    const messages: Message[] = [];
    const seen = new Set<number>();
    let after = opts.from ? opts.from - 1 : 0;
    for (;;) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const page = await api.messagesAfter(conv.id, after, PAGE);
      for (const m of page) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        if (opts.to && m.sentAt >= opts.to) continue;
        if (m.outgoing && (m.status === 'failed' || m.status === 'pending')) continue; // never arrived anywhere
        messages.push(m);
      }
      progress.messages = messages.length;
      onProgress({ ...progress });
      if (page.length < PAGE || (opts.to && page[page.length - 1].sentAt >= opts.to)) break;
      after = page[page.length - 1].sentAt;
    }

    // Photos and files
    const media = new Map<string, MediaFile>();
    if (opts.media) {
      progress.step = 'files';
      const wantThumbs = opts.formats.includes('html');
      for (const m of messages) {
        if (m.deleted) continue;
        // Files from imported WhatsApp history that were never downloaded are left out: asking for them
        // would make the server fetch every one from WhatsApp Web, which it can't take in bulk.
        for (const a of m.attachments) if (a.pending) media.set(a.id, { missing: true });
        const items: { key: string; url: string; att: Partial<Attachment> & { contentType: string } }[] = m.attachments
          .filter((a) => !a.missing && !a.pending)
          .map((a) => ({ key: a.id, url: attachmentUrl(a.id), att: a }));
        if (m.sticker) items.push({ key: `sticker:${m.sticker.packId}:${m.sticker.stickerId}`, url: m.sticker.url, att: { contentType: 'image/webp', sticker: true } });
        for (const it of items) {
          if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
          const blob = await fetchFile(it.url, signal);
          if (!blob) {
            media.set(it.key, { missing: true });
            continue;
          }
          const path = zip.freeName(`${dir}/media/${fileName(m, it.att)}`);
          await zip.add(path, blob, false);
          const entry: MediaFile = { path: path.slice(dir.length + 1) };
          if (wantThumbs && it.att.contentType.startsWith('image/')) entry.thumb = (await thumbnail(blob, !!it.att.sticker)) ?? undefined;
          media.set(it.key, entry);
          progress.files++;
          onProgress({ ...progress });
        }
      }
    }

    progress.step = 'writing';
    onProgress({ ...progress });
    const ctx: Ctx = { conv, messages, media, withMedia: opts.media };
    if (opts.formats.includes('txt')) await zip.add(`${dir}/chat.txt`, toTxt(ctx));
    if (opts.formats.includes('html')) await zip.add(`${dir}/chat.html`, toHtml(ctx));
    if (opts.formats.includes('json')) await zip.add(`${dir}/chat.json`, toJson(ctx));
    if (opts.formats.includes('csv')) await zip.add(`${dir}/chat.csv`, toCsv(ctx));
  }
  return zip.finish();
}

export function exportFileName() {
  return `Messenger export ${dateStamp(Date.now())}.zip`;
}

// ---------------------------------------------------------------------------
// Fetching and naming files

async function fetchFile(url: string, signal: AbortSignal): Promise<Blob | null> {
  try {
    const res = await fetch(url, { signal, credentials: 'same-origin' });
    return res.ok ? await res.blob() : null; // 404: a WhatsApp history file that was never downloaded
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    return null;
  }
}

async function thumbnail(blob: Blob, keepTransparency: boolean): Promise<string | null> {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, THUMB / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    return canvas.toDataURL(keepTransparency || blob.type === 'image/png' ? 'image/webp' : 'image/jpeg', 0.72);
  } catch {
    return null; // not a picture the browser can read
  }
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'audio/ogg': 'ogg',
  'audio/ogg; codecs=opus': 'opus',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'application/pdf': 'pdf',
};

function fileName(m: Message, a: Partial<Attachment> & { contentType: string }) {
  const when = new Date(m.sentAt);
  const prefix = `${dateStamp(m.sentAt)} ${pad(when.getHours())}.${pad(when.getMinutes())}.${pad(when.getSeconds())}`;
  if (a.filename && !/^(image|video|audio|file|attachment|sticker)\.\w+$/i.test(a.filename)) return safeName(`${prefix} ${a.filename}`);
  const ext = EXT[a.contentType] ?? EXT[a.contentType.split(';')[0]] ?? a.contentType.split('/')[1]?.split(';')[0]?.replace(/[^a-z0-9]/gi, '') ?? 'bin';
  const kind = a.sticker ? 'sticker' : a.voiceNote ? 'voice' : a.contentType.split('/')[0];
  return safeName(`${prefix} ${kind}.${ext}`);
}

function safeName(s: string) {
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'chat';
}

// ---------------------------------------------------------------------------
// Formats

interface Ctx {
  conv: Conversation;
  messages: Message[];
  media: Map<string, MediaFile>;
  withMedia: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');
function dateStamp(t: number) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function dmy(t: number) {
  const d = new Date(t);
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
}
function hm(t: number) {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function deletedText(m: Message) {
  return m.outgoing ? 'You deleted this message' : 'This message was deleted';
}

function attachmentLabel(a: Partial<Attachment> & { contentType: string }) {
  if (a.sticker) return 'Sticker';
  if (a.gif) return 'GIF';
  if (a.voiceNote) return 'Voice message';
  const t = a.contentType;
  return t.startsWith('image/') ? 'Photo' : t.startsWith('video/') ? 'Video' : t.startsWith('audio/') ? 'Audio' : a.filename || 'File';
}

/** What a reply quotes: its text, or "Photo", "Sticker" … when it had none. */
function quoteText(m: Message) {
  return m.quote?.text || m.quote?.media?.label || '';
}

/** Poll as lines of text. */
function pollLines(m: Message) {
  if (!m.poll) return [];
  return [`POLL: ${m.poll.question}`, ...m.poll.options.map((o) => `OPTION: ${o.text} (${o.voters.length} vote${o.voters.length === 1 ? '' : 's'})`)];
}

// WhatsApp's Android export: "dd-mm-yyyy hh:mm - Name: text", files as "name (file attached)".
function toTxt({ conv, messages, media, withMedia }: Ctx) {
  const lines: string[] = [];
  for (const m of messages) {
    const head = `${dmy(m.sentAt)} ${hm(m.sentAt)} - `;
    if (m.kind === 'system') {
      lines.push(head + (m.body ?? ''));
      continue;
    }
    const parts: string[] = [];
    if (m.deleted) parts.push(deletedText(m));
    else {
      for (const a of m.attachments) {
        const f = media.get(a.id);
        parts.push(withMedia && f?.path ? `${f.path.replace(/^media\//, '')} (file attached)` : '<Media omitted>');
      }
      if (m.sticker) {
        const f = media.get(`sticker:${m.sticker.packId}:${m.sticker.stickerId}`);
        parts.push(withMedia && f?.path ? `${f.path.replace(/^media\//, '')} (file attached)` : '<Media omitted>');
      }
      parts.push(...pollLines(m));
      if (m.body && !m.poll) parts.push(m.body);
    }
    // WhatsApp's own: the note on the same line, after the text
    lines.push(`${head}${m.authorName}: ${parts.join('\n')}${m.edited && !m.deleted ? ' <This message was edited>' : ''}`);
  }
  void conv;
  return lines.join('\n') + '\n';
}

function toJson({ conv, messages, media, withMedia }: Ctx) {
  const file = (key: string) => (withMedia ? (media.get(key)?.path ?? null) : null);
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      chat: {
        title: conv.title,
        network: conv.network,
        kind: conv.kind,
        number: conv.number,
        members: conv.members?.map((p) => ({ name: p.name, id: p.key })) ?? undefined,
      },
      messages: messages.map((m) => ({
        id: m.id,
        sentAt: new Date(m.sentAt).toISOString(),
        author: m.author,
        authorName: m.authorName,
        outgoing: m.outgoing,
        kind: m.kind,
        text: m.deleted ? null : m.body,
        styles: m.deleted ? undefined : m.styles,
        mentions: m.deleted ? undefined : m.mentions?.map(({ start, length, name }) => ({ start, length, name })),
        attachments: m.deleted
          ? undefined
          : m.attachments.map((a) => ({
              type: attachmentLabel(a),
              contentType: a.contentType,
              filename: a.filename ?? null,
              size: a.size ?? null,
              width: a.width ?? null,
              height: a.height ?? null,
              caption: a.caption ?? null,
              file: file(a.id),
              notAvailable: a.missing || (withMedia && media.get(a.id)?.missing) || undefined,
            })),
        sticker: m.sticker && !m.deleted ? { emoji: m.sticker.emoji, file: file(`sticker:${m.sticker.packId}:${m.sticker.stickerId}`) } : undefined,
        replyTo: m.quote ? { authorName: m.quote.authorName, sentAt: new Date(m.quote.sentAt).toISOString(), text: quoteText(m) } : undefined,
        reactions: m.reactions.length ? m.reactions.map((r) => ({ emoji: r.emoji, authorName: r.authorName })) : undefined,
        poll: m.poll && !m.deleted ? { question: m.poll.question, multiple: m.poll.multiple, options: m.poll.options.map((o) => ({ text: o.text, voters: o.voters.map((v) => v.name) })) } : undefined,
        linkPreview: m.preview && !m.deleted ? { url: m.preview.url, title: m.preview.title ?? null, description: m.preview.description ?? null } : undefined,
        forwarded: m.forwarded ? true : undefined,
        edited: m.edited || undefined,
        deleted: m.deleted || undefined,
        status: m.outgoing ? m.status : undefined,
      })),
    },
    null,
    2,
  );
}

/** A cell. Text someone sent that starts like a formula (=, +, -, @) gets a ' in front, so a spreadsheet shows it instead of running it. */
function csvCell(v: string | number | boolean | null | undefined) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

function toCsv({ messages, media, withMedia }: Ctx) {
  const rows = [['Date', 'Time', 'Sender', 'From me', 'Text', 'Attachments', 'Reply to', 'Reactions', 'Edited', 'Deleted']];
  for (const m of messages) {
    const files = m.deleted
      ? []
      : [
          ...m.attachments.map((a) => (withMedia && media.get(a.id)?.path) || attachmentLabel(a)),
          ...(m.sticker ? [(withMedia && media.get(`sticker:${m.sticker.packId}:${m.sticker.stickerId}`)?.path) || 'Sticker'] : []),
        ];
    rows.push([
      dateStamp(m.sentAt),
      hm(m.sentAt),
      m.kind === 'system' ? '' : m.authorName,
      m.outgoing ? 'yes' : 'no',
      m.deleted ? deletedText(m) : m.poll ? pollLines(m).join('\n') : (m.body ?? ''),
      files.join('; '),
      m.quote ? `${m.quote.authorName}: ${quoteText(m)}` : '',
      m.reactions.map((r) => `${r.emoji} ${r.authorName}`).join('; '),
      m.edited ? 'yes' : '',
      m.deleted ? 'yes' : '',
    ]);
  }
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'; // BOM: Excel reads it as UTF-8
}

// ---------------------------------------------------------------------------
// Web page

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function linkify(s: string) {
  return esc(s).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (u) => `<a href="${u}" rel="noopener noreferrer">${u}</a>`);
}

/** Text with bold/italic/… and mentions, as HTML. Offsets are UTF-16, like the app's. */
function richHtml(text: string, styles: StyleRange[] = [], mentions: Message['mentions'] = []) {
  const cuts = new Set([0, text.length]);
  for (const r of [...styles, ...(mentions ?? [])]) {
    cuts.add(Math.max(0, r.start));
    cuts.add(Math.min(text.length, r.start + r.length));
  }
  const points = [...cuts].sort((a, b) => a - b);
  let out = '';
  for (let i = 0; i < points.length - 1; i++) {
    const [a, b] = [points[i], points[i + 1]];
    if (a >= b) continue;
    let seg = linkify(text.slice(a, b));
    const on = (s: string) => styles.some((r) => r.style === s && r.start <= a && r.start + r.length >= b);
    if ((mentions ?? []).some((r) => r.start <= a && r.start + r.length >= b)) seg = `<span class="mention">${seg}</span>`;
    if (on('MONOSPACE')) seg = `<code>${seg}</code>`;
    if (on('BOLD')) seg = `<b>${seg}</b>`;
    if (on('ITALIC')) seg = `<i>${seg}</i>`;
    if (on('STRIKETHROUGH')) seg = `<s>${seg}</s>`;
    if (on('SPOILER')) seg = `<span class="spoiler" title="Spoiler">${seg}</span>`;
    out += seg;
  }
  return out.replace(/\n/g, '<br>');
}

function hue(key: string) {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return h;
}

function mediaHtml(a: Partial<Attachment> & { contentType: string }, f: MediaFile | undefined, withMedia: boolean) {
  const label = attachmentLabel(a);
  const icon = a.contentType.startsWith('image/') ? '📷' : a.contentType.startsWith('video/') ? '🎬' : a.contentType.startsWith('audio/') ? '🎤' : '📎';
  if (!withMedia || !f || f.missing || !f.path) {
    const why = withMedia && (f?.missing || a.missing) ? ' (not available)' : '';
    return `<div class="file">${icon} ${esc(label)}${why}</div>`;
  }
  const href = esc(f.path.split('/').map(encodeURIComponent).join('/'));
  if (f.thumb) {
    const cls = a.sticker ? 'sticker' : 'photo';
    return `<a class="${cls}" href="${href}" target="_blank"><img src="${f.thumb}" alt="${esc(label)}" loading="lazy"></a>`;
  }
  if (a.contentType.startsWith('video/')) return `<video class="photo" src="${href}" controls preload="metadata"${a.gif ? ' loop muted' : ''}></video>`;
  if (a.contentType.startsWith('audio/')) return `<audio src="${href}" controls preload="none"></audio>`;
  return `<a class="file" href="${href}" target="_blank">${icon} ${esc(a.filename || label)}</a>`;
}

function toHtml({ conv, messages, media, withMedia }: Ctx) {
  const group = conv.kind === 'group';
  const net = conv.network === 'whatsapp' ? 'WhatsApp' : 'Signal';
  const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  let lastDay = '';
  const body: string[] = [];
  for (const m of messages) {
    const day = dateStamp(m.sentAt);
    if (day !== lastDay) {
      body.push(`<div class="day"><span>${esc(dayFmt.format(new Date(m.sentAt)))}</span></div>`);
      lastDay = day;
    }
    if (m.kind === 'system') {
      body.push(`<div class="system">${esc(m.body ?? '')}</div>`);
      continue;
    }
    const parts: string[] = [];
    if (group && !m.outgoing) parts.push(`<div class="who" style="color:hsl(${hue(m.author)} 55% var(--name-l))">${esc(m.authorName)}</div>`);
    if (m.deleted) parts.push(`<div class="text deleted">🚫 ${esc(deletedText(m))}</div>`);
    else {
      if (m.forwarded) parts.push(`<div class="forwarded">↪ Forwarded</div>`);
      if (m.quote) parts.push(`<div class="quote"><b>${esc(m.quote.authorName)}</b><br>${esc(quoteText(m))}</div>`);
      for (const a of m.attachments) parts.push(mediaHtml(a, media.get(a.id), withMedia));
      if (m.sticker) parts.push(mediaHtml({ contentType: 'image/webp', sticker: true }, media.get(`sticker:${m.sticker.packId}:${m.sticker.stickerId}`), withMedia));
      if (m.poll)
        parts.push(
          `<div class="poll"><b>📊 ${esc(m.poll.question)}</b><ul>${m.poll.options
            .map((o) => `<li>${esc(o.text)} <span class="votes">${o.voters.length}${o.voters.length ? ` · ${esc(o.voters.map((v) => v.name).join(', '))}` : ''}</span></li>`)
            .join('')}</ul></div>`,
        );
      if (m.preview?.title && /^https?:\/\//i.test(m.preview.url)) parts.push(`<a class="preview" href="${esc(m.preview.url)}" rel="noopener noreferrer"><b>${esc(m.preview.title)}</b>${m.preview.description ? `<br>${esc(m.preview.description)}` : ''}</a>`);
      if (m.body && !m.poll) parts.push(`<div class="text">${richHtml(m.body, m.styles, m.mentions)}</div>`);
    }
    parts.push(`<div class="meta">${m.edited && !m.deleted ? 'edited · ' : ''}${hm(m.sentAt)}</div>`);
    const reactions = m.reactions.length
      ? `<div class="reactions" title="${esc(m.reactions.map((r) => `${r.emoji} ${r.authorName}`).join('\n'))}">${esc(
          [...new Set(m.reactions.map((r) => r.emoji))].join(''),
        )}${m.reactions.length > 1 ? ` ${m.reactions.length}` : ''}</div>`
      : '';
    body.push(`<div class="row ${m.outgoing ? 'out' : 'in'}" id="m${m.id}"><div class="bubble">${parts.join('')}</div>${reactions}</div>`);
  }
  const first = messages[0]?.sentAt;
  const last = messages[messages.length - 1]?.sentAt;
  const span = first ? `${dmy(first)} – ${dmy(last!)} · ` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(conv.title)} (${net})</title>
<style>
:root{--bg:#efeae2;--in:#fff;--out:#d9fdd3;--ink:#111b21;--muted:#667781;--line:#d1d7db;--name-l:38%;--link:#027eb5;--chip:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0b141a;--in:#202c33;--out:#005c4b;--ink:#e9edef;--muted:#8696a0;--line:#2a3942;--name-l:70%;--link:#53bdeb;--chip:#202c33}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{position:sticky;top:0;z-index:1;background:var(--chip);border-bottom:1px solid var(--line);padding:12px 16px}
header h1{margin:0;font-size:18px}
header p{margin:2px 0 0;color:var(--muted);font-size:13px}
main{max-width:820px;margin:0 auto;padding:12px 16px 40px}
.day{text-align:center;margin:16px 0 8px}
.day span{background:var(--chip);color:var(--muted);font-size:12.5px;padding:4px 10px;border-radius:8px}
.system{text-align:center;color:var(--muted);font-size:13px;margin:6px 0}
.row{display:flex;flex-direction:column;margin:3px 0}
.row.out{align-items:flex-end}
.row.in{align-items:flex-start}
.bubble{max-width:min(78%,560px);background:var(--in);border-radius:10px;padding:6px 9px 4px;overflow-wrap:anywhere;box-shadow:0 1px 1px rgba(0,0,0,.08)}
.out .bubble{background:var(--out)}
.who{font-weight:600;font-size:13.5px;margin-bottom:2px}
.text.deleted{color:var(--muted);font-style:italic}
.forwarded{color:var(--muted);font-size:12.5px;font-style:italic}
.meta{text-align:right;color:var(--muted);font-size:11.5px;margin-top:2px}
.quote{border-left:4px solid var(--link);background:rgba(0,0,0,.05);border-radius:6px;padding:4px 8px;margin-bottom:4px;font-size:13.5px;color:var(--muted)}
.quote b{color:var(--ink)}
.photo img,video.photo{display:block;max-width:100%;max-height:420px;border-radius:7px;margin:2px 0}
.sticker img{width:150px;height:150px;object-fit:contain}
.file{display:block;padding:6px 0;color:var(--link)}
div.file{color:var(--muted)}
audio{max-width:100%;margin:4px 0}
.preview{display:block;background:rgba(0,0,0,.05);border-radius:6px;padding:6px 8px;margin-bottom:4px;color:inherit;text-decoration:none;font-size:13.5px}
.poll ul{margin:4px 0 2px;padding-left:18px}
.votes{color:var(--muted);font-size:12.5px}
.reactions{background:var(--chip);border:1px solid var(--line);border-radius:12px;font-size:13px;padding:0 6px;margin:-4px 8px 4px}
a{color:var(--link)}
code{font-family:ui-monospace,monospace;font-size:.92em}
.mention{color:var(--link);font-weight:600}
.spoiler{background:var(--muted);color:transparent;border-radius:3px}
.spoiler:hover{color:inherit;background:none}
</style>
</head>
<body>
<header><h1>${esc(conv.title)}</h1><p>${net}${group ? ' group' : ''} · ${span}${messages.length} message${messages.length === 1 ? '' : 's'} · exported ${esc(dmy(Date.now()))} with Messenger Web</p></header>
<main>
${body.join('\n')}
</main>
</body>
</html>
`;
}
