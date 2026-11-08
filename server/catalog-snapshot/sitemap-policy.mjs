export const SITEMAP_URL_LIMIT = 10000;
export const SITEMAP_KIND = /^(?:pages|topics|collections|art|images)(?:-[1-9]\d*)?$/;
export const separatedSitemaps = (root) => root.protocol === 'ledger-separated-v3';
export const sitemapFamily = (kind) => kind.replace(/-\d+$/, '');
export function canonicalPageFamily(loc) {
  const url = new URL(loc);
  if (url.origin !== 'https://ultraclipart.com' || url.search || url.hash)
    throw Error('Only canonical sitemap locations are admitted');
  return url.pathname.startsWith('/art/')
    ? 'art'
    : url.pathname.startsWith('/clipart/')
      ? 'topics'
      : url.pathname.startsWith('/collection/')
        ? 'collections'
        : 'pages';
}
export const sitemapDocumentKind = (family, number) =>
  ['art', 'images'].includes(family) || number > 1 ? `${family}-${number}` : family;
export function sitemapChangeFamily(root, kind, loc) {
  return separatedSitemaps(root) && kind === 'pages' ? canonicalPageFamily(loc) : kind;
}
