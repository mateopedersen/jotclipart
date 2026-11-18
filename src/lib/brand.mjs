/** Brand presentation only. Never use these values as content identity or hash input. */
export const brand = Object.freeze({
  name: 'JotClipart',
  origin: 'https://jotclipart.com',
  assetsOrigin: 'https://assets.jotclipart.com',
  primary: '#52B788',
  action: '#216E4E',
  ink: '#000000',
  soft: '#D8F3DC',
  background: '#FFFFFF',
  surface: '#FFFFFF',
});

/** Idempotent display projection; source titles, descriptions, IDs and slugs stay intact. */
export function freeCatalogTitle(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Catalog title required');
  const source = value
    .trim()
    .replace(/^(?:free\s+)+/i, '')
    .replace(/(?:\s+clipart){2,}$/i, ' Clipart');
  return 'Free ' + source;
}

export function isCatalogTitlePath(pathname) {
  return (
    pathname === '/' ||
    /^\/(?:art|clipart|collection)\/[a-z0-9-]+\/$/.test(pathname) ||
    ['/categories/', '/collections/', '/new/', '/black-and-white/', '/library-index/'].includes(
      pathname,
    )
  );
}

export function pageDisplayTitle(value, pathname) {
  return isCatalogTitlePath(pathname) ? freeCatalogTitle(value) : value;
}

/** Exact owned public origins only; private object keys and third-party URLs are never rewritten. */
export function publicBrandURL(value) {
  if (typeof value !== 'string' || !/^https?:\/\//.test(value)) return value;
  const url = new URL(value);
  if (url.username || url.password || url.port) return value;
  if (['ultraclipart.com', 'www.ultraclipart.com'].includes(url.hostname)) {
    url.protocol = 'https:';
    url.hostname = 'jotclipart.com';
  } else if (url.hostname === 'assets.ultraclipart.com') {
    url.protocol = 'https:';
    url.hostname = 'assets.jotclipart.com';
  }
  return url.href;
}
