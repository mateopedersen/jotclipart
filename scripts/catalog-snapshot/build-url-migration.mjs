// Finite, owner-authorized address migration. Source artwork records/media stay immutable.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDeltaStore } from './delta-store.mjs';
import { openSnapshot } from '../../server/catalog-snapshot/snapshot-context.mjs';
import { canonical } from '../../server/catalog-search/store.mjs';
import { buildPublicArtworkRoutes } from '../../server/catalog-snapshot/public-artwork-routes.mjs';
import { readSitemap } from '../../server/catalog-snapshot/sitemap-reader.mjs';
import { readableArtworkSlug, needsReadableArtworkSlug } from '../../src/lib/artwork-route.mjs';
import {
  bootstrapSitemaps,
  sitemapEnvelope,
} from '../../server/catalog-snapshot/sitemap-ledger.mjs';
import {
  canonicalPageFamily,
  sitemapDocumentKind,
  SITEMAP_URL_LIMIT,
} from '../../server/catalog-snapshot/sitemap-policy.mjs';
import { activeCuratedCollections } from '../../src/lib/curated-collection-policy.mjs';
import { openSevenFacetCollectionContext } from '../../server/catalog-snapshot/collection-context.mjs';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export async function buildURLMigration({
  parentContext,
  parentBucket,
  revision,
  plan,
  preparePresentation,
  progress = () => {},
}) {
  if (
    !/^[a-f0-9]{40}$/.test(revision ?? '') ||
    revision === parentContext.snapshot.revision ||
    plan.schema !== 1 ||
    plan.kind !== 'OWNER_AUTHORIZED_READABLE_ARTWORK_URL_MIGRATION' ||
    plan.parentRoot !== parentContext.rootSHA256 ||
    !Array.isArray(plan.changes)
  )
    throw Error('Current source-bound URL migration required');
  const overlay = createDeltaStore(parentBucket, parentContext, {
    maxObjects: 20000,
    maxBytes: 384 * 1024 * 1024,
  });
  const base = await openSnapshot(overlay.bucket, {
    provided: parentContext.snapshot,
    maxReadObjects: 20000,
    maxReadBytes: 384 * 1024 * 1024,
  });
  const art = await base.getFacet('artworks'),
    collections = await base.getFacet('collections');
  if (art.publicRoutes) throw Error('The finite legacy migration is already installed');
  const rows = [],
    seen = new Set();
  async function visit(d, prefix) {
    const leaf = await base.read('artworks', d);
    if (leaf.type === 'artwork-split') {
      assert.equal(leaf.prefix, prefix);
      for (const [part, child] of Object.entries(leaf.children)) await visit(child, part);
      return;
    }
    assert.equal(leaf.shard, prefix);
    assert(Array.isArray(leaf.records));
    for (const r of leaf.records) {
      assert(!seen.has(r.id));
      assert(sha(r.id).startsWith(prefix));
      seen.add(r.id);
      rows.push(r);
    }
  }
  for (const [prefix, d] of Object.entries(art.directories)) {
    const directory = await base.read('artworks', d);
    assert.equal(directory.prefix, prefix);
    assert.equal(directory.type, 'artwork-directory');
    for (const [part, child] of Object.entries(directory.shards)) await visit(child, part);
  }
  rows.sort((a, b) => a.id.localeCompare(b.id, 'en'));
  assert.equal(rows.length, plan.total);
  const byID = new Map(rows.map((r) => [r.id, r])),
    assignments = new Map();
  for (const c of plan.changes) {
    const r = byID.get(c.id);
    assert(r);
    assert(!assignments.has(c.id));
    assert.equal(c.title, r.title);
    assert.equal(c.sourceRecordSHA256, sha(JSON.stringify(canonical(r))));
    assert(needsReadableArtworkSlug(r.id, r.topic), 'Already descriptive URLs must stay canonical');
    if (c.slug !== readableArtworkSlug(r.title)) {
      const review = c.routeReview;
      assert.equal(review?.scope, 'URL disambiguation only, accepted metadata unchanged');
      assert.equal(review.inspectedOriginalPixels, true);
      assert(/^[a-f0-9]{64}$/.test(review.sourceImageSHA256));
      assert(r.webp.includes('.' + review.sourceImageSHA256.slice(0, 16) + '.'));
      assert(Array.isArray(review.observations) && review.observations.length >= 2);
      assert.equal(c.slug, readableArtworkSlug(c.slug));
      assert(!/-\d+$/.test(c.slug), 'No artificial numeric route disambiguation');
    }
    assignments.set(c.id, c.slug);
  }
  const stage = async (facet, value) => {
    const body = Buffer.from(JSON.stringify(canonical({ schema: 1, ...value }))),
      sha256 = sha(body),
      d = { key: `catalog/objects/${facet}/${sha256}.json`, sha256, bytes: body.length };
    await overlay.bucket.put(d.key, body);
    return d;
  };
  const publicRoutes = await buildPublicArtworkRoutes(
    { get: (d) => base.read('artworks', d), put: (value) => stage('artworks', value) },
    rows,
    assignments,
  );
  const artworks = await stage('artworks', { ...art, revision, publicRoutes });
  const indexXML = await readSitemap(base, '/sitemap.xml'),
    kinds = [
      ...indexXML.matchAll(/<loc>https:\/\/ultraclipart.com\/sitemap-([^<]+)\.xml<\/loc>/g),
    ].map((m) => m[1]);
  const families = new Map(
    ['pages', 'topics', 'collections', 'art', 'images'].map((k) => [k, new Map()]),
  );
  let inheritedPages = 0,
    inheritedImages = 0;
  for (const kind of kinds) {
    const xml = await readSitemap(base, `/sitemap-${kind}.xml`);
    assert(xml);
    for (const entry of xml.match(/<url>.*?<\/url>/gs) ?? []) {
      const oldLoc = /<loc>([^<]+)<\/loc>/.exec(entry)?.[1];
      assert(oldLoc);
      let loc = oldLoc;
      if (oldLoc.startsWith('https://ultraclipart.com/art/')) {
        const id = oldLoc.split('/')[4];
        assert(byID.has(id), 'Sitemap artwork is absent from canonical records');
        loc = `https://ultraclipart.com/art/${assignments.get(id) ?? id}/`;
      }
      const family = kind.startsWith('images') ? 'images' : canonicalPageFamily(loc),
        map = families.get(family);
      assert(!map.has(loc), 'Repeated canonical URL in predecessor sitemap');
      map.set(loc, entry.replace(`<loc>${oldLoc}</loc>`, `<loc>${loc}</loc>`));
      family === 'images' ? inheritedImages++ : inheritedPages++;
    }
  }
  const cc = await openSevenFacetCollectionContext(overlay.bucket, { snapshot: base.snapshot }),
    counts = await cc.allLegacyCounts();
  for (const g of activeCuratedCollections(counts.topics)) {
    const loc = `https://ultraclipart.com/collection/${g.slug}/`;
    families.get('collections').set(loc, `<url><loc>${loc}</loc></url>`);
  }
  const expected = rows.filter((r) => r.published && r.indexable);
  assert.equal(families.get('art').size, expected.length);
  assert.equal(families.get('images').size, expected.length);
  for (const r of expected) {
    const loc = `https://ultraclipart.com/art/${assignments.get(r.id) ?? r.id}/`;
    assert(families.get('art').has(loc));
    assert(
      families
        .get('images')
        .get(loc)
        .includes('<image:loc>' + r.webp.replace(/&/g, '&amp;') + '</image:loc>'),
    );
  }
  const documents = [];
  for (const [family, map] of families) {
    const entries = [...map].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([, e]) => e);
    for (let n = 0; n < entries.length; n += SITEMAP_URL_LIMIT) {
      const kind = sitemapDocumentKind(family, Math.floor(n / SITEMAP_URL_LIMIT) + 1);
      documents.push({
        kind,
        xml: sitemapEnvelope(kind) + entries.slice(n, n + SITEMAP_URL_LIMIT).join('') + '</urlset>',
      });
    }
  }
  const sitemapRoot = await bootstrapSitemaps(
    {
      get: (d) => base.read('sitemaps', d, { maxBytes: 1048576 }),
      put: (v) => stage('sitemaps', v),
    },
    documents,
    { separated: true },
  );
  const discovery = await base.read('collections', collections.discoveryProjection, {
      maxBytes: 262144,
    }),
    surprise = await base.read('collections', collections.surprise, { maxBytes: 262144 });
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
    sitemaps: sitemapRoot,
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
  progress({
    phase: 'routes-and-sitemaps-prepared',
    artworks: rows.length,
    redirects: assignments.size,
    sitemaps: documents.length,
  });
  const prepared = await preparePresentation({ context: current, bucket: overlay.bucket });
  assert(prepared?.collections && prepared?.receipt);
  indexes.collections = prepared.collections;
  assert(same(art.directories, (await current.getFacet('artworks')).directories));
  const graph = overlay.verifyChangedClosure(indexes);
  const bridge = {
    kind: 'OWNER_AUTHORIZED_PUBLIC_URL_AND_SITEMAP_MIGRATION',
    parentRevision: base.snapshot.revision,
    revision,
    redirects: assignments.size,
    canonicalArtworkRecordsChanged: 0,
    canonicalArtworkDirectoriesUnchanged: true,
    protectedCollectionDirectoryUnchanged: same(collections.directory, nextCollections.directory),
    publicRoutesAdded: true,
    sourceRecordChecks: rows.length,
    topicRecordsChanged: 0,
    mediaBytesChanged: 0,
    unchangedFacets: ['counts', 'related', 'recent', 'search'],
    sitemaps: documents.map((d) => ({ kind: d.kind, urls: (d.xml.match(/<url>/g) ?? []).length })),
    inheritedPages,
    inheritedImages,
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
