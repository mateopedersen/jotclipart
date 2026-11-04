/** Negotiate only our same-origin metadata endpoints; never send this to media hosts. */
export const catalogProtocolHeaders = { 'X-UC-Catalog-Protocol': 'snapshot-search-v1' };
export function catalogMetadataHeaders(path: string, initial?: HeadersInit): Headers {
  const headers = new Headers(initial);
  if (['/search-data/manifest.json', '/studio-manifest.json', '/studio-featured.json', '/studio-catalog.json'].includes(path))
    headers.set('X-UC-Catalog-Protocol', 'snapshot-search-v1');
  return headers;
}
