// Independent, source-replayed authority issuer. Staging alone is never approval.
import { readFileSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import assert from 'node:assert/strict';
import { prepareCatalogContent } from './prepare-content.mjs';
import { validateMetadataManifest, readMetadataBytes } from './stage-manifest.mjs';
import {
  captureProductionSnapshot,
  productionSnapshotMessage,
} from '../../server/catalog-snapshot/signed-production-snapshot.mjs';
import { snapshotDigest } from '../../server/catalog-snapshot/release-pointer.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
export async function sealCatalogContent({
  directory,
  parentBucket,
  verifier,
  software,
  replay = prepareCatalogContent,
}) {
  const read = (n) => JSON.parse(readFileSync(join(directory, n))),
    packetBytes = readFileSync(join(directory, 'packet.json')),
    sourceBytes = readFileSync(join(directory, 'source-receipt.json')),
    source = JSON.parse(sourceBytes),
    candidate = read('snapshot-candidate.json'),
    manifest = validateMetadataManifest(read('manifest.json')),
    remote = read('remote-receipt.json'),
    native = read('native-integration-report.json'),
    code = JSON.parse(readFileSync(join(software, 'runtime/software-report.json')));
  assert.equal(source.status, 'CURRENT_SOURCE_AND_EDITORIAL_VERIFIED_NOT_A_DEPLOYMENT');
  assert.equal(source.packetSHA256, hash(packetBytes));
  assert.equal(hash(readFileSync(join(software, 'runtime/worker.mjs'))), code.workerSHA256);
  assert.equal(code.abiSHA256, verifier.abiSHA256);
  assert.equal(code.publicKeyHex, verifier.publicKeyHex);
  const parent = await captureProductionSnapshot(parentBucket, verifier);
  assert.equal(parent.rootSHA256, source.parentSnapshotSHA256);
  assert.equal(candidate.parentRevision, parent.snapshot.revision);
  assert.equal(candidate.revision, manifest.revision);
  const replayDirectory = join(directory, 'independent-replay');
  if (existsSync(replayDirectory)) throw Error('Independent replay must start clean');
  try {
    const repeated = await replay({ packetBytes, parentBucket, verifier, output: replayDirectory });
    assert.deepEqual(
      repeated.result.candidate,
      candidate,
      'Independent source/graph replay differs',
    );
    assert.equal(
      hash(readFileSync(join(replayDirectory, 'source-receipt.json'))),
      hash(sourceBytes),
    );
    assert.equal(repeated.manifest.root, manifest.root);
    assert.deepEqual(repeated.manifest.records, manifest.records);
    for (const r of manifest.records)
      assert.equal(
        hash(readMetadataBytes(manifest, r)),
        hash(readMetadataBytes(repeated.manifest, r)),
      );
  } finally {
    rmSync(replayDirectory, { recursive: true, force: true });
  }
  assert.equal(remote.status, 'REMOTE_METADATA_BYTES_SHA_MIME_VERIFIED_NOT_ACTIVATED');
  assert.equal(remote.root, manifest.root);
  assert.equal(remote.revision, manifest.revision);
  assert.equal(remote.accountId, verifier.accountId);
  assert.equal(remote.bucket, verifier.bucketName);
  assert.equal(remote.sourceReceiptSHA256, hash(sourceBytes));
  assert.equal(remote.objects, manifest.records.length);
  const verified = new Map(remote.files.map((r) => [r.key, r]));
  assert.equal(verified.size, manifest.records.length);
  for (const r of manifest.records) {
    const a = verified.get(r.key);
    for (const k of ['key', 'path', 'bytes', 'sha256']) assert.equal(a?.[k], r[k]);
    assert(a.etag);
  }
  assert.equal(native.status, 'CHANGED_CONTENT_NATIVE_ROUTES_VERIFIED_NOT_PUBLISHED');
  assert.equal(native.candidateSHA256, hash(Buffer.from(JSON.stringify(candidate))));
  assert.equal(native.packetSHA256, hash(Buffer.from(JSON.stringify(JSON.parse(packetBytes)))));
  assert.equal(native.softwareABI, code.abiSHA256);
  assert.equal(native.productionWrites, 0);
  const graph = {
      schema: 1,
      status: 'SOURCE_MEDIA_GRAPH_AND_REMOTE_READBACK_VERIFIED',
      kind: source.kind,
      revision: candidate.revision,
      parentSnapshotSHA256: parent.rootSHA256,
      manifestRoot: manifest.root,
      objects: manifest.records.length,
      sourceReceiptSHA256: hash(sourceBytes),
      mediaReceiptSHA256: hash(readFileSync(join(directory, 'media-receipt.json'))),
      remoteReceiptSHA256: hash(readFileSync(join(directory, 'remote-receipt.json'))),
      nativeIntegrationSHA256: hash(
        readFileSync(join(directory, 'native-integration-report.json')),
      ),
      softwareABI: code.abiSHA256,
      fullCatalogPagesBuilt: 0,
      fullCatalogScans: 0,
      at: new Date().toISOString(),
    },
    graphBytes = Buffer.from(JSON.stringify(graph));
  const keyPath = join(
    homedir(),
    'Library/Application Support/UltraClipart/private-publisher/catalog-signing-v1.pem',
  );
  if ((statSync(keyPath).mode & 0o077) !== 0) throw Error('Private key permissions required');
  const key = createPrivateKey(readFileSync(keyPath));
  assert.equal(
    Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x, 'base64url').toString('hex'),
    verifier.publicKeyHex,
  );
  const production = {
    schema: 1,
    status: 'SOURCE_MEDIA_GRAPH_VERIFIED',
    revision: candidate.revision,
    parentRevision: candidate.parentRevision,
    indexes: structuredClone(candidate.indexes),
    authorization: {
      policy: 'source-media-graph-ed25519-v1',
      accountId: verifier.accountId,
      bucket: verifier.bucketName,
      keyId: verifier.keyId,
      abiSHA256: code.abiSHA256,
      sourceReceiptSHA256: graph.sourceReceiptSHA256,
      mediaReceiptSHA256: graph.mediaReceiptSHA256,
      graphReceiptSHA256: hash(graphBytes),
      manifestRoot: manifest.root,
      parentSnapshotSHA256: parent.rootSHA256,
      issuedAt: Date.now() - 1000,
    },
  };
  production.authorization.signature = sign(
    null,
    productionSnapshotMessage(production),
    key,
  ).toString('hex');
  const bytes = Buffer.from(JSON.stringify(production));
  await captureProductionSnapshot(
    { get: async () => ({ size: bytes.length, json: async () => JSON.parse(bytes) }) },
    verifier,
  );
  for (const name of ['production-snapshot.json', 'graph-verified-receipt.json'])
    if (existsSync(join(directory, name)))
      throw Error('Refusing to reseal an existing production envelope');
  writeFileSync(join(directory, 'graph-verified-receipt.json'), graphBytes, { flag: 'wx' });
  writeFileSync(join(directory, 'production-snapshot.json'), bytes, { flag: 'wx' });
  return {
    snapshot: production,
    snapshotSHA256: hash(bytes),
    verifiedRoot: await snapshotDigest(production),
    graph,
  };
}
