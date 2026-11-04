// Publisher-only prose changes. Never builds pages, reads artwork or activates a root.
import { createDeltaStore } from './delta-store.mjs';
import { openSnapshot } from '../../server/catalog-snapshot/snapshot-context.mjs';
import { facetStore, canonical, bytesOf, digest, emitDirectory, patchTopic, slugOK } from '../../server/catalog-collections/store.mjs';
import { validateTopicIdentity } from '../../server/catalog-collections/writer.mjs';
import { collectionOpening, collectionIntroductionTemplate, verifyCollectionOpenings } from '../collection-editorial.mjs';

const hex = /^[a-f0-9]{64}$/, allowed = new Set(['summary', 'metaDescription', 'paragraphs', 'editorial']);
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const protectedFields = r => Object.fromEntries(Object.entries(r).filter(([k]) => !allowed.has(k)));
const fingerprint = async (slug, record) => {
  const opening = collectionOpening(record.paragraphs?.[0] ?? '');
  return { slug, exact: await digest(opening.normalize('NFKC').toLowerCase()),
    template: await digest(collectionIntroductionTemplate(slug, opening)) };
};
function checkProse(slug, record) {
  validateTopicIdentity(record, slug);
  verifyCollectionOpenings({ topics: { [slug]: record.editorial } });
  if ([record.summary, record.metaDescription, ...record.paragraphs].some(t => /[\u2010-\u2015-]/.test(t)))
    throw Error('Collection prose must not contain hyphens or dash punctuation');
}
async function entries(store, descriptor, prefix = '') {
  const node = await store.read('collections', descriptor);
  if (node.kind !== 'collection' || node.prefix !== prefix) throw Error('Wrong prose directory context');
  if (node.type === 'hashed-topic-leaf') {
    if (!Array.isArray(node.entries) || node.entries.length > 4096) throw Error('Invalid prose directory leaf');
    for (const row of node.entries)
      if (!slugOK(row.slug) || !(await digest(row.slug)).startsWith(prefix)) throw Error('Wrong prose directory partition');
    return node.entries;
  }
  if (node.type !== 'hashed-topic-branch' || !node.children || Object.keys(node.children).length > 16)
    throw Error('Invalid prose directory branch');
  const rows = [];
  for (const [key, child] of Object.entries(node.children)) {
    if (!/^[a-f0-9]+$/.test(key) || !key.startsWith(prefix) || key.length !== prefix.length + 1)
      throw Error('Invalid prose directory path');
    rows.push(...await entries(store, child, key));
    if (rows.length > 10000) throw Error('Topic opening directory budget exceeded');
  }
  return rows;
}
export async function buildCollectionProseDelta({
  parentContext, parentBucket, revision, sourceReceiptSHA256, changes, validateSourceTopic, preparePresentation,
}) {
  if (!/^[a-f0-9]{40}$/.test(revision ?? '') || revision === parentContext?.snapshot?.revision ||
      !hex.test(sourceReceiptSHA256 ?? '') || !Array.isArray(changes) || !changes.length || changes.length > 10000 ||
      new Set(changes.map(c => c.slug)).size !== changes.length || typeof validateSourceTopic !== 'function')
    throw Error('Bounded source reviewed prose delta required');
  const overlay = createDeltaStore(parentBucket, parentContext, preparePresentation ? {maxBytes:256*1024*1024} : {});
  const base = await openSnapshot(overlay.bucket, { provided: parentContext.snapshot });
  if (base.rootSHA256 !== parentContext.rootSHA256) throw Error('Authenticated prose parent differs');
  const store = facetStore(overlay.bucket, { writable: true, maxReads: 20000, maxBytes: 128 * 1024 * 1024 });
  const collections = await store.read('collections', base.snapshot.indexes.collections);
  if (collections.type !== 'collection-directory' || collections.viewProtocol !== 'collection-references-v2' ||
      !Number.isSafeInteger(collections.topicCount) || collections.topicCount < 1 || collections.topicCount > 10000)
    throw Error('Source-bound reference collections required');
  // ART roots use their own envelope format (the accepted root has no schema
  // field); do not route them through the schema-1 collection store.
  const artworkRoot = await base.getFacet('artworks');
  const discovery = await store.read('collections', collections.discoveryProjection);
  const surprise = await store.read('collections', collections.surprise);
  if (artworkRoot.type !== 'artwork-root' || artworkRoot.revision !== base.snapshot.revision ||
      !artworkRoot.directories || discovery.type !== 'discovery-projection-ledger-v1' ||
      discovery.artworkRootSHA256 !== base.snapshot.indexes.artworks.sha256 ||
      surprise.type !== 'cute-discovery-projection' || surprise.version !== 3 ||
      surprise.artworksRootSHA256 !== base.snapshot.indexes.artworks.sha256)
    throw Error('Prose predecessor dependent artwork roots differ');
  const directory = await entries(store, collections.directory);
  const bySlug = new Map(directory.map(d => [d.slug, d]));
  if (bySlug.size !== collections.topicCount || directory.length !== bySlug.size) throw Error('Incomplete prose topic directory');
  const openingRows = collections.openingIndex ? await entries(store, collections.openingIndex) : [];
  const openings = new Map(openingRows.map(r => [r.slug, r]));
  if (collections.openingIndex && (openings.size !== bySlug.size || openingRows.length !== bySlug.size ||
      openingRows.some(r => !bySlug.has(r.slug) || !hex.test(r.exact ?? '') || !hex.test(r.template ?? '') ||
        (r.inventory !== undefined && !hex.test(r.inventory)))))
    throw Error('Incomplete source-bound opening index');
  const oldRecords = new Map(), plans = [];
  const readTopic = async slug => {
    if (!oldRecords.has(slug)) oldRecords.set(slug, await store.read('collections', bySlug.get(slug)));
    return oldRecords.get(slug);
  };
  if (!collections.openingIndex)
    for (const slug of bySlug.keys()) openings.set(slug, await fingerprint(slug, await readTopic(slug)));
  // Validate the whole batch before staging any local object.
  for (const change of changes) {
    const prior = bySlug.get(change.slug);
    if (!prior || change.expectedRecordSha256 !== prior.sha256) throw Error('Stale or absent prose topic');
    const oldRecord = await readTopic(change.slug), record = change.record;
    if (!record || !same(protectedFields(oldRecord), protectedFields(record)) ||
        oldRecord.editorial?.sourceSha256 !== record.editorial?.sourceSha256)
      throw Error('Prose delta changed a protected identity, membership, source or count');
    checkProse(change.slug, record);
    const priorOpening = openings.get(change.slug);
    if (collections.openingIndex && !same({ slug: priorOpening.slug, exact: priorOpening.exact, template: priorOpening.template }, await fingerprint(change.slug, oldRecord)))
      throw Error('Opening index differs from its source topic');
    const newRecordSha256 = await digest(bytesOf(record));
    const proof = await validateSourceTopic({ change, oldRecord });
    if (proof?.oldRecordSha256 !== prior.sha256 || proof.newRecordSha256 !== newRecordSha256 ||
        !hex.test(proof.reviewReceiptSHA256 ?? '') || !hex.test(proof.paragraphInventorySha256 ?? ''))
      throw Error('Prose source review is not bound to the exact record');
    // Resolved and raw-source inventory signatures may differ. Bind the resolved
    // signature to the signed predecessor before using it with the new summary.
    const inventory = proof.paragraphInventorySha256;
    if (oldRecord.editorial.paragraphSourceSha256 !== await digest(JSON.stringify([inventory, oldRecord.summary])) ||
        record.editorial.paragraphSourceSha256 !== await digest(JSON.stringify([inventory, record.summary])) ||
        (priorOpening.inventory && priorOpening.inventory !== inventory))
      throw Error('Paragraph inventory differs from the authenticated predecessor');
    plans.push({ change, prior, record, proof });
    openings.set(change.slug, { ...await fingerprint(change.slug, record), inventory });
  }
  const exact = new Set(), templates = new Set();
  for (const row of openings.values()) {
    if (exact.has(row.exact) || templates.has(row.template)) throw Error('Repeated exact or subject substituted collection opening');
    exact.add(row.exact); templates.add(row.template);
  }
  let nextDirectory = collections.directory;
  const changed = [];
  for (const { change, prior, record } of plans) {
    const descriptor = await store.put('collections', record);
    const next = { ...prior, ...descriptor };
    nextDirectory = await patchTopic(store, nextDirectory, 'collection', change.slug, next);
    changed.push({ slug: change.slug, beforeDescriptor: prior, afterDescriptor: next });
  }
  const openingIndex = await emitDirectory(store, [...openings.values()], 'collection');
  // The reader requires the ART envelope revision to match the new snapshot.
  // Rebind only this small envelope and its two dependent roots; all directories,
  // artwork leaves, discovery facts, choices and ledgers remain byte-identical.
  const artworkBytes = bytesOf({ ...artworkRoot, revision }), artworkSHA256 = await digest(artworkBytes);
  const artworks = { key: `catalog/objects/artworks/${artworkSHA256}.json`, sha256: artworkSHA256, bytes: artworkBytes.length };
  await overlay.bucket.put(artworks.key, artworkBytes);
  const discoveryProjection = await store.put('collections', { ...discovery, artworkRootSHA256: artworks.sha256 });
  const picks = await store.put('collections', { ...surprise, artworksRootSHA256: artworks.sha256 });
  const indexes = { ...base.snapshot.indexes, artworks, collections: await store.put('collections', {
    ...collections, directory: nextDirectory, openingIndex, discoveryProjection, surprise: picks,
  }) };
  const candidate = { schema: 1, fixture: true, status: 'PRIVATE_UNPUBLISHABLE', revision,
    parentRevision: base.snapshot.revision, indexes };
  let presentationReceipt;
  if(preparePresentation){const context=await openSnapshot(overlay.bucket,{provided:candidate,allowFixture:true,maxReadObjects:20000,maxReadBytes:256*1024*1024});
    const prepared=await preparePresentation({context,bucket:overlay.bucket});if(!prepared?.collections||!prepared?.receipt)throw Error('Canonical presentation stage missing');
    indexes.collections=prepared.collections;presentationReceipt=prepared.receipt;}
  const graph = overlay.verifyChangedClosure(indexes);
  return { status: 'PRIVATE_PROSE_DELTA_REQUIRES_SOURCE_GRAPH_NATIVE_AND_REMOTE_APPROVAL',
    candidate, created: overlay.created, changed, graph, sourceReceiptSHA256, ...(presentationReceipt?{presentationReceipt}:{}),
    parentSnapshotSHA256: parentContext.rootSHA256, fullCatalogPagesBuilt: 0, fullArtworkScans: presentationReceipt ? 1 : 0, preparedDiscoveryDocuments: presentationReceipt?.canonicalDocumentsPrepared ?? 0, nativeMediaScans: 0,
    metrics: { ...overlay.metrics(), topicRecordsRead: oldRecords.size,
      openingIndexBootstrapped: !collections.openingIndex, openingFingerprints: openings.size },
    artworkEnvelopeRebinding: { before: base.snapshot.indexes.artworks, after: artworks,
      directoriesUnchanged: true, artworkLeavesRead: 0 },
    unchangedFacets: Object.keys(indexes).filter(k => !['collections', 'artworks'].includes(k)), publicationVerified: false };
}
