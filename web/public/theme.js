// Applies the theme chosen in Settings before the page paints (no flash of the wrong theme).
try {
  var t = localStorage.getItem('sw-theme');
  if (t === 'light' || t === 'dark' || t === 'dark-green') document.documentElement.setAttribute('data-theme', t);
} catch (e) {}

// Emoji style (Settings → Appearance), also before the first paint.
try {
  var p = JSON.parse(localStorage.getItem('sw-prefs') || '{}');
  document.documentElement.setAttribute('data-emoji', p.emoji || 'noto');
} catch (e) {
  document.documentElement.setAttribute('data-emoji', 'noto');
}
