import {loadPresentationSoftware,stagePresentationViews} from './presentation.mjs';
// Source-replayed prose only; no artwork/media scan, build or publication.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { buildCollectionProseDelta } from './build-collection-prose-delta.mjs';
import { captureProductionSnapshot } from '../../server/catalog-snapshot/signed-production-snapshot.mjs';
import {
  readCollectionRegistries,
  verifyCollectionOpenings,
  collectionParagraphReviewSignature,
} from '../collection-editorial.mjs';
import { bytesOf, digest } from '../../server/catalog-collections/store.mjs';
import { collectionMetaDescription } from '../../src/lib/collection-meta.mjs';
import { merkle } from '../delivery/manifest.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
export async function prepareCollectionProse({ packetBytes, parentBucket, verifier, output, software }) {
  const packet = JSON.parse(Buffer.from(packetBytes));
  if (
    packet.schema !== 1 ||
    packet.status !== 'SOURCE_REVIEWED_COLLECTION_PROSE_BATCH' ||
    packet.revision !== packet.sourceCommit ||
    !Array.isArray(packet.changes) ||
    packet.changes.length > 10000 ||
    packetBytes.length > 32 * 1024 * 1024
  )
    throw Error('Committed bounded prose packet required');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(packet.sourceCommit, head);
  output = resolve(output);
  if (!output.startsWith(resolve('work') + '/') || existsSync(output))
    throw Error('New protected prose output required');
  for (const [file, expected] of Object.entries(packet.sourceHashes)) {
    if (
      !/^(?:data\/editorial\/[a-z0-9-]+\.json|(?:scripts|src\/lib)\/[a-z0-9/.-]+\.mjs|server\/[a-z0-9/.-]+\.mjs)$/.test(
        file,
      ) ||
      file.includes('..')
    )
      throw Error('Unexpected prose source scope');
    assert.equal(hash(readFileSync(file)), expected);
    assert.equal(
      hash(execFileSync('git', ['show', head + ':' + file], { maxBuffer: 16 * 1024 * 1024 })),
      expected,
    );
  }
  const parent = await captureProductionSnapshot(parentBucket, verifier);
  assert.equal(parent.rootSHA256, packet.parentSnapshotSHA256);
  const presentation=software?await loadPresentationSoftware(software,verifier):null;
  if(!presentation&&((await parent.getFacet('collections')).preparedHTML||(await parent.getFacet('collections')).preparedStudio))throw Error('Installed presentation software required for this predecessor');
  const preparePresentation=presentation?async ({context,bucket})=>{
    const work=()=>stagePresentationViews({context,bucket,...presentation,allowFixture:true});
    return typeof parentBucket.withoutDiskCacheAdmissions==='function'?parentBucket.withoutDiskCacheAdmissions(work):work();
  }:undefined;
  const attestation = packet.inventoryAttestation;
  assert.equal(
    attestation.status,
    'ONE_TIME_LOCAL_ACCEPTED_RESOLVER_INVENTORY_ATTESTATION_NOT_NEW_PIXEL_REVIEW',
  );
  assert.equal(attestation.parentSnapshotSHA256, parent.rootSHA256);
  assert.equal(attestation.parentArtworkFacetSHA256, parent.snapshot.indexes.artworks.sha256);
  const inventories = new Map(attestation.rows.map((r) => [r.slug, r.inventorySha256]));
  assert.equal(inventories.size, attestation.rows.length);
  const registry = readCollectionRegistries(),
    source = {
      schema: 1,
      status: 'CURRENT_SOURCE_AND_EDITORIAL_VERIFIED_NOT_A_DEPLOYMENT',
      kind: 'COLLECTION_PROSE_DELTA',
      sourceCommit: head,
      revision: packet.revision,
      parentSnapshotSHA256: parent.rootSHA256,
      packetSHA256: hash(packetBytes),
      inventoryAttestationSHA256: hash(Buffer.from(JSON.stringify(attestation))),
      sourceHashes: packet.sourceHashes,
      ...(presentation?{presentationSoftware:{abiSHA256:presentation.rendererSHA256,bundleSHA256:presentation.bundleSHA256}}:{}),
      openingProof: verifyCollectionOpenings(registry),
      changedTopics: packet.changes.length,
      changedArtworks: 0,
    },
    sourceBytes = Buffer.from(JSON.stringify(source)),
    reviewHash = hash(
      Buffer.from(
        JSON.stringify({
          source: hash(sourceBytes),
          scope:
            'Catalog-grounded prose; preserved original image evidence, not a new visual review',
        }),
      ),
    );
  const result = await buildCollectionProseDelta({
    parentContext: parent,
    parentBucket,
    revision: packet.revision,
    sourceReceiptSHA256: hash(sourceBytes),
    changes: packet.changes,
    preparePresentation,
    validateSourceTopic: async ({ change, oldRecord }) => {
      const r = registry.topics[change.slug];
      assert.deepEqual(change.record.editorial, r);
      assert.equal(r.sourceSha256, oldRecord.editorial.sourceSha256);
      assert.deepEqual(r.evidence, oldRecord.editorial.evidence);
      assert.deepEqual(r.paragraphEvidence, oldRecord.editorial.paragraphEvidence);
      assert.equal(r.paragraphReviewSha256, collectionParagraphReviewSignature(r));
      assert.equal(change.record.summary, r.intro);
      assert.equal(change.record.metaDescription, collectionMetaDescription(r.intro).text);
      assert.deepEqual(change.record.paragraphs, r.paragraphs);
      return {
        oldRecordSha256: change.expectedRecordSha256,
        newRecordSha256: await digest(bytesOf(change.record)),
        reviewReceiptSHA256: reviewHash,
        paragraphInventorySha256: inventories.get(change.slug),
      };
    },
  });
  mkdirSync(join(output, 'objects'), { recursive: true });
  const records = [],
    sourceByKey = {};
  for (const d of result.graph.newReachableDescriptors) {
    const bytes = result.created.get(d.key);
    assert.equal(bytes.length, d.bytes);
    assert.equal(hash(bytes), d.sha256);
    const file = join(output, 'objects', d.sha256 + '.json');
    writeFileSync(file, bytes, { flag: 'wx' });
    records.push({
      ...d,
      path: '/catalog-snapshot/' + d.key.slice('catalog/objects/'.length),
      mime: 'application/json',
    });
    sourceByKey[d.key] = file;
  }
  records.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = {
      schema: 1,
      status: 'REVIEWED_METADATA_REQUIRES_REMOTE_READBACK',
      revision: packet.revision,
      root: merkle(records).root,
      records,
      sourceByKey,
    },
    write = (name, value) =>
      writeFileSync(
        join(output, name),
        value instanceof Uint8Array ? value : JSON.stringify(value),
        { flag: 'wx' },
      );
  if(result.presentationReceipt)write('prepared-presentation-receipt.json',result.presentationReceipt);
  write('packet.json', packetBytes);
  write('source-receipt.json', sourceBytes);
  write('parent-snapshot.json', parent.snapshot);
  write('snapshot-candidate.json', result.candidate);
  write('manifest.json', manifest);
  write('media-receipt.json', {
    schema: 1,
    status: 'INHERITED_UNCHANGED_ARTWORK_MEDIA',
    parentSnapshotSHA256: parent.rootSHA256,
    artworkFacetSHA256: parent.snapshot.indexes.artworks.sha256,
    freshMediaRequests: 0,
  });
  write('graph-local-receipt.json', {
    status: 'LOCAL_SOURCE_GRAPH_VERIFIED_REMOTE_READBACK_REQUIRED',
    manifestRoot: manifest.root,
    sourceReceiptSHA256: hash(sourceBytes),
    parentSnapshotSHA256: parent.rootSHA256,
    changedGraph: result.graph,
    metrics: result.metrics,
    unchangedFacets: result.unchangedFacets,
    artworkEnvelopeRebinding: result.artworkEnvelopeRebinding,
    fullCatalogPagesBuilt: 0,
    fullArtworkScans: 0,
  });
  return { packet, result, manifest, parent, output };
}
