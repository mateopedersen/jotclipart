// PRIVATE transaction exercise. Random test-only signing key, local in-memory
// overlays and existing metadata files; no production keys, R2, uploads or pointer.
import { readFileSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const out = resolve('work/catalog-snapshot/delta-testing/api.mjs');
await build({
  stdin: {
    resolveDir: process.cwd(),
    contents: `export{buildCatalogDelta}from'./scripts/catalog-snapshot/build-delta.mjs';export{readArtwork}from'./server/catalog-snapshot/artwork-facet-reader.mjs';export{bootstrapProjectionFacts,collectionStore}from'./server/catalog-projections/facts.mjs';export{refreshDiscoveryViews}from'./server/catalog-projections/refresh.mjs';export{facetStore}from'./server/catalog-collections/store.mjs';export{openSevenFacetCollectionContext}from'./server/catalog-snapshot/collection-context.mjs';export{membership}from'./server/catalog-collections/writer.mjs';export{readShellField}from'./server/catalog-projections/shell.mjs';export{captureProductionSnapshot,productionSnapshotMessage}from'./server/catalog-snapshot/signed-production-snapshot.mjs';export{canonical,digest}from'./server/catalog-search/store.mjs';export{openSearch}from'./server/catalog-search/runtime.mjs';export{readSitemap}from'./server/catalog-snapshot/sitemap-reader.mjs';export{readBoundedRelated}from'./server/catalog-snapshot/related-bounded-reader.mjs';export{readSurprisePicks}from'./server/catalog-snapshot/surprise-picks.mjs';`,
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'silent',
});
const m = await import(pathToFileURL(out)),
  read = (p) => JSON.parse(readFileSync(p)),
  base =
    process.argv[2] ??
    (() => {
      throw Error(
        'Usage: node tests/e2e/catalog-delta-composition.mjs protected-signed-metadata-directory',
      );
    })(),
  manifest = read(base + '/manifest.json'),
  original = read(base + '/production-snapshot.json'),
  objects = new Map(),
  sha = (b) => createHash('sha256').update(b).digest('hex');
let activeBytes,
  reads = 0;
const bucket = {
    get: async (key) => {
      const b =
        key === 'catalog/active.json'
          ? activeBytes
          : (objects.get(key) ??
            (manifest.sourceByKey[key] ? readFileSync(manifest.sourceByKey[key]) : null));
      if (!b) return null;
      reads++;
      return {
        size: b.length,
        etag: sha(b),
        arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
        json: async () => JSON.parse(b),
      };
    },
    put: async (key, body, options) => {
      const bytes = Buffer.from(body);
      if (objects.has(key)) return null;
      objects.set(key, bytes);
      return { etag: sha(bytes) };
    },
  },
  pair = generateKeyPairSync('ed25519'),
  verifier = {
    accountId: 'a'.repeat(32),
    bucketName: 'private-transaction-only',
    keyId: 'unit-isolated',
    abiSHA256: 'b'.repeat(64),
    publicKey: Uint8Array.from(
      Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url'),
    ),
  };
async function testEnvelope(indexes, revision, parentRevision) {
  const s = {
    schema: 1,
    status: 'SOURCE_MEDIA_GRAPH_VERIFIED',
    testAuthority: 'RANDOM_LOCAL_KEY_NOT_TRUSTED_BY_PRODUCTION',
    revision,
    parentRevision,
    indexes,
    authorization: {
      policy: 'source-media-graph-ed25519-v1',
      accountId: verifier.accountId,
      bucket: verifier.bucketName,
      keyId: verifier.keyId,
      abiSHA256: verifier.abiSHA256,
      sourceReceiptSHA256: '1'.repeat(64),
      mediaReceiptSHA256: '2'.repeat(64),
      graphReceiptSHA256: '3'.repeat(64),
      manifestRoot: '4'.repeat(64),
      parentSnapshotSHA256: '5'.repeat(64),
      issuedAt: Date.now() - 1000,
    },
  };
  s.authorization.signature = sign(null, m.productionSnapshotMessage(s), pair.privateKey).toString(
    'hex',
  );
  activeBytes = Buffer.from(JSON.stringify(s));
  return m.captureProductionSnapshot(bucket, {
    ...verifier,
    maxReadObjects: 100000,
    maxReadBytes: 1024 ** 3,
  });
}
let context = await testEnvelope(original.indexes, original.revision, original.parentRevision),
  collections = await context.getFacet('collections'),
  recent = await context.getFacet('recent'),
  shell = await context.read('collections', collections.shells),
  topics = await m.readShellField(context, shell, 'topics'),
  artRoot = await context.getFacet('artworks'),
  byId = new Map();
for (const d of Object.values(artRoot.directories)) {
  const directory = await context.read('artworks', d);
  for (const shard of Object.values(directory.shards)) {
    const leaf = await context.read('artworks', shard);
    assert(leaf.records);
    for (const a of leaf.records) byId.set(a.id, a);
  }
}
const sourceOrdered = read('data/art.json')
    .filter((a) => byId.has(a.id))
    .map((a) => byId.get(a.id)),
  cs = m.facetStore(bucket, { writable: true }),
  facts = await m.bootstrapProjectionFacts(m.collectionStore(cs), sourceOrdered, topics, {
    artworkRootSHA256: original.indexes.artworks.sha256,
    recentLedgerSHA256: recent.ledger.sha256,
  }),
  cc = await cs.put('collections', { ...collections, discoveryProjection: facts }),
  indexes = { ...original.indexes, collections: cc };
context = await testEnvelope(indexes, original.revision, original.parentRevision);
const baseline = {
    artworks: sourceOrdered.length,
    topics: collections.topicCount,
    bootstrapObjects: objects.size,
    bootstrapBytes: [...objects.values()].reduce((n, b) => n + b.length, 0),
  },
  source = 'private-protocol-delta',
  id = 'private-protocol-artwork',
  sample = byId.get('election-day-accessible-ballot-marking-station'),
  rows = [],
  hash = (a) => (a ? sha(JSON.stringify(m.canonical(a))) : null);
async function topic(slug) {
  const c = await m.openSevenFacetCollectionContext(bucket, { snapshot: context.snapshot }),
    d = await c.lookupCollection(slug);
  return d
    ? { d, record: await c.read(d), ids: await m.membership(m.facetStore(bucket), await c.read(d)) }
    : null;
}
async function run(name, changes, topicChanges) {
  const beforeReads = reads,
    started = Date.now(),
    revision = sha(Buffer.from(name)).slice(0, 40),
    result = await m.buildCatalogDelta({
      parentContext: context,
      parentBucket: bucket,
      revision,
      sourceReceiptSHA256: '9'.repeat(64),
      changes,
      topicChanges,
      validateSourceChange: async ({ change, oldRecord }) => ({
        oldPublicSHA256: hash(oldRecord),
        newPublicSHA256: hash(change.record),
        reviewReceiptSHA256: '6'.repeat(64),
        mediaReceiptSHA256: '7'.repeat(64),
        ...(change.record ? { imageSHA256: change.record.files.webp.sha256 } : {}),
      }),
      validateSourceTopic: async ({ change, oldRecord }) => ({
        oldRecordSha256: hash(oldRecord),
        newRecordSha256: hash(change.record),
      }),
      refreshViews: m.refreshDiscoveryViews,
    });
  assert.equal(result.fullCatalogPagesBuilt, 0);
  assert.equal(result.fullCatalogScans, 0);
  assert.equal(result.graph.catalogScans, 0);
  for (const d of result.graph.newReachableDescriptors)
    objects.set(d.key, Buffer.from(result.created.get(d.key)));
  context = await testEnvelope(
    result.candidate.indexes,
    result.candidate.revision,
    result.candidate.parentRevision,
  );
  const c = await m.openSevenFacetCollectionContext(bucket, { snapshot: context.snapshot });
  rows.push({
    name,
    seconds: (Date.now() - started) / 1000,
    parentMetadataReads: reads - beforeReads,
    newReachable: result.graph.newReachable,
    metrics: result.metrics,
    artworks: c.global.totals.artworks,
    topics: c.global.totals.subjects,
  });
  console.log(JSON.stringify(rows.at(-1)));
  const pageRoot = await context.getFacet('collections'),
    shellRoot = await context.read('collections', pageRoot.shells),
    publicTopics = await m.readShellField(context, shellRoot, 'topics'),
    hasPrivate = Boolean(await m.readArtwork(context, id));
  assert.equal(
    publicTopics.some((t) => t.slug === source),
    Boolean(await topic(source)),
  );
  const search = await m.openSearch(bucket, context.snapshot.indexes.search),
    searchResult = await search.search({
      q: 'private protocol',
      style: '',
      color: '',
      format: '',
      orientation: '',
      background: '',
      sort: 'relevance',
      page: 1,
      size: 8,
      type: 'artwork',
    });
  assert.equal(
    searchResult.items.some((a) => a.id === id),
    hasPrivate,
  );
  const xml = await m.readSitemap(context, '/sitemap-pages.xml');
  assert.equal(xml.includes('<loc>https://ultraclipart.com/art/' + id + '/</loc>'), hasPrivate);
  const picks = await m.readSurprisePicks(context);
  assert(picks.length > 0);
  const cc = await m.openSevenFacetCollectionContext(bucket, { snapshot: context.snapshot });
  const related = await m.readBoundedRelated(context, hasPrivate ? id : sample.id, {
    hasTopic: async (slug) => Boolean(await cc.lookupCollection(slug)),
    topicFor: async (slug) => {
      const d = await cc.lookupCollection(slug);
      return d ? cc.read(d) : null;
    },
  });
  assert(related && related.version);
  return result;
}
const realBefore = await topic('election-day'),
  editedSample = { ...sample, title: sample.title + ' detail' };
await run(
  'private-real-source-edit',
  [{ id: sample.id, expectedPublicSHA256: hash(sample), record: editedSample }],
  [
    {
      slug: 'election-day',
      expectedRecordSha256: realBefore.d.sha256,
      record: realBefore.record,
      artworkIds: realBefore.ids,
    },
  ],
);
assert.equal((await m.readArtwork(context, sample.id)).title, editedSample.title);
const fresh = {
    ...sample,
    id,
    topic: source,
    title: 'Private protocol ballot example',
    alt: 'Private protocol illustration of a ballot station',
    description:
      'Private transaction fixture using an existing asset; this is not a new approved artwork.',
    createdAt: '2026-11-04T00:00:00Z',
  },
  t = await topic('election-day'),
  newTopic = {
    ...t.record,
    slug: source,
    path: `/clipart/${source}/`,
    canonical: `https://ultraclipart.com/clipart/${source}/`,
    keyword: 'Private protocol clipart',
    title: 'Private protocol test',
    artworkCount: 1,
    coverArtworkId: id,
    related: [],
  };
delete newTopic.membership;
delete newTopic.pageBlocks;
await run(
  'private-append',
  [{ id, expectedPublicSHA256: null, record: fresh }],
  [{ slug: source, expectedRecordSha256: null, record: newTopic, artworkIds: [id] }],
);
assert.equal((await m.readArtwork(context, id)).topic, source);
const updated = { ...fresh, title: 'Private protocol revised ballot example' },
  at = await topic(source);
await run(
  'private-edit',
  [{ id, expectedPublicSHA256: hash(fresh), record: updated }],
  [{ slug: source, expectedRecordSha256: at.d.sha256, record: at.record, artworkIds: [id] }],
);
assert.equal((await m.readArtwork(context, id)).title, updated.title);
const origin = await topic(source),
  target = await topic('election-day'),
  moved = { ...updated, topic: 'election-day' },
  targetIds = [...target.ids, id],
  targetRecord = { ...target.record, artworkCount: targetIds.length, coverArtworkId: targetIds[0] };
await run(
  'private-move',
  [{ id, expectedPublicSHA256: hash(updated), record: moved }],
  [
    { slug: source, expectedRecordSha256: origin.d.sha256, record: null, artworkIds: [] },
    {
      slug: 'election-day',
      expectedRecordSha256: target.d.sha256,
      record: targetRecord,
      artworkIds: targetIds,
    },
  ],
);
assert.equal(await topic(source), null);
const targetAfter = await topic('election-day'),
  finalIds = targetAfter.ids.filter((v) => v !== id);
await run(
  'private-withdraw',
  [{ id, expectedPublicSHA256: hash(moved), record: null }],
  [
    {
      slug: 'election-day',
      expectedRecordSha256: targetAfter.d.sha256,
      record: { ...targetAfter.record, artworkCount: finalIds.length, coverArtworkId: finalIds[0] },
      artworkIds: finalIds,
    },
  ],
);
assert.equal(await m.readArtwork(context, id), undefined);
assert.equal(rows.at(-1).artworks, baseline.artworks);
assert.equal(rows.at(-1).topics, baseline.topics);
const restoreTopic = await topic('election-day');
await run(
  'private-real-source-restore',
  [{ id: sample.id, expectedPublicSHA256: hash(editedSample), record: sample }],
  [
    {
      slug: 'election-day',
      expectedRecordSha256: restoreTopic.d.sha256,
      record: restoreTopic.record,
      artworkIds: restoreTopic.ids,
    },
  ],
);
assert.deepEqual(await m.readArtwork(context, sample.id), sample);
const report = {
  status: 'PRIVATE_FULL_COMPOSITION_ONLY_NOT_PUBLISHED',
  baseline,
  rows,
  realRemoteWrites: 0,
  productionKeysUsed: false,
  fullCatalogPagesBuilt: 0,
  fullCatalogScansPerDelta: 0,
};
writeFileSync(
  'work/catalog-snapshot/delta-testing/full-composition-report.json',
  JSON.stringify(report, null, 2),
);
