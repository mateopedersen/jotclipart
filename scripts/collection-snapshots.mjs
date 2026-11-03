import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readReviewedImportCatalog } from './reviewed-imports.mjs';
import { readCollectionRegistries, verifyCollectionEditorial } from './collection-editorial.mjs';
import { collectionMetaDescription } from '../src/lib/collection-meta.mjs';
import { relatedCollectionSlugs } from '../src/lib/related-collections.ts';

const SITE = 'https://ultraclipart.com';
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const shaPattern = /^[a-f0-9]{64}$/;
const slugify = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const requireSlug = (value, label) => {
  if (typeof value !== 'string' || !slugPattern.test(value))
    throw Error(`Invalid ${label}: ${value}`);
};
const clone = (value) => JSON.parse(JSON.stringify(value));

/** Local source reader only: no Astro import, preview generation, network or writes. */
export function readCollectionSnapshotSource(root) {
  const read = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  return {
    catalog: read('data/art.json'),
    resolvedCatalog: readReviewedImportCatalog(root),
    registry: readCollectionRegistries(root),
    topics: [...read('data/topics.json').topics, ...read('data/extra-topics.json')],
    primary: read('data/primary-topic-categories.json'),
    secondary: read('data/topic-clusters.json'),
    copy: read('data/collection-copy.json'),
    relations: read('data/topic-relations.json'),
  };
}

/** Compile immutable records for an authorized publisher to stage and verify.
 * This is not a deployer, visual reviewer, complete release or activation receipt.
 * Keys are relative to the caller's immutable catalog namespace.
 */
export function compileCollectionSnapshots(source, { membershipLimit = 256 } = {}) {
  if (!Number.isSafeInteger(membershipLimit) || membershipLimit < 1 || membershipLimit > 256)
    throw Error('Collection membershipLimit must be 1–256');
  const {
    catalog,
    resolvedCatalog,
    registry,
    topics,
    primary = {},
    secondary = {},
    copy = {},
    relations = {},
  } = source;
  if (!Array.isArray(catalog) || !Array.isArray(resolvedCatalog) || !Array.isArray(topics))
    throw Error('Collection snapshot source arrays are required');
  const rawById = new Map(),
    publicById = new Map(),
    definitions = new Map();
  for (const item of catalog) {
    requireSlug(item.id, 'artwork ID');
    requireSlug(item.topic, 'artwork topic');
    if (rawById.has(item.id)) throw Error(`Duplicate source artwork: ${item.id}`);
    rawById.set(item.id, item);
  }
  for (const item of resolvedCatalog) {
    const raw = rawById.get(item.id);
    if (publicById.has(item.id)) throw Error(`Duplicate resolved artwork: ${item.id}`);
    if (
      !raw ||
      raw.topic !== item.topic ||
      raw.published !== item.published ||
      raw.indexable !== item.indexable ||
      raw.files?.webp?.sha256 !== item.files?.webp?.sha256
    )
      throw Error(`Resolved artwork identity changed: ${item.id}`);
    if (!shaPattern.test(item.files?.webp?.sha256 ?? ''))
      throw Error(`Missing image checksum: ${item.id}`);
    publicById.set(item.id, item);
  }
  if (publicById.size !== rawById.size) throw Error('Resolved catalog is incomplete');
  for (const topic of topics) {
    requireSlug(topic.slug, 'topic slug');
    if (definitions.has(topic.slug)) throw Error(`Duplicate topic definition: ${topic.slug}`);
    if (
      typeof topic.keyword !== 'string' ||
      !topic.keyword.trim() ||
      typeof topic.cluster !== 'string' ||
      !topic.cluster.trim()
    )
      throw Error(`Missing topic identity: ${topic.slug}`);
    definitions.set(topic.slug, topic);
  }
  // Enforce the same source-bound writing gates as normal page builds.
  verifyCollectionEditorial(catalog, registry, resolvedCatalog);
  const groups = new Map();
  for (const item of resolvedCatalog.filter((item) => item.published && item.indexable)) {
    if (!definitions.has(item.topic)) throw Error(`Unregistered public topic: ${item.topic}`);
    const group = groups.get(item.topic) ?? [];
    group.push(item);
    groups.set(item.topic, group);
  }
  const eligible = new Set(groups.keys());
  const featured = (slug) => {
    const ids = copy[slug]?.featured ?? [];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))
      throw Error(`Invalid featured order: ${slug}`);
    return ids;
  };
  const cover = (slug) =>
    featured(slug).find((id) => groups.get(slug).some((item) => item.id === id)) ??
    groups.get(slug)[0].id;
  const objects = [];
  const add = (prefix, record) => {
    const bytes = Buffer.from(JSON.stringify(canonical(record)));
    if (bytes.length > 256 * 1024) throw Error(`Oversized collection object: ${prefix}`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const descriptor = { key: `${prefix}/${sha256}.json`, bytes: bytes.length, sha256 };
    objects.push({ ...descriptor, body: bytes });
    return descriptor;
  };
  const entries = [];
  // Index order is deterministic; membership order retains the existing gallery.
  for (const slug of [...eligible].sort()) {
    const definition = definitions.get(slug),
      review = registry.topics[slug];
    const rank = new Map(featured(slug).map((id, i) => [id, i]));
    const items = [...groups.get(slug)].sort(
      (a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999),
    );
    const membership = [];
    for (let offset = 0; offset < items.length; offset += membershipLimit) {
      const ids = items.slice(offset, offset + membershipLimit).map((item) => item.id);
      membership.push({
        offset,
        count: ids.length,
        ...add(`collections/members/${slug}`, {
          schema: 1,
          type: 'collection-members',
          slug,
          offset,
          artworkIds: ids,
        }),
      });
    }
    const cluster = primary[slug] ?? definition.browseCluster ?? definition.cluster;
    const clusterNames = [...new Set([cluster, definition.cluster, ...(secondary[slug] ?? [])])];
    if (clusterNames.some((name) => typeof name !== 'string' || !slugify(name)))
      throw Error(`Invalid topic category: ${slug}`);
    const path = `/clipart/${slug}/`;
    const record = {
      schema: 1,
      type: 'collection-topic',
      slug,
      path,
      canonical: SITE + path,
      title: definition.keyword.replace('clipart', 'Clipart'),
      keyword: definition.keyword,
      sourceCluster: definition.cluster,
      primaryCluster: cluster,
      clusters: clusterNames.map((name) => ({ name, path: `/collection/${slugify(name)}/` })),
      summary: review.intro,
      metaDescription: collectionMetaDescription(review.intro).text,
      paragraphs: clone(review.paragraphs),
      editorial: clone(review),
      artworkCount: items.length,
      coverArtworkId: items[0].id,
      membership,
      related: relatedCollectionSlugs(slug, relations, eligible).map((target) => ({
        slug: target,
        coverArtworkId: cover(target),
        artworkCount: groups.get(target).length,
      })),
    };
    entries.push({
      slug,
      path,
      artworkCount: items.length,
      ...add(`collections/topics/${slug}`, record),
    });
  }
  const index = {
    schema: 1,
    type: 'collection-index',
    topicCount: entries.length,
    artworkCount: entries.reduce((sum, entry) => sum + entry.artworkCount, 0),
    topics: entries,
  };
  const indexBytes = Buffer.from(JSON.stringify(canonical(index)));
  if (indexBytes.length > 1024 * 1024)
    throw Error('Collection root index requires partitioning before publication');
  return {
    index,
    indexBytes,
    indexSha256: createHash('sha256').update(indexBytes).digest('hex'),
    objects,
  };
}
