import { fileURLToPath } from 'node:url';
import { readIndexedSitemaps } from '../../scripts/seo/indexed-sitemaps.mjs';

let cached;
export function sitemapXml(kind) {
  if (!['pages', 'images'].includes(kind)) throw Error('Unknown sitemap kind');
  cached ??= readIndexedSitemaps(
    fileURLToPath(new URL('../../dist/', import.meta.url)),
    'https://ultraclipart.com/',
  );
  if (cached.errors.length) throw Error(`Invalid sitemap index: ${cached.errors.join('; ')}`);
  if (!cached[kind].length) throw Error(`Missing ${kind} sitemaps`);
  return cached[kind].map((item) => item.xml).join('');
}
