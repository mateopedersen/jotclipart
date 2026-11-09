// Source-replayed URL/sitemap migration, with inherited immutable artwork/media.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { loadPresentationSoftware, stagePresentationViews } from './presentation.mjs';
import { buildURLRepair } from './build-url-repair.mjs';
import { captureProductionSnapshot } from '../../server/catalog-snapshot/signed-production-snapshot.mjs';
import { merkle } from '../../scripts/delivery/manifest.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
export const URL_REPAIR_SOURCE_FILES = Object.freeze([
  'data/routes/artwork-public-url-repair-20261109.json',
  'src/lib/artwork-route.mjs',
  'server/catalog-snapshot/public-artwork-routes.mjs',
  'server/catalog-snapshot/sitemap-policy.mjs',
  'server/catalog-snapshot/sitemap-ledger.mjs',
  'server/catalog-snapshot/sitemap-reader.mjs',
  'scripts/catalog-snapshot/build-url-repair.mjs',
  'scripts/catalog-snapshot/prepare-url-repair.mjs',
  'scripts/catalog-snapshot/publish-url-repair.mjs',
  'scripts/catalog-snapshot/presentation.mjs',
  'scripts/catalog-snapshot/test-content-native.mjs',
  'scripts/catalog-snapshot/verify-presentation-live.mjs',
]);
export async function prepareURLRepair({
  packetBytes,
  parentBucket,
  verifier,
  output,
  software,
  progress = () => {},
}) {
  if (!(packetBytes instanceof Uint8Array) || packetBytes.length > 1048576)
    throw Error('Bounded committed presentation packet required');
  const packet = JSON.parse(Buffer.from(packetBytes)),
    head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (
    packet.schema !== 1 ||
    packet.status !== 'SOURCE_DERIVED_URL_REPAIR_BATCH' ||
    !['OWNER_AUTHORIZED_URL_REPAIR', 'PRIVATE_TEST_ONLY'].includes(packet.publicationIntent) ||
    packet.sourceCommit !== head ||
    packet.revision !== head ||
    !/^[a-f0-9]{64}$/.test(packet.parentSnapshotSHA256 ?? '') ||
    !packet.sourceHashes ||
    Object.keys(packet.sourceHashes).length < 1 ||
    Object.keys(packet.sourceHashes).length > 64
  )
    throw Error('Committed presentation source required');
  assert.deepEqual(
    Object.keys(packet.sourceHashes).sort(),
    [...URL_REPAIR_SOURCE_FILES].sort(),
    'Complete committed presentation source hashes required',
  );
  for (const [file, expected] of Object.entries(packet.sourceHashes)) {
    if (
      !/^(?:(?:server|scripts|src)\/[a-z0-9/.-]+\.mjs|data\/routes\/artwork-public-url-repair-20261109\.json)$/.test(
        file,
      ) ||
      file.includes('..')
    )
      throw Error('Unexpected presentation source');
    assert.equal(hash(readFileSync(file)), expected);
    assert.equal(
      hash(execFileSync('git', ['show', head + ':' + file], { maxBuffer: 16 * 1024 * 1024 })),
      expected,
    );
  }
  output = resolve(output);
  if (!output.startsWith(resolve('work') + '/') || existsSync(output))
    throw Error('Separate protected presentation output required');
  const parent = await captureProductionSnapshot(parentBucket, verifier);
  assert.equal(parent.rootSHA256, packet.parentSnapshotSHA256);
  const installed = await loadPresentationSoftware(software, verifier);
  if (!installed) throw Error('Installed presentation renderer contract required');
  if (
    packet.softwareABI !== installed.rendererSHA256 ||
    packet.presentationBundleSHA256 !== installed.bundleSHA256
  )
    throw Error('Presentation packet software changed');
  const source = {
    schema: 1,
    status: 'CURRENT_SOURCE_AND_EDITORIAL_VERIFIED_NOT_A_DEPLOYMENT',
    kind: 'SOURCE_DERIVED_URL_REPAIR',
    sourceCommit: head,
    revision: packet.revision,
    parentSnapshotSHA256: parent.rootSHA256,
    packetSHA256: hash(packetBytes),
    sourceHashes: packet.sourceHashes,
    softwareABI: installed.rendererSHA256,
    presentationBundleSHA256: installed.bundleSHA256,
    changedArtworks: 0,
    changedTopics: 0,
    editorialEvidence: 'Inherited authenticated source; no metadata rewrite or new visual review',
  };
  const sourceBytes = Buffer.from(JSON.stringify(source));
  const result = await buildURLRepair({
    parentContext: parent,
    parentBucket,
    revision: packet.revision,
    plan: JSON.parse(readFileSync('data/routes/artwork-public-url-repair-20261109.json')),
    progress,
    preparePresentation: ({ context, bucket }) => {
      const work = () =>
        stagePresentationViews({ context, bucket, ...installed, allowFixture: true, progress });
      return typeof parentBucket.withoutDiskCacheAdmissions === 'function'
        ? parentBucket.withoutDiskCacheAdmissions(work)
        : work();
    },
  });
  mkdirSync(join(output, 'objects'), { recursive: true });
  const records = [],
    sourceByKey = {};
  for (const d of result.graph.newReachableDescriptors) {
    const body = result.created.get(d.key);
    assert(body && body.length === d.bytes && hash(body) === d.sha256);
    const file = join(output, 'objects', d.sha256 + '.json');
    writeFileSync(file, body, { flag: 'wx' });
    sourceByKey[d.key] = file;
    records.push({
      ...d,
      path: '/catalog-snapshot/' + d.key.slice('catalog/objects/'.length),
      mime: 'application/json',
    });
  }
  records.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = {
    schema: 1,
    status: 'REVIEWED_METADATA_REQUIRES_REMOTE_READBACK',
    revision: packet.revision,
    root: merkle(records).root,
    records,
    sourceByKey,
  };
  const write = (name, value) =>
    writeFileSync(join(output, name), value instanceof Uint8Array ? value : JSON.stringify(value), {
      flag: 'wx',
    });
  write('packet.json', packetBytes);
  write('source-receipt.json', sourceBytes);
  write('parent-snapshot.json', parent.snapshot);
  write('snapshot-candidate.json', result.candidate);
  write('manifest.json', manifest);
  write('prepared-presentation-receipt.json', result.presentationReceipt);
  write('presentation-bridge.json', result.bridge);
  write('media-receipt.json', {
    schema: 1,
    status: 'INHERITED_UNCHANGED_ARTWORK_MEDIA',
    parentSnapshotSHA256: parent.rootSHA256,
    artworkFacetSHA256: parent.snapshot.indexes.artworks.sha256,
    freshMediaRequests: 0,
    mediaBytesChanged: 0,
  });
  write('graph-local-receipt.json', {
    status: 'LOCAL_SOURCE_GRAPH_VERIFIED_REMOTE_READBACK_REQUIRED',
    manifestRoot: manifest.root,
    sourceReceiptSHA256: hash(sourceBytes),
    parentSnapshotSHA256: parent.rootSHA256,
    changedGraph: result.graph,
    metrics: result.metrics,
    bridge: result.bridge,
    preparedDiscoveryDocuments: result.preparedDiscoveryDocuments,
    fullArtworkMetadataScans: 1,
    nativeMediaScans: 0,
    fullCatalogPagesBuilt: 0,
  });
  return { packet, result, manifest, parent, output };
}
