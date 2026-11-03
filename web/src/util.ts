const HUES = [221, 262, 330, 12, 32, 152, 188, 200, 290, 96];

/** A stable hue per person/chat, used for avatars and sender names in groups. */
export function hueFor(key: string) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length];
}

export function initials(name: string) {
  const clean = name.replace(/[^\p{L}\p{N}\s]/gu, '').trim();
  if (!clean) return name.startsWith('+') ? '#' : '?';
  const parts = clean.split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const shortDateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const longDateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

function startOfDay(ts: number) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function formatTime(ts: number) {
  return timeFmt.format(ts);
}

/** For the chat list: time today, "Yesterday", weekday this week, otherwise a date. */
export function formatListTime(ts: number) {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / 86400_000);
  if (days === 0) return timeFmt.format(ts);
  if (days === 1) return 'Yesterday';
  if (days < 7) return weekdayFmt.format(ts);
  return shortDateFmt.format(ts);
}

/** For day separators in a chat. */
export function formatDay(ts: number) {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / 86400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return weekdayFmt.format(ts);
  return longDateFmt.format(ts);
}

export function sameDay(a: number, b: number) {
  return startOfDay(a) === startOfDay(b);
}

export function formatSize(bytes?: number | null) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** True when the message is only emoji (rendered larger, without a bubble background). */
export function isJumbomoji(text: string | null) {
  if (!text || text.length > 12) return false;
  return /^(\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u.test(text) && !/^[\d#*\s]+$/.test(text);
}
