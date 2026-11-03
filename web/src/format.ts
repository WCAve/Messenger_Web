/**
 * Text formatting the WhatsApp way in the message box: *bold*, _italic_, ~strike~, `mono` or
 * ```mono```, and ||spoiler|| (Signal's). Turned into Signal's plain text + style ranges on send.
 */
import type { RichText } from './api';
import type { Message, StyleRange, TextStyle } from './types';

const MARKERS: { mark: string; style: TextStyle }[] = [
  { mark: '```', style: 'MONOSPACE' },
  { mark: '||', style: 'SPOILER' },
  { mark: '*', style: 'BOLD' },
  { mark: '_', style: 'ITALIC' },
  { mark: '~', style: 'STRIKETHROUGH' },
  { mark: '`', style: 'MONOSPACE' },
];

const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;

function openerAt(s: string, i: number, end: number) {
  const before = s[i - 1];
  if (before !== undefined && WORD.test(before)) return null; // not in the middle of a word (snake_case)
  for (const m of MARKERS) {
    if (!s.startsWith(m.mark, i)) continue;
    const next = s[i + m.mark.length];
    if (i + m.mark.length >= end || SPACE.test(next) || next === m.mark[0]) return null;
    return m;
  }
  return null;
}

function closerFrom(s: string, from: number, end: number, m: { mark: string; style: TextStyle }) {
  for (let j = from + 1; j + m.mark.length <= end; j++) {
    const c = s[j - 1];
    if (c === '\n' && m.mark !== '```') return -1; // inline styles stay on one line
    if (!s.startsWith(m.mark, j) || SPACE.test(c)) continue;
    const after = s[j + m.mark.length];
    if (after !== undefined && (WORD.test(after) || after === m.mark[0])) continue;
    return j;
  }
  return -1;
}

/** Strip the markers and return the plain text with style ranges. */
export function parseMarkup(input: string): { text: string; styles: StyleRange[] } {
  let out = '';
  const styles: StyleRange[] = [];
  const walk = (start: number, end: number) => {
    let i = start;
    while (i < end) {
      const m = openerAt(input, i, end);
      if (m) {
        const close = closerFrom(input, i + m.mark.length, end, m);
        if (close > 0) {
          const s0 = out.length;
          if (m.style === 'MONOSPACE') out += input.slice(i + m.mark.length, close);
          else walk(i + m.mark.length, close);
          if (out.length > s0) styles.push({ start: s0, length: out.length - s0, style: m.style });
          i = close + m.mark.length;
          continue;
        }
      }
      out += input[i];
      i++;
    }
  };
  walk(0, input.length);
  return { text: out, styles };
}

export interface ComposerMention {
  name: string; // as inserted, without the @
  key: string;
}

/**
 * The message box text → what the server sends: markers become styles and each "@Name" you picked
 * from the suggestions becomes a real mention (a U+FFFC placeholder plus a mention range).
 */
export function composerToRich(raw: string, mentions: ComposerMention[]): RichText {
  const { text, styles } = parseMarkup(raw);
  // Find the picked mentions in the plain text; longest names first so "Ann" doesn't eat "Anna".
  const names = [...new Map(mentions.map((m) => [m.name, m])).values()].sort((a, b) => b.name.length - a.name.length);
  const found: { start: number; end: number; key: string }[] = [];
  for (const m of names) {
    const needle = '@' + m.name;
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      if (WORD.test(text[end] ?? '')) continue;
      if (found.some((f) => at < f.end && end > f.start)) continue;
      found.push({ start: at, end, key: m.key });
    }
  }
  found.sort((a, b) => a.start - b.start);
  if (!found.length) return { text, styles: styles.length ? styles : undefined };

  // Replace each with U+FFFC and move the style ranges along.
  let out = '';
  let pos = 0;
  const outMentions: NonNullable<RichText['mentions']> = [];
  for (const f of found) {
    out += text.slice(pos, f.start);
    outMentions.push({ start: out.length, length: 1, key: f.key });
    out += '￼';
    pos = f.end;
  }
  out += text.slice(pos);
  const map = (p: number, isEnd: boolean) => {
    let d = 0;
    for (const f of found) {
      if (p <= f.start) break;
      if (p >= f.end) {
        d += f.end - f.start - 1;
        continue;
      }
      return f.start - d + (isEnd ? 1 : 0);
    }
    return p - d;
  };
  const moved = styles
    .map((s) => {
      const start = map(s.start, false);
      const end = map(s.start + s.length, true);
      return { start, length: end - start, style: s.style };
    })
    .filter((s) => s.length > 0);
  return { text: out, styles: moved.length ? moved : undefined, mentions: outMentions };
}

const MARK_OUT: Record<TextStyle, string> = { BOLD: '*', ITALIC: '_', STRIKETHROUGH: '~', MONOSPACE: '`', SPOILER: '||' };

/** A message back into message-box text (for editing), with its mentions. */
export function messageToComposer(m: Message): { text: string; mentions: ComposerMention[] } {
  const body = m.body ?? '';
  const styles = [...(m.styles ?? [])].sort((a, b) => a.start - b.start || b.length - a.length);
  const opens = new Map<number, StyleRange[]>();
  const closes = new Map<number, StyleRange[]>();
  for (const s of styles) {
    (opens.get(s.start) ?? opens.set(s.start, []).get(s.start)!).push(s);
    const end = s.start + s.length;
    (closes.get(end) ?? closes.set(end, []).get(end)!).unshift(s);
  }
  const mark = (s: StyleRange) => (s.style === 'MONOSPACE' && body.slice(s.start, s.start + s.length).includes('\n') ? '```' : MARK_OUT[s.style]);
  let text = '';
  for (let i = 0; i <= body.length; i++) {
    for (const s of closes.get(i) ?? []) text += mark(s);
    for (const s of opens.get(i) ?? []) text += mark(s);
    if (i < body.length) text += body[i];
  }
  const mentions = (m.mentions ?? []).filter((x) => x.key !== 'self').map((x) => ({ name: x.name, key: x.key }));
  return { text, mentions };
}

// ---------------------------------------------------------------------------
// Rendering: cut the body into pieces that each have one set of styles / one mention / one link.

const URL_RE = /https?:\/\/[^\s<]+[^\s<.,:;"')\]!?]/g;

export interface Piece {
  text: string;
  styles: Set<TextStyle>;
  mention?: { key: string; name: string };
  link?: string;
  spoilerId?: number; // index of the spoiler range, so a click reveals all of it
}

export function pieces(body: string, styles: StyleRange[] = [], mentions: Message['mentions'] = []): Piece[] {
  const links = [...body.matchAll(URL_RE)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, url: m[0] }));
  const cuts = new Set<number>([0, body.length]);
  for (const s of styles) cuts.add(s.start).add(s.start + s.length);
  for (const m of mentions ?? []) cuts.add(m.start).add(m.start + m.length);
  for (const l of links) cuts.add(l.start).add(l.end);
  const points = [...cuts].filter((p) => p >= 0 && p <= body.length).sort((a, b) => a - b);
  const spoilers = styles.filter((s) => s.style === 'SPOILER');
  const out: Piece[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (b <= a) continue;
    const inside = (s: { start: number; length: number }) => s.start <= a && s.start + s.length >= b;
    const set = new Set<TextStyle>(styles.filter(inside).map((s) => s.style));
    const mention = (mentions ?? []).find(inside);
    const link = links.find((l) => l.start <= a && l.end >= b);
    const spoilerId = spoilers.findIndex(inside);
    out.push({
      text: body.slice(a, b),
      styles: set,
      mention: mention ? { key: mention.key, name: mention.name } : undefined,
      link: mention ? undefined : link?.url,
      spoilerId: spoilerId >= 0 ? spoilerId : undefined,
    });
  }
  return out;
}

/** For notifications: spoilers stay hidden. */
export function hideSpoilers(body: string, styles: StyleRange[] = []): string {
  let t = body;
  for (const s of styles.filter((x) => x.style === 'SPOILER').sort((a, b) => b.start - a.start)) {
    t = t.slice(0, s.start) + '■■■' + t.slice(s.start + s.length);
  }
  return t;
}
