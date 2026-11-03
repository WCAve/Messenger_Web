/** Settings that belong to this browser only (kept in localStorage). */
import { useSyncExternalStore } from 'react';

export interface Prefs {
  theme: 'system' | 'light' | 'dark';
  enterToSend: boolean;
  notifications: boolean;
  notificationPreview: boolean;
  /** Chat list width in px; null = automatic. */
  sidebarWidth: number | null;
  /** The "turn on notifications" banner was closed. */
  notifyBannerDismissed: boolean;
}

const DEFAULTS: Prefs = { theme: 'system', enterToSend: true, notifications: true, notificationPreview: true, sidebarWidth: null, notifyBannerDismissed: false };
const KEY = 'sw-prefs';

function load(): Prefs {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    const theme = localStorage.getItem('sw-theme');
    return { ...DEFAULTS, ...stored, theme: theme === 'light' || theme === 'dark' ? theme : 'system' };
  } catch {
    return { ...DEFAULTS };
  }
}

let prefs = load();
const listeners = new Set<() => void>();

export function applyTheme(theme: Prefs['theme']) {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

export function getPrefs() {
  return prefs;
}

export function setPrefs(patch: Partial<Prefs>) {
  prefs = { ...prefs, ...patch };
  try {
    const { theme, ...rest } = prefs;
    localStorage.setItem(KEY, JSON.stringify(rest));
    // The theme lives under its own key so /theme.js can apply it before the app loads.
    if (theme === 'system') localStorage.removeItem('sw-theme');
    else localStorage.setItem('sw-theme', theme);
  } catch {
    /* storage unavailable: the choice lasts until reload */
  }
  if (patch.theme) applyTheme(patch.theme);
  listeners.forEach((l) => l());
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => prefs,
  );
}
