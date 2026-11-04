// Request reader over one captured root. No source approval or pointer reads here.
import { lookupTopic, slugOK, fail, CollectionFault } from './store.mjs';
import {
  VIEW_PROTOCOL,
  validateTopicIdentity,
  validateTopicRecord,
  membership,
} from './writer.mjs';
function validArtwork(a, id) {
  if (
    !a ||
    a.id !== id ||
    !slugOK(a.id) ||
    !slugOK(a.topic) ||
    a.published !== true ||
    a.indexable !== true ||
    ['title', 'alt', 'description'].some((k) => typeof a[k] !== 'string') ||
    !Number.isSafeInteger(a.width) ||
    !Number.isSafeInteger(a.height) ||
    a.width < 1 ||
    a.height < 1 ||
    a.thumb !== a.webp
  )
    fail('Invalid canonical page artwork');
  for (const kind of ['webp', 'pdf']) {
    let url;
    try {
      url = new URL(a[kind]);
    } catch {
      fail('Missing original media');
    }
    if (
      url.origin !== 'https://assets.ultraclipart.com' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      !url.pathname.endsWith('.' + kind) ||
      !Number.isSafeInteger(a.files?.[kind]?.bytes) ||
      a.files[kind].bytes < 1 ||
      !/^[a-f0-9]{64}$/.test(a.files[kind].sha256)
    )
      fail('Invalid original media facts');
  }
  return a;
}
const topic = (r) => ({
  slug: r.slug,
  keyword: r.keyword,
  cluster: r.primaryCluster,
  sourceCluster: r.sourceCluster,
});
export async function readCollectionReferences(
  context,
  slug,
  { resolveArtwork, maxGallery = 1000 } = {},
) {
  if (!slugOK(slug)) {
    const e = new CollectionFault('Unknown topic');
    e.status = 404;
    throw e;
  }
  if (!Number.isSafeInteger(maxGallery) || maxGallery < 1 || maxGallery > 10000)
    fail('Invalid gallery budget');
  if (typeof resolveArtwork !== 'function' || !/^[a-f0-9]{64}$/.test(context?.rootSHA256 ?? ''))
    fail('Captured artwork resolver required');
  const store = { read: (facet, d) => context.read(facet, d, { maxBytes: 262144 }) },
    [collections, countsRoot] = await Promise.all([
      context.getFacet('collections'),
      context.getFacet('counts'),
    ]);
  if (
    collections.type !== 'collection-directory' ||
    collections.viewProtocol !== VIEW_PROTOCOL ||
    countsRoot.type !== 'catalog-count-directory' ||
    collections.topicCount !== countsRoot.topicCount ||
    collections.artworkCount !== countsRoot.artworkCount
  )
    fail('Unsupported collection reference protocol');
  const global = await store.read('counts', countsRoot.global);
  if (
    global.totals?.artworks !== collections.artworkCount ||
    global.totals?.subjects !== collections.topicCount ||
    !global.collections ||
    Object.hasOwn(global, 'topics') ||
    !/^[a-f0-9]{16}$/.test(global.version ?? '')
  )
    fail('Inconsistent global counts');
  async function find(target, required = false) {
    const entry = await lookupTopic(store, collections.directory, 'collection', target);
    if (!entry) {
      if (required) {
        const e = new CollectionFault('Unknown topic');
        e.status = 404;
        throw e;
      }
      return null;
    }
    const r = await store.read('collections', entry),
      count = await lookupTopic(store, countsRoot.topics, 'count', target);
    if (
      !r ||
      !['collection-topic', 'collection-topic-references'].includes(r.type) ||
      r.slug !== target ||
      r.path !== `/clipart/${target}/` ||
      r.canonical !== `https://ultraclipart.com/clipart/${target}/` ||
      !count ||
      !Number.isSafeInteger(count.count) ||
      count.count < 1 ||
      count.count !== r.artworkCount ||
      count.count !== entry.artworkCount
    )
      fail('Topic/reference count differs');
    validateTopicIdentity(r, target);
    return { entry, record: r, count: count.count };
  }
  const current = await find(slug, true),
    record = current.record;
  if (record.artworkCount > maxGallery) fail('Collection gallery budget exceeded');
  const ids = await membership(store, record);
  validateTopicRecord(record, ids);
  let offset = 0;
  const pageIds = [];
  for (const d of record.pageBlocks) {
    const page = await store.read('collections', d),
      rows = page.artworkIds ?? page.artworks?.map((a) => a.id);
    if (
      !['collection-page-artworks', 'collection-page-ids'].includes(page.type) ||
      page.slug !== slug ||
      page.offset !== offset ||
      d.offset !== offset ||
      !Array.isArray(rows) ||
      rows.length !== d.count ||
      d.count < 1 ||
      d.count > 32
    )
      fail('Invalid page ID block');
    pageIds.push(...rows);
    offset += d.count;
  }
  if (ids.length !== pageIds.length || ids.some((id, i) => id !== pageIds[i]))
    fail('Page IDs differ from membership');
  // Legacy duplicated covers/counts/card DTOs are intentionally ignored in v2.
  const related = [];
  for (const relation of record.related) {
    const target = await find(relation.slug);
    if (target) related.push(target.record);
  }
  const shared = await store.read('collections', collections.sharedContext);
  if (
    !Array.isArray(shared.ids) ||
    shared.ids.length > 64 ||
    shared.ids.some((id) => !slugOK(id)) ||
    new Set(shared.ids).size !== shared.ids.length ||
    !Array.isArray(shared.surprise) ||
    shared.surprise.length > 64 ||
    new Set(shared.surprise.map((x) => x.id)).size !== shared.surprise.length ||
    shared.surprise.some((x) => !slugOK(x.id))
  )
    fail('Invalid shared IDs');
  const resolved = new Map();
  async function art(id) {
    if (!resolved.has(id))
      resolved.set(
        id,
        (async () => {
          const result = await resolveArtwork(id, context);
          if (result?.rootSHA256 !== context.rootSHA256) fail('Canonical artwork root differs');
          return validArtwork(result.artwork, id);
        })(),
      );
    return resolved.get(id);
  }
  const required = [
    ...new Set([
      ...ids,
      ...shared.ids,
      ...shared.surprise.map((x) => x.id),
      ...related.map((r) => r.coverArtworkId),
    ]),
  ];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, required.length) }, async () => {
      while (next < required.length) await art(required[next++]);
    }),
  );
  const artwork = await Promise.all(required.map(art)),
    byId = new Map(artwork.map((a) => [a.id, a]));
  if (
    ids.some((id) => byId.get(id).topic !== slug) ||
    related.some((r) => byId.get(r.coverArtworkId)?.topic !== r.slug)
  )
    fail('Unrelated canonical artwork');
  const scopedCounts = {
    ...global,
    topics: Object.fromEntries([
      [slug, current.count],
      ...related.map((r) => [r.slug, r.artworkCount]),
    ]),
  };
  return {
    revision: context.snapshot.revision,
    rootSHA256: context.rootSHA256,
    objectsRead: context.objectsRead?.(),
    topicCountsRead: Object.keys(scopedCounts.topics).length,
    record,
    publicationVerified: false,
    state: {
      topic: topic(record),
      art: artwork,
      topics: [topic(record), ...related.map(topic)],
      counts: scopedCounts,
      surprise: shared.surprise.map((p) => ({
        id: p.id,
        topic: byId.get(p.id).topic,
        ...(Object.hasOwn(p, 'fresh') ? { fresh: p.fresh } : {}),
      })),
      summaries: new Map([[slug, record.summary]]),
      paragraphs: new Map([[slug, record.paragraphs]]),
      copy: Object.fromEntries([
        [slug, { featured: ids }],
        ...related.map((r) => [r.slug, { featured: [r.coverArtworkId] }]),
      ]),
      relations: { [slug]: related.map((r) => r.slug) },
      clusterNames: { [slug]: record.clusters.map((c) => c.name) },
    },
  };
}

export async function referenceCountValues(context, slugs = [], { strict = false } = {}) {
  if (!Array.isArray(slugs) || slugs.length > 64 || slugs.some((s) => !slugOK(s)))
    fail('Invalid visible count request');
  const root = await context.getFacet('counts'),
    global = await context.read('counts', root.global, { maxBytes: 65536 });
  if (
    root.type !== 'catalog-count-directory' ||
    global.totals?.artworks !== root.artworkCount ||
    global.totals?.subjects !== root.topicCount ||
    Object.hasOwn(global, 'topics')
  )
    fail('Inconsistent count root');
  const topics = {};
  const store = { read: (facet, d) => context.read(facet, d, { maxBytes: 65536 }) };
  for (const slug of new Set(slugs)) {
    const entry = await lookupTopic(store, root.topics, 'count', slug);
    if (entry && (!Number.isSafeInteger(entry.count) || entry.count < 1))
      fail('Invalid topic count');
    if (strict && !entry) fail('Expected topic count missing');
    topics[slug] = entry?.count ?? 0;
  }
  return { ...global, topics };
}
