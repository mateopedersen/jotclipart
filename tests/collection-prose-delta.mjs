// Private in-memory protocol fixtures, never production source or authority evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCollectionProseDelta } from '../scripts/catalog-snapshot/build-collection-prose-delta.mjs';
import { facetStore, bytesOf, digest, emitDirectory, lookupTopic } from '../server/catalog-collections/store.mjs';
import { snapshotDigest } from '../server/catalog-snapshot/release-pointer.mjs';

async function fixture() {
  const objects = new Map(), calls = [];
  const bucket = { async get(key) { calls.push(key); const b = objects.get(key);
    return b ? { size: b.length, arrayBuffer: async () => new Uint8Array(b).buffer } : null; },
  async put(key, bytes) { objects.set(key, new Uint8Array(bytes)); return { etag: 'private fixture' }; } };
  const store = facetStore(bucket, { writable: true });
  const originals = new Map(), directory = [];
  for (const [slug, opening] of [['apple', 'Round fruit takes centre stage in these apple drawings.'],
      ['pear', 'Soft green pear shapes give these compositions their character.'],
      ['kite', 'Long tails and diamond shaped sails fill this kite collection.']]) {
    const summary = opening, paragraphs = [opening, 'The collection includes {{artworkCount}} illustrations with several different compositions.'];
    // Membership/page blocks deliberately refer to absent objects: a prose edit must never read them.
    const missing = { key: 'catalog/objects/collections/' + 'f'.repeat(64) + '.json', sha256: 'f'.repeat(64), bytes: 123 };
    const record = { schema: 1, type: 'collection-topic-references', slug, keyword: slug + ' clipart', title: slug + ' Clipart',
      path: `/clipart/${slug}/`, canonical: `https://ultraclipart.com/clipart/${slug}/`, summary, metaDescription: summary,
      primaryCluster: 'Nature', sourceCluster: 'Nature', clusters: [{ name: 'Nature', path: '/collection/nature/' }],
      paragraphs, editorial: { intro: summary, paragraphs, sourceSha256: '1'.repeat(64) },
      artworkCount: 1, coverArtworkId: slug + '-one', membership: [missing], pageBlocks: [missing], related: [] };
    originals.set(slug, record); directory.push({ slug, path: record.path, artworkCount: 1, ...await store.put('collections', record) });
  }
  const c = await store.put('collections', { type: 'collection-directory', viewProtocol: 'collection-references-v2',
    topicCount: 3, artworkCount: 3, directory: await emitDirectory(store, directory, 'collection') });
  const indexes = { collections: c };
  for (const facet of ['artworks','search','recent','related','counts','sitemaps']) {
    const bytes = bytesOf({ schema: 1, type: 'explicit-private-unread-facet' }), sha256 = await digest(bytes);
    const key = `catalog/objects/${facet}/${sha256}.json`; objects.set(key, bytes); indexes[facet] = { key, sha256, bytes: bytes.length };
  }
  const snapshot = { schema: 1, revision: 'a'.repeat(40), parentRevision: 'b'.repeat(40),
    status: 'SOURCE_MEDIA_GRAPH_VERIFIED', indexes };
  const parentContext = { snapshot, rootSHA256: await snapshotDigest(snapshot), authorizationVerified: true };
  const makeChange = async (slug, opening) => {
    const old = originals.get(slug), record = { ...old, summary: opening, metaDescription: opening,
      paragraphs: [opening, old.paragraphs[1]], editorial: { ...old.editorial, intro: opening, paragraphs: [opening, old.paragraphs[1]] } };
    return { slug, expectedRecordSha256: (await lookupTopic(store, (await store.read('collections', c)).directory, 'collection', slug)).sha256, record };
  };
  const proof = async ({ change }) => ({ oldRecordSha256: change.expectedRecordSha256,
    newRecordSha256: await digest(bytesOf(change.record)), reviewReceiptSHA256: '2'.repeat(64) });
  const args = { parentContext, parentBucket: bucket, revision: 'c'.repeat(40), sourceReceiptSHA256: '3'.repeat(64), validateSourceTopic: proof };
  calls.length = 0; return { objects, bucket, calls, store, originals, makeChange, args };
}
test('prose composition preserves all six other facets and never reads membership, artwork or active pointer', async () => {
  const f = await fixture(), change = await f.makeChange('apple', 'Apple branches, fruit and simple arrangements provide several starting points.');
  f.calls.length = 0;
  const result = await buildCollectionProseDelta({ ...f.args, changes: [change] });
  assert.equal(result.publicationVerified, false); assert.equal(result.candidate.fixture, true);
  for (const facet of result.unchangedFacets) assert.deepEqual(result.candidate.indexes[facet], f.args.parentContext.snapshot.indexes[facet]);
  assert.equal(result.metrics.topicRecordsRead, 3); assert.equal(result.fullArtworkScans, 0); assert.equal(result.fullCatalogPagesBuilt, 0);
  assert(f.calls.every(key => key.startsWith('catalog/objects/collections/')));
  assert(!f.calls.some(key => key.includes('f'.repeat(64))));
  const bytes = result.created.get(result.changed[0].afterDescriptor.key), value = JSON.parse(new TextDecoder().decode(bytes));
  assert.deepEqual(value.membership, change.record.membership); assert.deepEqual(value.pageBlocks, change.record.pageBlocks);
});
test('an existing opening index avoids reading unchanged topic records', async () => {
  const f = await fixture(), first = await buildCollectionProseDelta({ ...f.args,
    changes: [await f.makeChange('apple', 'Apple branches and fruit provide a bright focal point for these compositions.')] });
  for (const [key, bytes] of first.created) f.objects.set(key, bytes);
  const snapshot = { ...first.candidate, fixture: false, status: 'SOURCE_MEDIA_GRAPH_VERIFIED' };
  const parentContext = { snapshot, rootSHA256: await snapshotDigest(snapshot), authorizationVerified: true };
  const change = await f.makeChange('pear', 'Pear branches and whole fruit bring gentle shapes to this set.');
  f.calls.length = 0;
  const second = await buildCollectionProseDelta({ ...f.args, parentContext, revision: 'd'.repeat(40), changes: [change] });
  assert.equal(second.metrics.topicRecordsRead, 1); assert.equal(second.metrics.openingIndexBootstrapped, false);
});
test('protected field edits and stale descriptors fail before any staging', async () => {
  for (const key of ['title','artworkCount','coverArtworkId','membership','pageBlocks','related']) {
    const f = await fixture(), c = await f.makeChange('apple', 'Apple shapes appear across varied fruit themed arrangements and decorative scenes.');
    c.record[key] = key === 'artworkCount' ? 2 : 'unapproved change';
    await assert.rejects(buildCollectionProseDelta({ ...f.args, changes: [c] }), /protected/);
  }
  const f = await fixture(), c = await f.makeChange('apple', 'Apple shapes appear across varied fruit themed arrangements and decorative scenes.');
  c.expectedRecordSha256 = '0'.repeat(64);
  await assert.rejects(buildCollectionProseDelta({ ...f.args, changes: [c] }), /Stale/);
});
test('source review must bind the exact old and new record', async () => {
  const f = await fixture(), c = await f.makeChange('apple', 'Apple shapes appear across varied fruit themed arrangements and decorative scenes.');
  await assert.rejects(buildCollectionProseDelta({ ...f.args, changes: [c], validateSourceTopic: async () => ({}) }), /not bound/);
});
test('duplicate openings against unchanged topics and subject substitutions are rejected', async () => {
  const f = await fixture();
  await assert.rejects(buildCollectionProseDelta({ ...f.args, changes: [await f.makeChange('apple', f.originals.get('pear').summary)] }), /Repeated/);
  const a = await f.makeChange('apple', 'Apple drawings suit many different creative arrangements and decorative projects.');
  const b = await f.makeChange('pear', 'Pear drawings suit many different creative arrangements and decorative projects.');
  await assert.rejects(buildCollectionProseDelta({ ...f.args, changes: [a, b] }), /Repeated/);
});
test('generic welcome, count openings and prose dashes cannot enter future batches', async () => {
  for (const text of ['Welcome to our apple collection with several different examples.',
    'Choose from {{artworkCount}} illustrations of this familiar fruit.', 'Blue-and-gold apple shapes appear across several compositions.']) {
    const f = await fixture(), c = await f.makeChange('apple', text);
    await assert.rejects(buildCollectionProseDelta({ ...f.args, changes: [c] }));
  }
});
test('private unauthenticated or mismatched parents cannot compose a publishable delta', async () => {
  const f = await fixture(), changes = [await f.makeChange('apple', 'Fresh apples and fruit arrangements give this set a familiar starting point.')];
  await assert.rejects(buildCollectionProseDelta({ ...f.args, parentContext: { ...f.args.parentContext, authorizationVerified: false }, changes }), /Authenticated/);
  await assert.rejects(buildCollectionProseDelta({ ...f.args, parentContext: { ...f.args.parentContext, rootSHA256: '0'.repeat(64) }, changes }), /parent differs/);
});
