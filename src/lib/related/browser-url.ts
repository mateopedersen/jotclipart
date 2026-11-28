import { brand, publicBrandURL } from '../brand.mjs';

/** Only navigation and original media owned by this catalog may reach card URL sinks. */
export function relatedCardURL(value: unknown, kind: 'detail' | 'media'): string {
  if (typeof value !== 'string' || !value || /[\u0000-\u0020\\]/.test(value))
    throw new Error('Invalid related artwork URL');
  const url = new URL(publicBrandURL(value), brand.origin);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid related artwork URL');
  if (kind === 'detail') {
    if (url.origin !== brand.origin || !/^\/art\/[a-z0-9-]+\/$/.test(url.pathname))
      throw new Error('Unowned related artwork page');
  } else if (
    (url.origin !== brand.origin && url.origin !== brand.assetsOrigin) ||
    !/\.(?:webp|pdf)$/.test(url.pathname)
  )
    throw new Error('Unowned related artwork media');
  return url.href;
}
