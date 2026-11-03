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

/** Center-crop an image file to a square JPEG (base64, no data: prefix), like Signal does for avatars. */
export async function squareAvatar(file: File, size = 640): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Couldn't read that image"));
      i.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const out = Math.min(size, side);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = out;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff'; // transparent PNGs get a white background, as JPEG has no transparency
    ctx.fillRect(0, 0, out, out);
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, out, out);
    return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Disappearing-message timers, as Signal offers them. */
export const TIMER_OPTIONS = [30, 300, 3600, 8 * 3600, 86400, 7 * 86400, 28 * 86400];

export function durationLabel(s: number, short = false): string {
  const units: [number, string, string][] = [
    [7 * 86400, 'w', 'week'],
    [86400, 'd', 'day'],
    [3600, 'h', 'hour'],
    [60, 'm', 'minute'],
    [1, 's', 'second'],
  ];
  for (const [size, abbr, word] of units) {
    if (s >= size && s % size === 0) {
      const n = s / size;
      return short ? `${n}${abbr}` : `${n} ${word}${n === 1 ? '' : 's'}`;
    }
  }
  return short ? `${s}s` : `${s} seconds`;
}

/** "in 3 hours", for a moment in the future. */
export function untilLabel(ts: number): string {
  const s = Math.max(0, Math.round((ts - Date.now()) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
}
