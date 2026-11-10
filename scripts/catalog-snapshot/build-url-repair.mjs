// Bounded, source-bound repair of missed legacy routes. Never rewrites artwork records.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDeltaStore } from './delta-store.mjs';
import { openSnapshot } from '../../server/catalog-snapshot/snapshot-context.mjs';
import { canonical, mapEntries, mapGet, patchMap } from '../../server/catalog-search/store.mjs';
import { validateRoutes } from '../../server/catalog-snapshot/public-artwork-routes.mjs';
import { readableArtworkSlug } from '../../src/lib/artwork-route.mjs';
import { readSitemap } from '../../server/catalog-snapshot/sitemap-reader.mjs';
import { applySitemapBatch } from '../../server/catalog-snapshot/sitemap-ledger.mjs';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const origin = 'https://ultraclipart.com';
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const reviewedHistoricalPrefixes = Object.freeze({
  '300-movie': '300',
  presentation: 'powerpoint',
  tesla: 'tesla-brand',
});

// Historical prefixes are explicit source-bound evidence, not today's mutable topic name.
// This predicate must never rename a descriptive URL merely because it contains a number.
export function missedLegacyRoute({ id, oldSlug, topic, historicalTopicPrefix }) {
  return (
    oldSlug === id &&
    SLUG.test(id ?? '') &&
    SLUG.test(topic ?? '') &&
    SLUG.test(historicalTopicPrefix ?? '') &&
    reviewedHistoricalPrefixes[topic] === historicalTopicPrefix &&
    id.startsWith(historicalTopicPrefix + '-') &&
    /^\d{2,4}$/.test(id.slice(historicalTopicPrefix.length + 1))
  );
}

// Owner scope expanded on 10 November: remove package ordinals even when scene words remain.
// The same numeric token in accepted subject copy is meaningful and stays stable.
export function artificialOrdinalRoute({ id, oldSlug, topic, title }) {
  if (oldSlug !== id || !SLUG.test(id ?? '') || !SLUG.test(topic ?? '') || typeof title !== 'string') return null;
  const escaped = topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const before = new RegExp('^' + escaped + '-(?:(?:clipart|typography)-)?(\\d{2,4})-.+').exec(oldSlug);
  const after = new RegExp('^' + escaped + '-.+-(\\d{2,4})$').exec(oldSlug);
  const padded = /(?:^|-)(0\d{1,3})(?=-|$)/.exec(oldSlug);
  const tagged = /(?:^|-)(?:clipart|artwork)-(\d{2,4})-/.exec(oldSlug);
  const version = /-v([2-9]\d*)$/.exec(oldSlug);
  const tokens = [...(title.match(/\d+/g) ?? []), ...(topic.match(/\d+/g) ?? [])];
  for (const [match, ordinalKind] of [[before, 'package-ordinal-before-scene'], [after, 'package-ordinal-after-scene'], [padded, 'zero-padded-package-ordinal'], [tagged, 'tagged-package-ordinal'], [version, 'source-file-version-suffix']]) {
    if (match && !tokens.some(n => Number(n) === Number(match[1]))) return {ordinal:match[1], ordinalKind};
  }
  return null;
}

export async function buildURLRepair({
  parentContext,
  parentBucket,
  revision,
  plan,
  preparePresentation,
  progress = () => {},
}) {
  assert.match(revision ?? '', /^[a-f0-9]{40}$/);
  assert.notEqual(revision, parentContext.snapshot.revision);
  assert.equal(plan.schema, 1);
  assert(['OWNER_AUTHORIZED_READABLE_ARTWORK_URL_REPAIR', 'OWNER_AUTHORIZED_ARTWORK_ORDINAL_URL_REPAIR'].includes(plan.kind));
  const ordinalRepair = plan.kind === 'OWNER_AUTHORIZED_ARTWORK_ORDINAL_URL_REPAIR';
  assert.equal(plan.parentRoot, parentContext.rootSHA256);
  assert(Array.isArray(plan.changes) && plan.changes.length > 0 && plan.changes.length <= (ordinalRepair ? 8000 : 500));
  const overlay = createDeltaStore(parentBucket, parentContext, {
    maxObjects: 20000,
    maxBytes: 384 * 1024 * 1024,
  });
  const base = await openSnapshot(overlay.bucket, {
    provided: parentContext.snapshot,
    maxConcurrentReads: 16,
    maxReadObjects: 20000,
    maxReadBytes: 384 * 1024 * 1024,
  });
  const originalRead = base.read;
  base.read = (facet, descriptor, options) => {
    parentBucket.hint?.(descriptor);
    return originalRead(facet, descriptor, options);
  };
  const art = await base.getFacet('artworks'),
    collections = await base.getFacet('collections');
  assert(art.publicRoutes, 'Repair requires the already installed public route projection');
  const rows = new Map();
  async function parallel(values, inspect) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(8, values.length) }, async () => {
      while (next < values.length) await inspect(values[next++]);
    }));
  }
  async function visit(d, prefix) {
    const leaf = await base.read('artworks', d);
    if (leaf.type === 'artwork-split') {
      assert.equal(leaf.prefix, prefix);
      await parallel(Object.entries(leaf.children), ([part, child]) => visit(child, part));
      return;
    }
    assert.equal(leaf.shard, prefix);
    assert(Array.isArray(leaf.records));
    for (const row of leaf.records) {
      assert(!rows.has(row.id));
      assert(sha(row.id).startsWith(prefix));
      rows.set(row.id, row);
    }
  }
  await parallel(Object.entries(art.directories), async ([prefix, d]) => {
    const directory = await base.read('artworks', d);
    assert.equal(directory.type, 'artwork-directory');
    assert.equal(directory.prefix, prefix);
    await parallel(Object.entries(directory.shards), ([part, child]) => visit(child, part));
  });
  assert.equal(rows.size, plan.total);
  const store = {
    get: (d) => base.read('artworks', d, { maxBytes: 65536 }),
    put: (value) => stage('artworks', value),
  };
  const routes = validateRoutes(await base.read('artworks', art.publicRoutes));
  async function warmMap(d) {
    const value = await store.get(d);
    if (value.children) await parallel(Object.values(value.children), warmMap);
  }
  await warmMap(routes.byId);
  await warmMap(routes.byPath);
  const ids = new Map(),
    paths = new Map();
  for await (const { key, value } of mapEntries(store, routes.byId, 'public-artwork-ids')) {
    assert(rows.has(key));
    assert.equal(value.id, key);
    assert(SLUG.test(value.slug));
    ids.set(key, value);
  }
  assert.equal(ids.size, rows.size);
  assert.equal(routes.artworks, rows.size);
  for await (const { key, value } of mapEntries(store, routes.byPath, 'public-artwork-paths')) {
    assert(SLUG.test(key));
    assert.deepEqual(value, ids.get(value.id));
    paths.set(key, value);
  }
  for (const [id, value] of ids) {
    assert.deepEqual(paths.get(id), value);
    assert.deepEqual(paths.get(value.slug), value);
  }
  const changed = new Map(),
    idChanges = new Map(),
    pathChanges = new Map();
  for (const change of plan.changes) {
    assert(!changed.has(change.id));
    const row = rows.get(change.id);
    assert(row);
    assert.equal(change.title, row.title);
    assert.equal(change.topic, row.topic);
    assert.equal(change.sourceRecordSHA256, sha(JSON.stringify(canonical(row))));
    assert.equal(change.original, row.webp);
    if (ordinalRepair) {
      const ordinal = artificialOrdinalRoute(change);
      assert(ordinal, 'Only source-bound artificial package ordinals');
      assert.equal(change.ordinalKind, ordinal.ordinalKind);
      assert.equal(change.ordinal, ordinal.ordinal);
    } else assert(missedLegacyRoute(change), 'Only explicitly reviewed bare historical topic/serial URLs');
    assert.equal(ids.get(change.id).slug, change.oldSlug, 'Stale canonical route');
    assert.equal(change.slug, readableArtworkSlug(row.title), 'Use accepted source title only');
    assert(!/^\d+(?:-\d+)*$/.test(change.slug), 'New route cannot be numeric only');
    assert.notEqual(change.slug, change.oldSlug);
    const taken = paths.get(change.slug);
    assert(!taken || taken.id === change.id, 'Reserved canonical or historical path collision');
    assert(![...changed.values()].some((c) => c.slug === change.slug), 'Duplicate new slug');
    const value = { id: change.id, slug: change.slug };
    changed.set(change.id, change);
    idChanges.set(change.id, value);
    pathChanges.set(change.slug, value);
  }
  // Repoint every existing alias directly to the new canonical address, preserving reservations.
  for (const [path, value] of paths)
    if (changed.has(value.id))
      pathChanges.set(path, { id: value.id, slug: changed.get(value.id).slug });
  async function stage(facet, value) {
    const body = Buffer.from(JSON.stringify(canonical({ schema: 1, ...value }))),
      sha256 = sha(body);
    const d = { key: `catalog/objects/${facet}/${sha256}.json`, sha256, bytes: body.length };
    await overlay.bucket.put(d.key, body);
    return d;
  }
  const publicRoutes = await store.put({
    ...routes,
    byId: await patchMap(store, routes.byId, 'public-artwork-ids', idChanges),
    byPath: await patchMap(store, routes.byPath, 'public-artwork-paths', pathChanges),
  });
  const nextRouteValue = await store.get(publicRoutes);
  let preservedIDs = 0,
    preservedPaths = 0;
  for await (const { key, value } of mapEntries(store, nextRouteValue.byId, 'public-artwork-ids')) {
    assert.deepEqual(value, idChanges.get(key) ?? ids.get(key));
    assert(!/^\d+(?:-\d+)*$/.test(value.slug), 'Numeric-only canonical remains');
    assert(!/-20\d{6}-\d{2,4}$/.test(value.slug), 'Machine date/serial canonical remains');
    const row = rows.get(key);
    if (ordinalRepair) assert(!artificialOrdinalRoute({id:key,oldSlug:value.slug,topic:row.topic,title:row.title}), 'Artificial package ordinal remains');
    assert(
      !missedLegacyRoute({
        id: key,
        oldSlug: value.slug,
        topic: row.topic,
        historicalTopicPrefix: reviewedHistoricalPrefixes[row.topic],
      }),
      'Missed legacy canonical remains',
    );
    if (!changed.has(key)) preservedIDs++;
  }
  for await (const { key, value } of mapEntries(
    store,
    nextRouteValue.byPath,
    'public-artwork-paths',
  )) {
    assert.deepEqual(value, pathChanges.get(key) ?? paths.get(key));
    if (!pathChanges.has(key)) preservedPaths++;
  }
  assert.equal(nextRouteValue.byId.count, routes.byId.count);
  assert.equal(
    nextRouteValue.byPath.count,
    paths.size + [...changed.values()].filter((c) => !paths.has(c.slug)).length,
  );
  const artworks = await stage('artworks', { ...art, revision, publicRoutes });
  const sitemapRoot = await base.getFacet('sitemaps');
  const index = await readSitemap(base, '/sitemap.xml');
  const kinds = [
    ...index.matchAll(/<loc>https:\/\/ultraclipart.com\/sitemap-([^<]+)\.xml<\/loc>/g),
  ].map((m) => m[1]);
  const families = new Map([
      ['pages', new Map()],
      ['images', new Map()],
    ]),
    sitemapChanges = [];
  for (const kind of kinds) {
    const xml = await readSitemap(base, `/sitemap-${kind}.xml`),
      entries = xml.match(/<url>.*?<\/url>/gs) ?? [];
    assert(entries.length <= 10000);
    const image = kind.startsWith('images'),
      map = families.get(image ? 'images' : 'pages');
    for (const entry of entries) {
      const loc = /<loc>([^<]+)<\/loc>/.exec(entry)?.[1];
      assert(loc && !map.has(loc));
      map.set(loc, entry);
      const path = /^https:\/\/ultraclipart.com\/art\/([a-z0-9-]+)\/$/.exec(loc)?.[1];
      if (!path) {
        assert(!image);
        continue;
      }
      const route = paths.get(path);
      assert(route);
      assert.equal(route.slug, path);
      const row = rows.get(route.id);
      assert(row.published && row.indexable);
      if (image)
        assert(entry.includes('<image:loc>' + row.webp.replace(/&/g, '&amp;') + '</image:loc>'));
      const change = changed.get(route.id);
      if (change) {
        const nextLoc = `${origin}/art/${change.slug}/`,
          family = image ? 'images' : 'art';
        assert.equal(path, change.oldSlug);
        sitemapChanges.push(
          { kind: family, loc, entry: null, expectedEntrySHA256: sha(entry) },
          {
            kind: family,
            loc: nextLoc,
            entry: entry.replace(`<loc>${loc}</loc>`, `<loc>${nextLoc}</loc>`),
            expectedEntrySHA256: null,
          },
        );
      }
    }
  }
  const published = [...rows.values()].filter((r) => r.published && r.indexable);
  assert.equal(families.get('images').size, published.length);
  for (const row of published) {
    const loc = `${origin}/art/${ids.get(row.id).slug}/`;
    assert(families.get('pages').has(loc));
    assert(families.get('images').has(loc));
  }
  assert.equal(sitemapChanges.length, changed.size * 4);
  const nextSitemaps = await applySitemapBatch(
    {
      get: (d) => base.read('sitemaps', d, { maxBytes: 1048576 }),
      put: (value) => stage('sitemaps', value),
    },
    base.snapshot.indexes.sitemaps,
    sitemapChanges,
  );
  const discovery = await base.read('collections', collections.discoveryProjection, {
    maxBytes: 262144,
  });
  const surprise = await base.read('collections', collections.surprise, { maxBytes: 262144 });
  assert.equal(discovery.artworkRootSHA256, base.snapshot.indexes.artworks.sha256);
  assert.equal(surprise.artworksRootSHA256, base.snapshot.indexes.artworks.sha256);
  const nextCollections = {
    ...collections,
    discoveryProjection: await stage('collections', {
      ...discovery,
      artworkRootSHA256: artworks.sha256,
    }),
    surprise: await stage('collections', { ...surprise, artworksRootSHA256: artworks.sha256 }),
  };
  delete nextCollections.preparedHTML;
  const indexes = {
    ...base.snapshot.indexes,
    artworks,
    sitemaps: nextSitemaps,
    collections: await stage('collections', nextCollections),
  };
  const candidate = {
    schema: 1,
    fixture: true,
    status: 'PRIVATE_UNPUBLISHABLE',
    revision,
    parentRevision: base.snapshot.revision,
    indexes,
  };
  const current = await openSnapshot(overlay.bucket, {
    provided: candidate,
    allowFixture: true,
    maxReadObjects: 20000,
    maxReadBytes: 384 * 1024 * 1024,
  });
  const afterFamilies = new Map([
      ['pages', new Map()],
      ['images', new Map()],
    ]),
    documents = [];
  const nextIndex = await readSitemap(current, '/sitemap.xml');
  for (const match of nextIndex.matchAll(
    /<loc>https:\/\/ultraclipart.com\/sitemap-([^<]+)\.xml<\/loc>/g,
  )) {
    const kind = match[1],
      xml = await readSitemap(current, `/sitemap-${kind}.xml`),
      entries = xml.match(/<url>.*?<\/url>/gs) ?? [];
    assert(entries.length <= 10000);
    const map = afterFamilies.get(kind.startsWith('images') ? 'images' : 'pages');
    for (const entry of entries) {
      const loc = /<loc>([^<]+)<\/loc>/.exec(entry)[1];
      assert(!map.has(loc));
      map.set(loc, entry);
    }
    documents.push({ kind, urls: entries.length });
  }
  for (const family of ['pages', 'images']) {
    const expected = new Map(families.get(family));
    for (const c of changed.values()) {
      const old = `${origin}/art/${c.oldSlug}/`,
        next = `${origin}/art/${c.slug}/`,
        entry = expected.get(old);
      assert(entry);
      expected.delete(old);
      expected.set(next, entry.replace(`<loc>${old}</loc>`, `<loc>${next}</loc>`));
    }
    assert.deepEqual(
      [...afterFamilies.get(family)].sort(),
      [...expected].sort(),
      'Unrelated sitemap entries changed',
    );
  }
  progress({
    phase: 'missed-legacy-routes-repaired',
    artworks: rows.size,
    redirects: changed.size,
    preservedIDs,
    preservedPaths,
    sitemaps: documents.length,
  });
  const prepared = await preparePresentation({ context: current, bucket: overlay.bucket });
  assert(prepared?.collections && prepared?.receipt);
  indexes.collections = prepared.collections;
  const graph = overlay.verifyChangedClosure(indexes);
  const bridge = {
    kind: 'OWNER_AUTHORIZED_PUBLIC_URL_AND_SITEMAP_REPAIR',
    parentRevision: base.snapshot.revision,
    revision,
    redirects: changed.size,
    canonicalArtworkRecordsChanged: 0,
    canonicalArtworkDirectoriesUnchanged: same(
      art.directories,
      (await current.getFacet('artworks')).directories,
    ),
    protectedCollectionDirectoryUnchanged: same(collections.directory, nextCollections.directory),
    publicRoutesRepaired: true,
    sourceRecordChecks: rows.size,
    repairedRecordChecksumChecks: changed.size,
    preservedCanonicalIDs: preservedIDs,
    preservedHistoricalPaths: preservedPaths,
    historicalReservationsRemoved: 0,
    topicRecordsChanged: 0,
    mediaBytesChanged: 0,
    unchangedFacets: ['counts', 'related', 'recent', 'search'],
    sitemaps: documents,
    inheritedPages: families.get('pages').size,
    inheritedImages: families.get('images').size,
  };
  return {
    candidate,
    created: overlay.created,
    graph,
    presentationReceipt: prepared.receipt,
    bridge,
    metrics: overlay.metrics(),
    preparedDiscoveryDocuments: prepared.receipt.canonicalDocumentsPrepared,
  };
}
