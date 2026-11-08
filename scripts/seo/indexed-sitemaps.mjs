import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { decodeHtml } from './image-seo.mjs';

// Audit exactly the sitemap files advertised by the generated index. A later
// part can contain the vast majority of the catalog as it grows.
export function readIndexedSitemaps(directory, site) {
  const errors = [],
    pages = [],
    images = [],
    seen = new Set();
  const indexPath = join(directory, 'sitemap.xml');
  if (!existsSync(indexPath)) return { pages, images, errors: ['Missing sitemap index'] };
  const index = readFileSync(indexPath, 'utf8');
  const children = [...index.matchAll(/<sitemap>\s*<loc>([^<]+)<\/loc>\s*<\/sitemap>/g)];
  for (const match of children) {
    const address = decodeHtml(match[1]);
    let url;
    try {
      url = new URL(address);
    } catch {
      errors.push(`Invalid sitemap URL: ${address}`);
      continue;
    }
    if (
      url.origin !== new URL(site).origin ||
      url.search ||
      url.hash ||
      !/^\/sitemap-(?:(?:pages|topics|collections|art|images)(?:-[1-9]\d*)?)\.xml$/.test(
        url.pathname,
      )
    ) {
      errors.push(`Unexpected sitemap URL: ${address}`);
      continue;
    }
    if (seen.has(url.pathname)) {
      errors.push(`Duplicate sitemap URL: ${address}`);
      continue;
    }
    seen.add(url.pathname);
    const filename = join(directory, url.pathname.slice(1));
    if (!existsSync(filename)) {
      errors.push(`Missing sitemap file: ${url.pathname}`);
      continue;
    }
    const record = { path: url.pathname, xml: readFileSync(filename, 'utf8') };
    (url.pathname.startsWith('/sitemap-images') ? images : pages).push(record);
  }
  if (!pages.length) errors.push('No indexed page sitemap');
  return { pages, images, errors };
}
