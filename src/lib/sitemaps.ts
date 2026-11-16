import { artworkURL } from './artwork-route.mjs';
import {
  SITEMAP_URL_LIMIT,
  sitemapDocumentKind,
} from '../../server/catalog-snapshot/sitemap-policy.mjs';
import { guides } from './guides.ts';
import { primaryClusterForTopic } from './topic-clusters.ts';
import { activeCuratedCollections } from './curated-collection-policy.mjs';
const SITE = 'https://jotclipart.com/';
const XML = '<?xml version="1.0" encoding="UTF-8"?>';
const NS = 'http://www.sitemaps.org/schemas/sitemap/0.9';

type Artwork = {
  id: string;
  publicSlug?: string;
  topic: string;
  webp: string;
  published: boolean;
  indexable: boolean;
  monochrome?: boolean;
};
type Topic = { slug: string; cluster?: string; sourceCluster?: string; browseCluster?: string };

/** Escape XML data, including query strings in real CDN image URLs. */
export function xmlEscape(value: string): string {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  };
  return value.replace(/[&<>"']/g, (character) => entities[character]);
}

export const approvedArt = (art: Artwork[]) =>
  art.filter((item) => item.published && item.indexable);

/** Use the same public subset for HTML directories and XML discovery. */
export function indexableTopics<T extends Topic>(art: Artwork[], topics: T[]): T[] {
  const counts = new Map<string, number>();
  for (const item of approvedArt(art)) counts.set(item.topic, (counts.get(item.topic) ?? 0) + 1);
  return topics.filter((topic) => (counts.get(topic.slug) ?? 0) > 0);
}

/** Keep approved works discoverable even when a caller lacks their topic row.
 * A growing registered subject is public from its first approved artwork. */
export function directoryArtwork<T extends Artwork>(art: T[], topics: Topic[]): T[] {
  const indexed = new Set(indexableTopics(art, topics).map((topic) => topic.slug));
  return art.filter((item) => item.published && item.indexable && !indexed.has(item.topic));
}
const absolute = (path: string) => new URL(path, SITE).href;
const artUrl = (item: Artwork) => artworkURL(item);

function pageEntries(art: Artwork[], topics: Topic[]): string[] {
  const routes = [
    '',
    'categories/',
    'collections/',
    'library-index/',
    'create/',
    'ai-clipart-generator/',
    'guides/',
    'print-size/',
    ...guides.map((guide) => `guides/${guide.slug}/`),
    'about/',
    'license/',
    'contact/',
    'privacy/',
    'cookies/',
    'terms/',
    'faq/',
    'for-teachers/',
    'accessibility/',
    'copyright/',
    'editorial-process/',
  ];
  const urls = routes.map(absolute);
  const approved = approvedArt(art);
  if (approved.length) urls.push(absolute('new/'));
  if (approved.some((item) => item.monochrome === true)) urls.push(absolute('black-and-white/'));
  return [...new Set(urls)].map(pageEntry);
}
const pageEntry = (url: string) => `<url><loc>${xmlEscape(url)}</loc></url>`;
function collectionEntries(art: Artwork[], topics: Topic[]): string[] {
  const collectionNames = new Set(
    indexableTopics(art, topics)
      .filter((topic) => typeof topic.cluster === 'string')
      .map(primaryClusterForTopic),
  );
  const urls = [...collectionNames]
    .map((cluster) =>
      cluster
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, ''),
    )
    .filter(Boolean)
    .map((slug) => absolute(`collection/${slug}/`));
  const counts: Record<string, number> = {};
  for (const item of approvedArt(art)) counts[item.topic] = (counts[item.topic] ?? 0) + 1;
  urls.push(...activeCuratedCollections(counts).map((g) => absolute(`collection/${g.slug}/`)));
  return [...new Set(urls)].sort().map(pageEntry);
}
function topicEntries(art: Artwork[], topics: Topic[]): string[] {
  return [...new Set(indexableTopics(art, topics).map((t) => absolute(`clipart/${t.slug}/`)))]
    .sort()
    .map(pageEntry);
}

function imageEntries(art: Artwork[]): string[] {
  const items = approvedArt(art);
  if (!items.length)
    throw new Error('Do not publish an empty image sitemap. No artwork is approved for indexing.');
  const entries = items.map(
    (item) =>
      `<url><loc>${xmlEscape(artUrl(item))}</loc><image:image><image:loc>${xmlEscape(absolute(item.webp))}</image:loc></image:image></url>`,
  );
  return entries;
}

const prefix = (images: boolean) =>
  `${XML}<urlset xmlns="${NS}"${images ? ' xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"' : ''}>`;
const suffix = '</urlset>';
// Google permits 50 MiB, but Pages rejects individual assets above 25 MiB.
// Keep a margin so every generated XML file also fits the hosting limit.
export const SITEMAP_MAX_BYTES = 24 * 1024 ** 2;
export function partitionSitemapEntries(
  entries: string[],
  images = false,
  maxUrls = SITEMAP_URL_LIMIT,
  maxBytes = SITEMAP_MAX_BYTES,
): string[] {
  if (!Number.isSafeInteger(maxUrls) || maxUrls < 1 || maxUrls > SITEMAP_URL_LIMIT)
    throw Error('Sitemaps contain at most 10,000 canonical URLs');
  const start = prefix(images),
    overhead = Buffer.byteLength(start + suffix),
    parts: string[] = [];
  let chunk: string[] = [],
    bytes = overhead;
  for (const entry of entries) {
    const size = Buffer.byteLength(entry);
    if (size + overhead > maxBytes) throw Error('One sitemap entry exceeds the XML byte limit');
    if (chunk.length && (chunk.length >= maxUrls || bytes + size > maxBytes)) {
      parts.push(start + chunk.join('') + suffix);
      chunk = [];
      bytes = overhead;
    }
    chunk.push(entry);
    bytes += size;
  }
  if (chunk.length) parts.push(start + chunk.join('') + suffix);
  return parts;
}
export function pageSitemap(art: Artwork[], topics: Topic[]): string {
  return prefix(false) + pageEntries(art, topics).join('') + suffix;
}
export function imageSitemap(art: Artwork[]): string {
  return prefix(true) + imageEntries(art).join('') + suffix;
}
export function sitemapDocuments(art: Artwork[], topics: Topic[] = []) {
  const families: [string, string[]][] = [
    ['pages', pageEntries(art, topics)],
    ['topics', topicEntries(art, topics)],
    ['collections', collectionEntries(art, topics)],
    ['art', approvedArt(art).map((item) => pageEntry(artUrl(item)))],
    ['images', approvedArt(art).length ? imageEntries(art) : []],
  ];
  const canonical = new Set<string>();
  for (const [family, entries] of families)
    if (family !== 'images')
      for (const entry of entries) {
        const loc = /<loc>([^<]+)<\/loc>/.exec(entry)![1];
        if (canonical.has(loc)) throw Error('Duplicate canonical page in sitemap families: ' + loc);
        canonical.add(loc);
      }
  return families.flatMap(([family, entries]) =>
    partitionSitemapEntries(entries, family === 'images').map((xml, i) => ({
      kind: sitemapDocumentKind(family, i + 1),
      xml,
    })),
  );
}
export function sitemapIndex(art: Artwork[], topics: Topic[] = []): string {
  const children = sitemapDocuments(art, topics).map((d) => `sitemap-${d.kind}.xml`);
  return `${XML}<sitemapindex xmlns="${NS}">${children.map((path) => `<sitemap><loc>${xmlEscape(absolute(path))}</loc></sitemap>`).join('')}</sitemapindex>`;
}
