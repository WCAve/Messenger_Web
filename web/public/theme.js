// Applies the theme chosen in Settings before the page paints (no flash of the wrong theme).
try {
  var t = localStorage.getItem('sw-theme');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch (e) {}
