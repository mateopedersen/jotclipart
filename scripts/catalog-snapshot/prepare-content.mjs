// Changed-content composition only. No Astro/templates/full catalog or activation.
import { mkdirSync, writeFileSync, readFileSync, lstatSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildCatalogDelta } from './build-delta.mjs';
import { createReviewedDeltaValidators } from './validate-delta-source.mjs';
import { verifyIncomingMedia } from './batch-media.mjs';
import {
  isIncomingMediaPlan,
  incomingMediaFiles,
  verifyIncomingPlanSources,
  assertIncomingStageReceipt,
} from './incoming-media-plan.mjs';
import { refreshDiscoveryViews } from '../../server/catalog-projections/refresh.mjs';
import { captureProductionSnapshot } from '../../server/catalog-snapshot/signed-production-snapshot.mjs';
import { merkle } from '../delivery/manifest.mjs';
import { verifySourceFile, verifySourceCapsule } from './source-files.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
export async function validateContentPacket(packet) {
  if (
    packet?.schema !== 1 ||
    packet.status !== 'SOURCE_REVIEWED_CONTENT_BATCH' ||
    !/^[a-f0-9]{40}$/.test(packet.revision ?? '') ||
    !/^[a-f0-9]{64}$/.test(packet.parentSnapshotSHA256 ?? '') ||
    !Array.isArray(packet.changes) ||
    packet.changes.length > 256 ||
    !Array.isArray(packet.topicChanges) ||
    !packet.topicChanges.length ||
    packet.topicChanges.length > 64 ||
    !Array.isArray(packet.artworkRows) ||
    packet.artworkRows.length !== packet.changes.length ||
    !Array.isArray(packet.topicRows) ||
    packet.topicRows.length !== packet.topicChanges.length ||
    !Array.isArray(packet.sourceFiles) ||
    packet.sourceFiles.length > 1024
  )
    throw Error('Bounded source-reviewed content packet required');
  verifySourceCapsule(packet);
  const files = new Set();
  for (const f of packet.sourceFiles) {
    const file = await verifySourceFile(f);
    if (files.has(file)) throw Error('Duplicate native source');
    files.add(file);
  }
  await verifyIncomingPlanSources(packet);
  return packet;
}
export async function prepareCatalogContent({
  packetBytes,
  parentBucket,
  verifier,
  output,
  progress = () => {},
  fetcher = fetch,
  mediaStageReceipt = null,
}) {
  if (!(packetBytes instanceof Uint8Array) || packetBytes.length > 32 * 1024 * 1024)
    throw Error('Bounded immutable source packet required');
  output = resolve(output);
  if (!output.startsWith(resolve('work') + '/') || existsSync(output))
    throw Error('Separate protected new batch directory required');
  const packet = await validateContentPacket(JSON.parse(Buffer.from(packetBytes)));
  const plannedMedia =
    isIncomingMediaPlan(packet.incomingMediaManifest) &&
    incomingMediaFiles(packet.incomingMediaManifest).size > 0;
  if (plannedMedia) assertIncomingStageReceipt(packet, mediaStageReceipt, verifier);
  const mediaStageBytes = plannedMedia ? Buffer.from(JSON.stringify(mediaStageReceipt)) : null;
  const parent = await captureProductionSnapshot(parentBucket, verifier);
  if (
    parent.rootSHA256 !== packet.parentSnapshotSHA256 ||
    parent.snapshot.revision === packet.revision
  )
    throw Error('Content predecessor changed');
  if (!(await parent.getFacet('collections')).openingIndex)
    throw Error('Verified opening-index bootstrap required before new content');
  const media = await verifyIncomingMedia(packet.incomingMediaManifest, { fetcher, progress }),
    mediaBytes = Buffer.from(JSON.stringify(media)),
    source = {
      status: 'CURRENT_SOURCE_AND_EDITORIAL_VERIFIED_NOT_A_DEPLOYMENT',
      kind: 'BOUNDED_CONTENT_DELTA',
      sourceCommit: packet.sourceCommit,
      sourceCapsule: packet.sourceCapsule,
      revision: packet.revision,
      parentSnapshotSHA256: parent.rootSHA256,
      packetSHA256: hash(packetBytes),
      mediaReceiptSHA256: hash(mediaBytes),
      ...(plannedMedia ? { incomingMediaStageReceiptSHA256: hash(mediaStageBytes) } : {}),
      changedArtworks: packet.changes.length,
      changedTopics: packet.topicChanges.length,
      sourceHashes: Object.fromEntries(packet.sourceFiles.map((f) => [resolve(f.path), f.sha256])),
    },
    sourceBytes = Buffer.from(JSON.stringify(source)),
    validators = createReviewedDeltaValidators({
      artworkRows: packet.artworkRows,
      topicRows: packet.topicRows,
      incomingMediaManifest: packet.incomingMediaManifest,
      mediaReceiptSHA256: hash(mediaBytes),
      mediaReceipt: media,
    }),
    result = await buildCatalogDelta({
      parentContext: parent,
      parentBucket,
      revision: packet.revision,
      sourceReceiptSHA256: hash(sourceBytes),
      changes: packet.changes,
      topicChanges: packet.topicChanges,
      ...validators,
      refreshViews: refreshDiscoveryViews,
    });
  // Only final reachable new nodes are staged. Intermediate private search roots
  // and untouched predecessor files do not enter the upload manifest.
  mkdirSync(join(output, 'objects'), { recursive: true });
  const records = [],
    sourceByKey = {};
  for (const d of result.graph.newReachableDescriptors) {
    const b = result.created.get(d.key);
    if (!b || b.length !== d.bytes || hash(b) !== d.sha256)
      throw Error('Reachable changed graph differs');
    const file = join(output, 'objects', d.sha256 + '.json');
    writeFileSync(file, b, { flag: 'wx' });
    records.push({
      ...d,
      path: '/catalog-snapshot/' + d.key.slice('catalog/objects/'.length),
      mime: 'application/json',
    });
    sourceByKey[d.key] = file;
  }
  if (!records.length) throw Error('No effective catalog metadata change');
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
        typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value),
        { flag: 'wx' },
      );
  write('packet.json', packetBytes);
  write('parent-snapshot.json', JSON.stringify(parent.snapshot));
  write('snapshot-candidate.json', result.candidate);
  write('manifest.json', manifest);
  write('source-receipt.json', sourceBytes);
  write('media-receipt.json', mediaBytes);
  if (plannedMedia) write('incoming-media-stage-receipt.json', mediaStageBytes);
  write('graph-local-receipt.json', {
    status: 'LOCAL_SOURCE_GRAPH_VERIFIED_REMOTE_READBACK_REQUIRED',
    manifestRoot: manifest.root,
    sourceReceiptSHA256: hash(sourceBytes),
    parentSnapshotSHA256: parent.rootSHA256,
    changedGraph: result.graph,
    metrics: result.metrics,
    fullCatalogPagesBuilt: 0,
    fullCatalogScans: 0,
  });
  progress({
    phase: 'content-delta-prepared-not-live',
    objects: records.length,
    bytes: records.reduce((n, r) => n + r.bytes, 0),
    metrics: result.metrics,
    fullCatalogPagesBuilt: 0,
  });
  return { packet, result, manifest, parent, output };
}
