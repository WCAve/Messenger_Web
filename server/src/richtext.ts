/**
 * Mentions and text styles (bold, italic, …) the way Signal stores them: a plain body where each
 * mention is a U+FFFC placeholder, plus ranges in UTF-16 offsets (which is what JS strings use).
 */

export const STYLES = ['BOLD', 'ITALIC', 'STRIKETHROUGH', 'MONOSPACE', 'SPOILER'] as const;
export type Style = (typeof STYLES)[number];

export interface MentionRange {
  start: number;
  length: number;
  key: string; // contact key, or 'self'
}
export interface StyleRange {
  start: number;
  length: number;
  style: Style;
}
export interface Ranges {
  mentions?: MentionRange[];
  styles?: StyleRange[];
}

export const PLACEHOLDER = '￼';

const isStyle = (s: unknown): s is Style => typeof s === 'string' && (STYLES as readonly string[]).includes(s);

function validRange(r: { start?: unknown; length?: unknown }, textLength: number) {
  return (
    Number.isInteger(r.start) &&
    Number.isInteger(r.length) &&
    (r.start as number) >= 0 &&
    (r.length as number) > 0 &&
    (r.start as number) + (r.length as number) <= textLength
  );
}

/** Keep only well-formed ranges; drop mentions that overlap an earlier one. */
export function cleanRanges(text: string, ranges: { mentions?: unknown; styles?: unknown }): Ranges | null {
  const mentions: MentionRange[] = [];
  const styles: StyleRange[] = [];
  if (Array.isArray(ranges.mentions)) {
    const sorted = (ranges.mentions as MentionRange[]).filter((m) => m && validRange(m, text.length) && typeof m.key === 'string' && m.key).sort((a, b) => a.start - b.start);
    let end = 0;
    for (const m of sorted) {
      if (m.start < end) continue;
      mentions.push({ start: m.start, length: m.length, key: m.key });
      end = m.start + m.length;
    }
  }
  if (Array.isArray(ranges.styles)) {
    for (const s of ranges.styles as StyleRange[]) {
      if (s && validRange(s, text.length) && isStyle(s.style)) styles.push({ start: s.start, length: s.length, style: s.style });
    }
  }
  if (!mentions.length && !styles.length) return null;
  return { ...(mentions.length ? { mentions } : {}), ...(styles.length ? { styles } : {}) };
}

export interface Rendered {
  text: string;
  mentions: (MentionRange & { name: string })[];
  styles: StyleRange[];
}

/** Replace each mention range with "@Name" and move the style ranges along. */
export function renderRich(body: string, ranges: Ranges | null, nameFor: (key: string) => string): Rendered {
  const segs: { rs: number; re: number; os: number; oe: number }[] = [];
  const mentions: Rendered['mentions'] = [];
  let out = '';
  let pos = 0;
  for (const m of ranges?.mentions ?? []) {
    if (m.start < pos || m.start + m.length > body.length) continue;
    out += body.slice(pos, m.start);
    const name = nameFor(m.key);
    const os = out.length;
    out += '@' + name;
    segs.push({ rs: m.start, re: m.start + m.length, os, oe: out.length });
    mentions.push({ start: os, length: out.length - os, key: m.key, name });
    pos = m.start + m.length;
  }
  out += body.slice(pos);
  const map = (p: number, isEnd: boolean) => {
    let d = 0;
    for (const s of segs) {
      if (p <= s.rs) break;
      if (p >= s.re) {
        d = s.oe - s.re;
        continue;
      }
      return isEnd ? s.oe : s.os; // inside a mention: stretch to cover the whole name
    }
    return p + d;
  };
  const styles: StyleRange[] = [];
  for (const s of ranges?.styles ?? []) {
    const start = map(s.start, false);
    const end = map(s.start + s.length, true);
    if (end > start) styles.push({ start, length: end - start, style: s.style });
  }
  return { text: out, mentions, styles };
}

/** Plain-text version for chat previews and notifications: spoilers stay hidden. */
export function plainText(r: Rendered): string {
  const spoilers = r.styles.filter((s) => s.style === 'SPOILER').sort((a, b) => b.start - a.start);
  let t = r.text;
  for (const s of spoilers) t = t.slice(0, s.start) + '■■■' + t.slice(s.start + s.length);
  return t;
}

// ---------------------------------------------------------------------------
// signal-cli-rest-api's text_mode "styled" markup (utils/textstyleparser.go):
//   *italic*  **bold**  ***bold italic***  ~strike~  `mono`  ||spoiler||, backslash escapes * ` | ~

const MARK: Record<Style, string> = { ITALIC: '*', BOLD: '**', STRIKETHROUGH: '~', MONOSPACE: '`', SPOILER: '||' };

/** A port of the REST API's parser, used to check that our markup round-trips exactly. */
export function parseApiMarkup(input: string): { text: string; styles: StyleRange[] } {
  const chars = Array.from(input); // code points, like Go's rune loop
  let out = '';
  const stack: { begin: number; token: string }[] = [];
  const styles: StyleRange[] = [];
  let prev = '';
  const token = (tok: string, apply: Style[]) => {
    const top = stack[stack.length - 1];
    if (top && top.token === tok) {
      stack.pop();
      const length = out.length - top.begin;
      for (const style of apply) styles.push({ start: top.begin, length, style });
    } else stack.push({ begin: out.length, token: tok });
  };
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const next = chars[i + 1];
    if (c === '*') {
      if (next === '*') {
        i++;
        if (chars[i + 1] === '*') {
          i++;
          if (prev === '\\') {
            prev = c;
            out += '***';
            continue;
          }
          token('***', ['BOLD', 'ITALIC']);
        } else {
          if (prev === '\\') {
            prev = c;
            out += '**';
            continue;
          }
          token('**', ['BOLD']);
        }
      } else {
        if (prev === '\\') {
          prev = c;
          out += '*';
          continue;
        }
        token('*', ['ITALIC']);
      }
    } else if (c === '|' && next === '|') {
      i++;
      if (prev === '\\') {
        prev = c;
        out += '||';
        continue;
      }
      token('||', ['SPOILER']);
    } else if (c === '~' || c === '`') {
      if (prev === '\\') {
        prev = c;
        out += c;
        continue;
      }
      token(c, [c === '~' ? 'STRIKETHROUGH' : 'MONOSPACE']);
    } else if (c === '\\' && (next === '*' || next === '`' || next === '|' || next === '~')) {
      prev = c;
      continue;
    } else {
      out += c;
    }
    prev = c;
  }
  return { text: out, styles };
}

const styleKey = (s: StyleRange) => `${s.start}:${s.length}:${s.style}`;

function sameStyles(a: StyleRange[], b: StyleRange[]) {
  const x = new Set(a.map(styleKey));
  const y = new Set(b.map(styleKey));
  return x.size === y.size && [...x].every((k) => y.has(k));
}

function emitMarkup(text: string, styles: StyleRange[]): string {
  // Opening order at the same position: longer ranges first, so ranges nest.
  const opens = new Map<number, StyleRange[]>();
  const closes = new Map<number, StyleRange[]>();
  const sorted = [...styles].sort((a, b) => a.start - b.start || b.length - a.length);
  for (const s of sorted) {
    (opens.get(s.start) ?? opens.set(s.start, []).get(s.start)!).push(s);
    const end = s.start + s.length;
    (closes.get(end) ?? closes.set(end, []).get(end)!).unshift(s);
  }
  let out = '';
  for (let i = 0; i <= text.length; i++) {
    for (const s of closes.get(i) ?? []) out += MARK[s.style];
    for (const s of opens.get(i) ?? []) out += MARK[s.style];
    if (i < text.length) {
      const c = text[i];
      out += c === '*' || c === '`' || c === '|' || c === '~' ? '\\' + c : c;
    }
  }
  return out;
}

/**
 * Markup for the REST API that reproduces exactly these styles, or null when the API's parser
 * can't express them (e.g. bold and italic that partly overlap). Styles that don't fit are dropped
 * one kind at a time rather than sending something garbled.
 */
export function toApiMarkup(text: string, styles: StyleRange[]): { message: string; styles: StyleRange[] } | null {
  let attempt = [...styles];
  const dropOrder: Style[] = ['ITALIC', 'STRIKETHROUGH', 'SPOILER', 'MONOSPACE', 'BOLD'];
  for (let round = 0; round <= dropOrder.length; round++) {
    if (!attempt.length) return null;
    const message = emitMarkup(text, attempt);
    const parsed = parseApiMarkup(message);
    if (parsed.text === text && sameStyles(parsed.styles, attempt)) return { message, styles: attempt };
    const drop = dropOrder[round];
    attempt = attempt.filter((s) => s.style !== drop);
  }
  return null;
}
