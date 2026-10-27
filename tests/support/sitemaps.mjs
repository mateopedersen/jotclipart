import { testBuildDirectory } from './build-directory.mjs';
import { readIndexedSitemaps } from '../../scripts/seo/indexed-sitemaps.mjs';

let cached;
export function sitemapXml(kind) {
  if (!['pages', 'images'].includes(kind)) throw Error('Unknown sitemap kind');
  cached ??= readIndexedSitemaps(testBuildDirectory, 'https://ultraclipart.com/');
  if (cached.errors.length) throw Error(`Invalid sitemap index: ${cached.errors.join('; ')}`);
  if (!cached[kind].length) throw Error(`Missing ${kind} sitemaps`);
  return cached[kind].map((item) => item.xml).join('');
}
