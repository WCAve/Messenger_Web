/**
 * Unread badge on the tab icon: the app icon with a red count in the corner (9+ above nine),
 * the same count as in the tab title (muted chats don't count).
 */
const ICON_BODY =
  '<rect width="64" height="64" rx="16" fill="#3A5BD9"/>' +
  '<path d="M32 13c-11 0-19.5 7.8-19.5 17.6 0 5 2.2 9.4 5.8 12.6l-1.7 7.6 7.4-3.6c2.5.8 5.2 1.2 8 1.2 11 0 19.5-7.8 19.5-17.8S43 13 32 13z" fill="#fff"/>' +
  '<circle cx="24" cy="31" r="2.6" fill="#3A5BD9"/><circle cx="32" cy="31" r="2.6" fill="#3A5BD9"/><circle cx="40" cy="31" r="2.6" fill="#3A5BD9"/>';

export function faviconSvg(count: number): string {
  if (count <= 0) return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${ICON_BODY}</svg>`;
  // Like WhatsApp: the count takes the place of the three dots in the bubble, in the app's own blue.
  const text = count > 9 ? '9+' : String(count);
  const wide = text.length > 1;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" rx="16" fill="#3A5BD9"/>` +
    `<path d="M32 9c-12.4 0-22 8.7-22 19.8 0 5.6 2.5 10.6 6.5 14.2l-1.9 8.6 8.4-4.1c2.8.9 5.8 1.4 9 1.4 12.4 0 22-8.8 22-20.1S44.4 9 32 9z" fill="#fff"/>` +
    `<text x="32" y="29" dy=".36em" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="${wide ? 26 : 32}" letter-spacing="${wide ? -1 : 0}" fill="#3A5BD9">${text}</text>` +
    `</svg>`
  );
}

let shown = -1;
export function setFaviconCount(count: number) {
  const n = Math.max(0, count | 0);
  const key = n > 9 ? 10 : n;
  if (key === shown) return;
  shown = key;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/svg+xml';
  link.href = n ? `data:image/svg+xml,${encodeURIComponent(faviconSvg(n))}` : '/icon.svg';
}
