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
  const n = new Notification('Signal Web', { body: 'Notifications are working.', icon: '/icon.svg', tag: 'signal-web-test' });
  setTimeout(() => n.close(), 6000);
}
