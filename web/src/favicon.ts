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
  const text = count > 9 ? '9+' : String(count);
  const wide = text.length > 1;
  // A white ring keeps the badge readable on dark and light tab bars.
  // Big enough to read at 16px, the size most tab bars use.
  const badge = wide
    ? `<rect x="10" y="1.5" width="52.5" height="41" rx="20.5" fill="#E5352B" stroke="#fff" stroke-width="3"/>`
    : `<circle cx="41" cy="23" r="21.5" fill="#E5352B" stroke="#fff" stroke-width="3"/>`;
  const label = `<text x="${wide ? 36 : 41}" y="${wide ? 22 : 23}" dy=".36em" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="${wide ? 32 : 36}" fill="#fff">${text}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${ICON_BODY}${badge}${label}</svg>`;
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
