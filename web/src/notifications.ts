import { hueFor, initials } from './util';

/** Browser notification state, in one place for the banner and the Settings screen. */
export type NotifyState =
  | 'unsupported' // no Notification API at all
  | 'insecure' // page isn't HTTPS: browsers refuse notifications here
  | 'default' // not asked yet
  | 'granted'
  | 'denied';

export function notifyState(): NotifyState {
  if (!window.isSecureContext) return 'insecure';
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission as NotifyState;
}

/** Must be called from a click: browsers ignore permission requests that aren't. */
export async function requestNotifications(): Promise<NotifyState> {
  if (notifyState() !== 'default') return notifyState();
  try {
    await Notification.requestPermission();
  } catch {
    /* old Safari: callback form only; state is read below either way */
  }
  return notifyState();
}

export function testNotification() {
  const n = new Notification('Messenger Web', { body: 'Notifications are working.', icon: '/icon.svg', tag: 'messenger-web-test' });
  setTimeout(() => n.close(), 6000);
}

// ---------- the picture in a notification ----------


const iconCache = new Map<string, Promise<string>>();

/** A round picture as a data URL (notification icons can't be cropped by CSS). */
function round(draw: (ctx: CanvasRenderingContext2D, size: number) => void): string {
  const size = 192;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  draw(ctx, size);
  return c.toDataURL('image/png');
}

function initialsIcon(name: string, seed: string, group: boolean): string {
  return round((ctx, size) => {
    const hue = hueFor(seed);
    ctx.fillStyle = `hsl(${hue} 70% 88%)`;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = `hsl(${hue} 55% 30%)`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${size * 0.38}px system-ui, sans-serif`;
    ctx.fillText(group && !/\p{L}/u.test(name) ? '👥' : initials(name), size / 2, size / 2 + size * 0.02);
  });
}

/**
 * Like WhatsApp: the chat's picture (the group's, or the person's), round; their initials when there's
 * no picture. Falls back to the app icon if drawing fails.
 */
export function notificationIcon(c: { avatar: string | null; title: string; number?: string | null; kind: string } | undefined): Promise<string> {
  if (!c) return Promise.resolve('/icon.svg');
  const key = c.avatar ?? `initials:${c.title}`;
  let p = iconCache.get(key);
  if (p) return p;
  const fallback = () => {
    try {
      return initialsIcon(c.title, String(c.number ?? c.title), c.kind === 'group');
    } catch {
      return '/icon.svg';
    }
  };
  p = (async () => {
    if (!c.avatar) return fallback();
    try {
      const res = await fetch(c.avatar, { credentials: 'same-origin' });
      if (!res.ok) return fallback();
      const bitmap = await createImageBitmap(await res.blob());
      return round((ctx, size) => {
        const s = Math.min(bitmap.width, bitmap.height);
        ctx.drawImage(bitmap, (bitmap.width - s) / 2, (bitmap.height - s) / 2, s, s, 0, 0, size, size);
      });
    } catch {
      return fallback();
    }
  })();
  iconCache.set(key, p);
  // A picture can change: forget it after a while.
  setTimeout(() => iconCache.delete(key), 30 * 60_000);
  return p;
}
