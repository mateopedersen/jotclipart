// Stages metadata only. The source issuer and atomic publisher remain separate.
import { facetStore, lookupTopic, bytesOf } from '../catalog-collections/store.mjs';
import { membership, validateTopicRecord } from '../catalog-collections/writer.mjs';
import { mapGet, canonical, digest } from '../catalog-search/store.mjs';
import { readUi, readUiEntries } from '../catalog-search/ui-metadata.mjs';
import { lookupHashedRecord } from '../catalog-snapshot/hashed-record-directory.mjs';
import { updateHashedRecord } from '../catalog-snapshot/hashed-record-directory-update.mjs';
import { stageDirectoryBytes } from './stage-directory.mjs';
import { collectionStore, readFacts, patchFacts, topicFacts, LIMITS } from './facts.mjs';
import { readShellField, shellFieldLimit } from './shell.mjs';
import { reconcilePages, projectionDigest } from './pages.mjs';
import { deriveViews, replaceSiteEntries, fieldKey, alignCategoryOrder } from './views.mjs';
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)),
  hex = /^[a-f0-9]{64}$/;
export async function refreshDiscoveryViews({
  bucket,
  parentContext,
  context,
  changes,
  topicChanges,
  searchStore,
  searchDataDescriptor,
  beforeTopic,
  afterTopic,
  readArtwork,
  sourceReceiptSHA256,
}) {
  if (
    !bucket ||
    !hex.test(sourceReceiptSHA256 ?? '') ||
    !hex.test(parentContext?.rootSHA256 ?? '') ||
    !hex.test(context?.rootSHA256 ?? '') ||
    !Array.isArray(topicChanges) ||
    !topicChanges.length ||
    topicChanges.length > LIMITS.changedTopics ||
    new Set(topicChanges.map((t) => t.slug)).size !== topicChanges.length ||
    !Array.isArray(changes) ||
    typeof readArtwork !== 'function' ||
    typeof beforeTopic !== 'function' ||
    typeof afterTopic !== 'function'
  )
    throw Error('Bounded source-checked discovery refresh required');
  const cstore = facetStore(bucket, {
      writable: true,
      maxReads: 100000,
      maxBytes: 256 * 1024 * 1024,
    }),
    store = collectionStore(cstore),
    beforeCollections = await parentContext.getFacet('collections'),
    afterCollections = await context.getFacet('collections');
  if (!beforeCollections.discoveryProjection)
    throw Error('Source projection bootstrap required before a content-only batch');
  const factsBefore = await readFacts(store, beforeCollections.discoveryProjection);
  if (factsBefore.root.artworkRootSHA256 !== parentContext.snapshot.indexes.artworks.sha256)
    throw Error('Stale discovery artwork parent');
  const beforeRecent = await parentContext.getFacet('recent'),
    afterRecent = await context.getFacet('recent');
  if (
    beforeRecent.type !== 'recent-directory' ||
    afterRecent.type !== 'recent-directory' ||
    factsBefore.root.recentLedgerSHA256 !== beforeRecent.ledger.sha256
  )
    throw Error('Stale discovery ordinal parent');
  const afterLedger = await context.read('recent', afterRecent.ledger, { maxBytes: 65536 });
  if (afterLedger.type !== 'recent-ledger') throw Error('Canonical recent ordinal ledger required');
  const recentStore = { get: (d) => context.read('recent', d, { maxBytes: 65536 }) };
  const shell = await parentContext.read('collections', beforeCollections.shells, {
      maxBytes: 65536,
    }),
    fields = {};
  for (const name of Object.keys(shell.fields))
    fields[name] = await readShellField(parentContext, shell, name);
  for (const name of [
    'subjects',
    'topics',
    'clusters',
    'clustersData',
    'clusterPicks',
    'staticIds',
    'directoryIds',
    'colors',
    'styles',
    'studioCompositionPreviews',
  ])
    if (!Array.isArray(fields[name])) throw Error('Incomplete discovery shell fields');
  const changed = new Set(topicChanges.map((t) => t.slug));
  for (const change of changes)
    for (const a of [change.oldRecord, change.record])
      if (a && !changed.has(a.topic)) throw Error('Artwork change omitted its discovery topic');
  const staticIds = new Set(fields.staticIds);
  for (const change of changes)
    if (
      staticIds.has(change.id) &&
      (!change.record || !change.record.published || !change.record.indexable)
    )
      throw Error('Unsupported static feature withdrawal');
  const sourceFacts = new Map([...factsBefore.topics].map(([slug, v]) => [slug, v.facts])),
    oldTopicMap = new Map(fields.topics.map((t) => [t.slug, t])),
    plans = [];
  let lookups = 0,
    peak = 0,
    pending = 0;
  for (const change of topicChanges) {
    const oldEntry = await lookupTopic(
        cstore,
        beforeCollections.directory,
        'collection',
        change.slug,
      ),
      oldRecord = await beforeTopic(change.slug);
    if (
      (oldEntry?.sha256 ?? null) !== change.expectedRecordSha256 ||
      Boolean(oldRecord) !== Boolean(oldEntry)
    )
      throw Error('Stale projection source topic');
    const record = await afterTopic(change.slug),
      entry = await lookupTopic(cstore, afterCollections.directory, 'collection', change.slug);
    if (record === null) {
      if (entry) throw Error('Withdrawn projection topic still exists');
      sourceFacts.delete(change.slug);
      plans.push({ slug: change.slug, record: null });
      continue;
    }
    if (!record || !entry) throw Error('New projection topic lacks its canonical record');
    validateTopicRecord(record, change.artworkIds);
    const canonicalRecord = await cstore.read('collections', entry),
      ids = await membership(cstore, canonicalRecord);
    if (!same(ids, change.artworkIds)) throw Error('Discovery membership differs');
    for (const key of [
      'slug',
      'keyword',
      'title',
      'summary',
      'metaDescription',
      'primaryCluster',
      'sourceCluster',
      'clusters',
      'paragraphs',
      'editorial',
      'artworkCount',
      'coverArtworkId',
    ])
      if (!same(canonicalRecord[key], record[key]))
        throw Error('Discovery topic source differs: ' + key);
    if (ids.length > LIMITS.topicArtworks || lookups + ids.length > LIMITS.artworkLookups)
      throw Error('Impacted discovery artwork budget');
    lookups += ids.length;
    const rows = Array(ids.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, ids.length) }, async () => {
        while (next < ids.length) {
          const i = next++,
            id = ids[i];
          pending++;
          peak = Math.max(peak, pending);
          try {
            const value = await readArtwork(id, context),
              a = value?.artwork ?? value;
            if (value?.rootSHA256 && value.rootSHA256 !== context.rootSHA256)
              throw Error('Discovery resolver root differs');
            if (!a || a.id !== id || a.topic !== change.slug || !a.published || !a.indexable)
              throw Error('Missing canonical discovery artwork');
            const ordinal = await mapGet(recentStore, afterLedger.records, 'recent-records', id);
            if (
              !ordinal?.row ||
              ordinal.topic !== a.topic ||
              ordinal.sourceSHA256 !== (await projectionDigest(a)) ||
              !Number.isSafeInteger(ordinal.n) ||
              ordinal.n < 0
            )
              throw Error('Discovery artwork/ordinal source differs');
            rows[i] = { artwork: a, n: ordinal.n };
          } finally {
            pending--;
          }
        }
      }),
    );
    const topic = {
      ...(oldTopicMap.get(change.slug) ?? {}),
      slug: record.slug,
      keyword: record.keyword,
      cluster: record.primaryCluster,
      sourceCluster: record.sourceCluster,
      clusterNames: record.clusters.map((c) => c.name),
    };
    const facts = topicFacts(topic, rows);
    delete facts.topic.clusterNames;
    facts.sourceRowsSHA256 = await projectionDigest(
      [...rows].sort((a, b) => a.n - b.n).map((r) => ({ n: r.n, artwork: r.artwork })),
    );
    const roster = {
      schema: 1,
      type: 'catalog-order-preview',
      topic: change.slug,
      ids: [...rows].sort((a, b) => a.n - b.n).map((r) => r.artwork.id),
    };
    if (bytesOf(roster).length > 262144) throw Error('Catalog preview roster byte limit');
    facts.catalogPreview = {
      key: 'catalog/objects/collections/' + (await digest(bytesOf(roster))) + '.json',
      sha256: await digest(bytesOf(roster)),
      bytes: bytesOf(roster).length,
    };
    if (bytesOf(facts).length > 262144) throw Error('Discovery topic fact byte limit');
    sourceFacts.set(change.slug, facts);
    plans.push({ slug: change.slug, record, facts, roster });
  }
  const afterCounts = await context.getFacet('counts'),
    global = await context.read('counts', afterCounts.global, { maxBytes: 65536 }),
    view = deriveViews(fields, sourceFacts, global);
  if (afterLedger.total !== global.totals.artworks) throw Error('Discovery/recent totals differ');
  const oldBound = await parentContext.getFacet('search'),
    oldData = { manifest: oldBound, store: searchStore },
    ui = await readUi({ snapshotSha256: parentContext.rootSHA256 }, oldData),
    site = await readUiEntries(searchStore, ui, 'site', 'public-site-search-entries');
  view.ui.categories = alignCategoryOrder(
    view.ui.categories,
    await readUiEntries(searchStore, ui, 'categories', 'studio-category-entries'),
  );
  const desiredSite = replaceSiteEntries(
    site,
    view.topics.map((t) => ({ ...t, count: sourceFacts.get(t.slug).count })),
    view.fields.clusters,
  );
  const newSearch = await searchStore.get(searchDataDescriptor),
    { ui: staleUi, ...bare } = newSearch;
  bare.topics = view.topics.map(({ slug, keyword }) => ({ slug, keyword }));
  bare.revision = context.snapshot.revision;
  bare.sourceReceiptSHA256 = sourceReceiptSHA256;
  const desiredUi = { site: desiredSite, ...view.ui };
  for (const [name, values] of Object.entries(view.fields)) {
    if (
      values.length > shellFieldLimit(name) ||
      new Set(values.map((v) => fieldKey(name, v))).size !== values.length
    )
      throw Error('Discovery field budget/identity');
    for (const row of values)
      if (new TextEncoder().encode(JSON.stringify(row)).length > 47000)
        throw Error('Oversized discovery field row');
  }
  // All source/cross-facet checks above precede immutable staging.
  const updates = new Map(),
    previewUpdates = [];
  for (const plan of plans) {
    if (!plan.record) {
      updates.set(plan.slug, null);
      previewUpdates.push({ slug: plan.slug, next: null });
      continue;
    }
    const roster = await cstore.put('collections', plan.roster);
    if (!same(roster, plan.facts.catalogPreview)) throw Error('Roster digest differs');
    updates.set(plan.slug, await store.put(plan.facts));
    previewUpdates.push({ slug: plan.slug, next: roster });
  }
  const ledger = await patchFacts(store, beforeCollections.discoveryProjection, updates, {
    artworkRootSHA256: context.snapshot.indexes.artworks.sha256,
    recentLedgerSHA256: afterRecent.ledger.sha256,
    total: global.totals.artworks,
  });
  const metrics = { artworkLookups: lookups, peakArtworkLookups: peak, shell: {}, ui: {} };
  const nextFields = {};
  for (const [name, values] of Object.entries(view.fields)) {
    const r = await reconcilePages(store, shell.fields[name], 'discovery-shell-rows', values, {
      stable: shell.paging === 'stable-v2',
      field: name,
      key: (v) => fieldKey(name, v),
      limit: shellFieldLimit(name),
    });
    nextFields[name] = r.pages;
    metrics.shell[name] = r.metrics;
  }
  const shellDescriptor = await store.put({
    ...shell,
    paging: 'stable-v2',
    sourceCatalogRevision: context.snapshot.revision,
    sourceReceiptSHA256,
    fields: nextFields,
  });
  let previewDirectory = afterCollections.catalogPreviewDirectory;
  const directoryContext = {
    read: async (facet, d) => {
      if (facet !== 'collections') throw Error('Projection namespace differs');
      return cstore.read('collections', d);
    },
  };
  for (const plan of previewUpdates) {
    const prior =
      (await lookupHashedRecord(directoryContext, 'collections', previewDirectory, plan.slug)) ??
      null;
    if (same(prior, plan.next)) continue;
    const result = await updateHashedRecord(directoryContext, 'collections', previewDirectory, {
      name: plan.slug,
      expectedValue: prior,
      newValue: plan.next,
    });
    for (const [key, bytes] of result.created) await stageDirectoryBytes(bucket, key, bytes);
    previewDirectory = result.root;
  }
  const studioFeatured = await store.put({ type: 'studio-featured', ids: view.ui.featuredIds }),
    collections = await store.put({
      ...afterCollections,
      shells: shellDescriptor,
      discoveryProjection: ledger,
      catalogPreviewDirectory: previewDirectory,
      studioFeatured,
    });
  const dataRoot = await searchStore.put(bare),
    parts = {};
  for (const [name, type, desired] of [
    ['site', 'public-site-search-entries', desiredSite],
    ['categories', 'studio-category-entries', view.ui.categories],
    ['mono', 'monochrome-topic-entries', view.ui.monochrome.topics],
  ]) {
    const r = await reconcilePages(searchStore, ui[name], type, desired, {
      stable: ui.type === 'source-bound-search-ui-v2',
      key: (v) => v.id ?? v.slug,
    });
    parts[name] = r.pages;
    metrics.ui[name] = r.metrics;
  }
  const boundUi = {
      schema: 1,
      type: 'source-bound-search-ui-v2',
      dataRoot,
      sourceSha256: await projectionDigest(desiredUi),
      sourceReceiptSHA256,
      ...parts,
      monoGlobal: {
        total: view.ui.monochrome.total,
        collections: view.ui.monochrome.collections,
        kinds: view.ui.monochrome.kinds,
      },
      featuredIds: view.ui.featuredIds,
    },
    uiDescriptor = await searchStore.put(boundUi),
    search = await searchStore.put({ ...bare, ui: uiDescriptor });
  return { collections, search, sourceReceiptSHA256, metrics, publicationVerified: false };
}
