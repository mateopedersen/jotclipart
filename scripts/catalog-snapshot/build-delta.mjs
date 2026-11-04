// Source-approved metadata composition. No template compilation, native exports, remote writes or activation.
// Optional bounded discovery HTML preparation reads authenticated metadata only.
import { createDeltaStore } from './delta-store.mjs';
import { openSnapshot } from '../../server/catalog-snapshot/snapshot-context.mjs';
import { readArtwork } from '../../server/catalog-snapshot/artwork-facet-reader.mjs';
import { applyArtworkBatch } from '../../server/catalog-snapshot/artwork-delta.mjs';
import { applyRelatedBatch } from '../../server/catalog-snapshot/related-delta.mjs';
import { openSevenFacetCollectionContext } from '../../server/catalog-snapshot/collection-context.mjs';
import { facetStore } from '../../server/catalog-collections/store.mjs';
import { applyCollectionBatch } from '../../server/catalog-collections/writer.mjs';
import { makeStore, digest, canonical, mapGet } from '../../server/catalog-search/store.mjs';
import { applySearchBatch, lookupIdentity } from '../../server/catalog-search/index.mjs';
import { applyRecentBatch, recentHomeIDs } from '../../server/catalog-snapshot/recent-ledger.mjs';
import { applyCuteBatch, cuteProjection } from '../../server/catalog-snapshot/cute-ledger.mjs';
import { applySitemapBatch } from '../../server/catalog-snapshot/sitemap-ledger.mjs';
import { searchRecord } from './search-record.mjs';
import { refreshCollectionOpenings } from './refresh-openings.mjs';
import { assertCompleteTopicSearchDelta } from './topic-search-preflight.mjs';
const hashRecord = (record) => (record ? digest(JSON.stringify(canonical(record))) : null),
  hex = /^[a-f0-9]{64}$/;
const xml = (text) =>
    text.replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c],
    ),
  location = (kind, id) => `https://ultraclipart.com/${kind}/${id}/`,
  pageEntry = (loc) => `<url><loc>${xml(loc)}</loc></url>`,
  imageEntry = (a) =>
    `<url><loc>${xml(location('art', a.id))}</loc><image:image><image:loc>${xml(a.webp)}</image:loc></image:image></url>`;
export async function buildCatalogDelta({
  parentContext,
  parentBucket,
  revision,
  sourceReceiptSHA256,
  changes,
  topicChanges,
  validateSourceChange,
  validateSourceTopic,
  refreshViews,
  preparePresentation,
}) {
  if (
    !/^[a-f0-9]{40}$/.test(revision ?? '') ||
    revision === parentContext?.snapshot?.revision ||
    !hex.test(sourceReceiptSHA256 ?? '') ||
    !Array.isArray(changes) ||
    changes.length > 256 ||
    !Array.isArray(topicChanges) ||
    !topicChanges.length ||
    topicChanges.length > 64 ||
    typeof validateSourceChange !== 'function' ||
    typeof validateSourceTopic !== 'function' ||
    typeof refreshViews !== 'function'
  )
    throw Error('Bounded reviewed source delta, topics and all view refreshes required');
  const overlay = createDeltaStore(parentBucket, parentContext, preparePresentation ? {maxBytes:256*1024*1024} : {}),
    bucket = overlay.bucket,
    base = await openSnapshot(bucket, {
      provided: parentContext.snapshot,
      maxReadObjects: 20000,
      maxReadBytes: 128 * 1024 * 1024,
    }),
    collectionBefore = await openSevenFacetCollectionContext(bucket, { snapshot: base.snapshot }),
    topicMap = new Map(topicChanges.map((c) => [c.slug, c]));
  if (
    topicMap.size !== topicChanges.length ||
    new Set(changes.map((c) => c.id)).size !== changes.length
  )
    throw Error('Duplicate source delta');
  const oldTopics = new Map();
  async function beforeTopic(slug) {
    if (!oldTopics.has(slug)) {
      const d = await collectionBefore.lookupCollection(slug);
      oldTopics.set(slug, d ? await collectionBefore.read(d, 256 * 1024) : null);
    }
    return oldTopics.get(slug);
  }
  const afterTopic = async (slug) =>
      topicMap.has(slug) ? topicMap.get(slug).record : beforeTopic(slug),
    prepared = [];
  // A keyword/category edit changes every member's search projection even when
  // its artwork caption and pixels stay unchanged. Require those scoped rows;
  // silently retaining the old search ledger would make aliases/categories stale.
  const suppliedIds = new Set(changes.map((c) => c.id));
  for (const change of topicChanges) {
    const old = await beforeTopic(change.slug);
    assertCompleteTopicSearchDelta(old, change, suppliedIds);
  }
  // Validate the WHOLE source batch before writing even local metadata.
  for (const c of changes) {
    const old = await readArtwork(base, c.id),
      oldSHA = await hashRecord(old),
      newSHA = await hashRecord(c.record);
    if (
      c.expectedPublicSHA256 !== oldSHA ||
      (old?.topic && !topicMap.has(old.topic)) ||
      (c.record?.topic && !topicMap.has(c.record.topic))
    )
      throw Error('Stale source or omitted changed topic');
    const proof = await validateSourceChange({ change: c, oldRecord: old });
    if (
      proof?.oldPublicSHA256 !== oldSHA ||
      proof.newPublicSHA256 !== newSHA ||
      !hex.test(proof.reviewReceiptSHA256 ?? '') ||
      !hex.test(proof.mediaReceiptSHA256 ?? '') ||
      (c.record && proof.imageSHA256 !== c.record.files?.webp?.sha256)
    )
      throw Error('Unbound image/editorial/media review');
    prepared.push({ ...c, oldRecord: old, oldSHA, newSHA, proof });
  }
  const art = await applyArtworkBatch(base, changes, { revision });
  for (const [k, b] of art.created) await bucket.put(k, b);
  const indexes = { ...base.snapshot.indexes, artworks: art.root },
    candidate = {
      schema: 1,
      fixture: true,
      status: 'PRIVATE_UNPUBLISHABLE',
      revision,
      parentRevision: base.snapshot.revision,
      indexes,
    },
    after = () =>
      openSnapshot(bucket, {
        provided: candidate,
        allowFixture: true,
        maxReadObjects: 20000,
        maxReadBytes: 128 * 1024 * 1024,
      });
  let current = await after();
  const ccStore = facetStore(bucket, {
      writable: true,
      maxReads: 20000,
      maxBytes: 128 * 1024 * 1024,
    }),
    cc = await applyCollectionBatch(
      ccStore,
      { collections: indexes.collections, counts: indexes.counts },
      topicChanges,
      {
        expectedCollectionsSha256: indexes.collections.sha256,
        expectedCountsSha256: indexes.counts.sha256,
        validateSourceTopic: (input) =>
          validateSourceTopic({ ...input, resolveAfterArtwork: (id) => readArtwork(current, id) }),
        resolveBeforeArtwork: (id) => readArtwork(base, id),
        resolveAfterArtwork: (id) => readArtwork(current, id),
      },
    );
  indexes.collections = cc.collections;
  indexes.counts = cc.counts;
  if (changes.length) {
    const related = await applyRelatedBatch(base, changes, { beforeTopic, afterTopic });
    for (const [k, b] of related.created) await bucket.put(k, b);
    indexes.related = related.root;
  }
  const recentRoot = await base.getFacet('recent'),
    recentStore = {
      get: (d) => current.read('recent', d, { maxBytes: 65536 }),
      put: async (value) => {
        const b = new TextEncoder().encode(JSON.stringify(canonical({ schema: 1, ...value }))),
          sha256 = await digest(b),
          d = { key: `catalog/objects/recent/${sha256}.json`, sha256, bytes: b.length };
        await bucket.put(d.key, b);
        return d;
      },
    },
    recent = await recentStore.get(recentRoot.ledger);
  let nextOrdinal = recent.nextOrdinal;
  const ordinals = new Map();
  for (const c of prepared) {
    const prior = await mapGet(recentStore, recent.records, 'recent-records', c.id);
    if ((prior?.sourceSHA256 ?? null) !== c.oldSHA) throw Error('Recent/source parent mismatch');
    ordinals.set(c.id, prior?.n ?? nextOrdinal++);
  }
  const recentLedger = changes.length
      ? await applyRecentBatch(
          recentStore,
          recentRoot.ledger,
          prepared.map((c) => ({ id: c.id, expectedSourceSHA256: c.oldSHA, record: c.record })),
        )
      : recentRoot.ledger,
    home = await recentStore.get(recentRoot.home);
  indexes.recent = await recentStore.put({
    ...recentRoot,
    ledger: recentLedger,
    home: await recentStore.put({
      ...home,
      recentIds: await recentHomeIDs(recentStore, recentLedger),
    }),
  });
  const searchStore = makeStore(bucket, {
      writable: true,
      maxReads: 20000,
      maxBytes: 128 * 1024 * 1024,
    }),
    searchBase = await searchStore.get(indexes.search);
  let searchDataDescriptor = indexes.search;
  if (changes.length) {
    const searchChanges = [];
    for (const c of prepared) {
      const oldSource = c.oldRecord
          ? searchRecord(c.oldRecord, await beforeTopic(c.oldRecord.topic))
          : null,
        identity = await lookupIdentity(searchStore, searchBase, c.id);
      if (
        oldSource &&
        (!identity?.active ||
          identity.sourceSha256 !== (await digest(JSON.stringify(canonical(oldSource)))))
      )
        throw Error('Search/source parent mismatch');
      searchChanges.push({
        id: c.id,
        expectedSourceSha256: identity?.sourceSha256 ?? null,
        record: c.record ? searchRecord(c.record, await afterTopic(c.record.topic)) : null,
      });
    }
    const result = await applySearchBatch(searchStore, indexes.search, searchChanges, {
      revision,
      expectedParentSha256: indexes.search.sha256,
      publicSourceSha256: sourceReceiptSHA256,
      topicChanges: topicChanges.map((c) => ({ slug: c.slug, keyword: c.record?.keyword ?? null })),
    });
    const { ui: unusedUI, type: unusedType, status: unusedStatus, ...data } = result.manifest;
    searchDataDescriptor = await searchStore.put({
      ...data,
      type: 'catalog-search-v1',
      status: 'SOURCE_VERIFIED',
      sourceReceiptSHA256,
    });
  } else {
    const { ui: unusedUI, ...bare } = searchBase;
    searchDataDescriptor = await searchStore.put(bare);
  }
  const sitemapRoot = await base.getFacet('sitemaps'),
    sitemapStore = {
      get: (d) => current.read('sitemaps', d, { maxBytes: 1048576 }),
      put: async (value) => {
        const b = new TextEncoder().encode(JSON.stringify(canonical({ schema: 1, ...value }))),
          sha256 = await digest(b),
          d = { key: `catalog/objects/sitemaps/${sha256}.json`, sha256, bytes: b.length };
        await bucket.put(d.key, b);
        return d;
      },
    },
    sitemapChanges = [];
  async function sitemapChange(kind, loc, oldEntry, entry) {
    const prior = await mapGet(sitemapStore, sitemapRoot.slots, 'sitemap-slots', kind + '|' + loc);
    if ((prior?.entrySHA256 ?? null) !== (oldEntry ? await digest(oldEntry) : null))
      throw Error('Sitemap/source parent mismatch');
    if (oldEntry !== entry)
      sitemapChanges.push({ kind, loc, expectedEntrySHA256: prior?.entrySHA256 ?? null, entry });
  }
  for (const c of prepared) {
    const loc = location('art', c.id);
    await sitemapChange(
      'pages',
      loc,
      c.oldRecord ? pageEntry(loc) : null,
      c.record ? pageEntry(loc) : null,
    );
    await sitemapChange(
      'images',
      loc,
      c.oldRecord ? imageEntry(c.oldRecord) : null,
      c.record ? imageEntry(c.record) : null,
    );
  }
  for (const t of topicChanges) {
    const old = await beforeTopic(t.slug),
      loc = location('clipart', t.slug);
    await sitemapChange(
      'pages',
      loc,
      old ? pageEntry(loc) : null,
      t.record ? pageEntry(loc) : null,
    );
  }
  const oldCounts = collectionBefore.global,
    afterCC = await openSevenFacetCollectionContext(bucket, {
      snapshot: candidate,
      allowUnpublishableFixture: true,
    });
  if (Boolean(oldCounts.totals.printable) !== Boolean(afterCC.global.totals.printable)) {
    const loc = 'https://ultraclipart.com/black-and-white/';
    await sitemapChange(
      'pages',
      loc,
      oldCounts.totals.printable ? pageEntry(loc) : null,
      afterCC.global.totals.printable ? pageEntry(loc) : null,
    );
  }
  for (const slug of new Set([
    ...Object.keys(oldCounts.collections),
    ...Object.keys(afterCC.global.collections),
  ])) {
    const loc = location('collection', slug);
    if (Boolean(oldCounts.collections[slug]) !== Boolean(afterCC.global.collections[slug]))
      await sitemapChange(
        'pages',
        loc,
        oldCounts.collections[slug] ? pageEntry(loc) : null,
        afterCC.global.collections[slug] ? pageEntry(loc) : null,
      );
  }
  if (sitemapChanges.length)
    indexes.sitemaps = await applySitemapBatch(sitemapStore, indexes.sitemaps, sitemapChanges);
  // Projection provider must derive all source-specific bounded directories,
  // cover rosters, Studio features and UI text from these exact same records.
  const views = await refreshViews({
    bucket,
    sourceReceiptSHA256,
    parentContext: base,
    context: await after(),
    changes: prepared,
    topicChanges,
    searchStore,
    searchDataDescriptor,
    beforeTopic,
    afterTopic,
    readArtwork: (id) => readArtwork(current, id),
  });
  if (!views?.collections || !views?.search || views.sourceReceiptSHA256 !== sourceReceiptSHA256)
    throw Error('All source-bound catalogue projections must be refreshed');
  indexes.collections = views.collections;
  indexes.search = views.search;
  current = await after();
  const collections = await current.getFacet('collections');
  if (!collections.surprise) throw Error('Source-bound discovery ledger required');
  const cuteStore = {
      get: (d) => current.read('collections', d, { maxBytes: 262144 }),
      put: async (value) => {
        const b = new TextEncoder().encode(JSON.stringify(canonical({ schema: 1, ...value }))),
          sha256 = await digest(b),
          d = { key: `catalog/objects/collections/${sha256}.json`, sha256, bytes: b.length };
        await bucket.put(d.key, b);
        return d;
      },
    },
    oldPicks = await cuteStore.get(collections.surprise),
    cuteLedger = changes.length
      ? await applyCuteBatch(
          cuteStore,
          oldPicks.ledger,
          prepared.map((c) => ({
            id: c.id,
            oldRecord: c.oldRecord,
            record: c.record,
            ordinal: ordinals.get(c.id),
          })),
        )
      : oldPicks.ledger,
    picks = changes.length
      ? await cuteProjection(cuteStore, cuteLedger, indexes.artworks.sha256)
      : await cuteStore.put({ ...oldPicks, artworksRootSHA256: indexes.artworks.sha256 });
  indexes.collections = await cuteStore.put({ ...collections, surprise: picks });
  // Legacy private protocol fixtures predate the opening ledger. Real production
  // packets require the bootstrap in prepare-content before they reach here.
  if ((await base.getFacet('collections')).openingIndex)
    indexes.collections = await refreshCollectionOpenings({
      bucket,
      parentContext: base,
      context: await after(),
      topicChanges,
      readArtwork: (id) => readArtwork(current, id),
    });
  let presentationReceipt;
  if (preparePresentation) {
    const presentationContext=await openSnapshot(bucket,{provided:candidate,allowFixture:true,maxReadObjects:20000,maxReadBytes:256*1024*1024});
    const prepared=await preparePresentation({context:presentationContext,bucket});
    if(!prepared?.collections||!prepared?.receipt)throw Error('Canonical presentation stage missing');
    indexes.collections=prepared.collections;presentationReceipt=prepared.receipt;
  }
  const graph = overlay.verifyChangedClosure(indexes);
  return {
    status: 'PRIVATE_COMPLETE_DELTA_REQUIRES_SOURCE_GRAPH_NATIVE_AND_REMOTE_APPROVAL',
    candidate,
    created: overlay.created,
    sourceReceiptSHA256,
    parentSnapshotSHA256: parentContext.rootSHA256,
    graph,
    metrics: overlay.metrics(),
    searchMetrics: searchStore.metrics(),
    collectionMetrics: ccStore.metrics(),
    ...(presentationReceipt?{presentationReceipt}:{}),
    fullCatalogPagesBuilt: 0,
    fullCatalogScans: presentationReceipt ? 1 : 0,
    preparedDiscoveryDocuments: presentationReceipt?.canonicalDocumentsPrepared ?? 0,
    nativeMediaScans: 0,
  };
}
