import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { productionSnapshotMessage } from '../server/catalog-snapshot/signed-production-snapshot.mjs';
import {
  verifyImmutableReadbackAnchor,
  splitImmutableReadbackPlan,
} from '../scripts/catalog-snapshot/reuse-readback.mjs';
import { sha256 } from '../scripts/catalog-snapshot/stage-manifest.mjs';
function fixture() {
  const pair = generateKeyPairSync('ed25519'),
    abiSHA256 = '1'.repeat(64),
    verifier = {
      accountId: 'a'.repeat(32),
      bucketName: 'unit-private-test',
      keyId: 'unit-test-key',
      abiSHA256,
      publicKey: Uint8Array.from(
        Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url'),
      ),
    },
    key = 'catalog/objects/artworks/' + sha256('{}') + '.json',
    record = {
      key,
      path: '/catalog-snapshot/' + key.slice('catalog/objects/'.length),
      bytes: 2,
      sha256: sha256('{}'),
      mime: 'application/json',
    },
    remote = {
      status: 'REMOTE_METADATA_BYTES_SHA_MIME_VERIFIED_NOT_ACTIVATED',
      revision: 'b'.repeat(40),
      root: '2'.repeat(64),
      accountId: verifier.accountId,
      bucket: verifier.bucketName,
      sourceReceiptSHA256: '3'.repeat(64),
      objects: 1,
      bytes: 2,
      files: [{ ...record, etag: 'unit-only-etag' }],
    },
    remoteBytes = Buffer.from(JSON.stringify(remote)),
    graph = {
      status: 'SOURCE_MEDIA_GRAPH_AND_REMOTE_READBACK_VERIFIED',
      revision: remote.revision,
      manifestRoot: remote.root,
      sourceReceiptSHA256: remote.sourceReceiptSHA256,
      mediaReceiptSHA256: '4'.repeat(64),
      softwareABI: abiSHA256,
      remoteReceiptSHA256: sha256(remoteBytes),
      objects: 1,
    },
    graphBytes = Buffer.from(JSON.stringify(graph)),
    snapshot = {
      schema: 1,
      status: 'SOURCE_MEDIA_GRAPH_VERIFIED',
      revision: remote.revision,
      parentRevision: 'c'.repeat(40),
      indexes: Object.fromEntries(
        ['artworks', 'collections', 'search', 'recent', 'related', 'counts', 'sitemaps'].map(
          (f) => [
            f,
            {
              key: `catalog/objects/${f}/${'d'.repeat(64)}.json`,
              bytes: 2,
              sha256: 'd'.repeat(64),
            },
          ],
        ),
      ),
      authorization: {
        policy: 'source-media-graph-ed25519-v1',
        accountId: verifier.accountId,
        bucket: verifier.bucketName,
        keyId: verifier.keyId,
        abiSHA256,
        sourceReceiptSHA256: graph.sourceReceiptSHA256,
        mediaReceiptSHA256: graph.mediaReceiptSHA256,
        graphReceiptSHA256: sha256(graphBytes),
        manifestRoot: graph.manifestRoot,
        parentSnapshotSHA256: '5'.repeat(64),
        issuedAt: Date.now() - 1000,
      },
    };
  snapshot.authorization.signature = sign(
    null,
    productionSnapshotMessage(snapshot),
    pair.privateKey,
  ).toString('hex');
  return {
    snapshotBytes: Buffer.from(JSON.stringify(snapshot)),
    graphBytes,
    remoteBytes,
    verifier,
    record,
  };
}
test('only exact immutable objects from a signed full readback are reusable', async () => {
  const f = fixture(),
    anchor = await verifyImmutableReadbackAnchor(f),
    fresh = {
      ...f.record,
      key: 'catalog/objects/artworks/' + 'f'.repeat(64) + '.json',
      sha256: 'f'.repeat(64),
      path: '/catalog-snapshot/artworks/' + 'f'.repeat(64) + '.json',
    },
    plan = splitImmutableReadbackPlan([f.record, fresh], anchor);
  assert.equal(plan.fresh.length, 1);
  assert.equal(plan.reused.length, 1);
  assert.equal(plan.freshBytes, 2);
  assert.equal(plan.reused[0].anchorSnapshotSHA256, anchor.snapshotSHA256);
  assert.throws(() => splitImmutableReadbackPlan([{ ...f.record, bytes: 3 }], anchor), /changed/);
});
test('tampered remote receipts, graph bytes, scope or signatures never establish reuse', async () => {
  for (const mutate of [
    (f) =>
      (f.remoteBytes = Buffer.from(
        f.remoteBytes.toString().replace('unit-only-etag', 'altered-etag'),
      )),
    (f) => (f.graphBytes = Buffer.from('{}')),
    (f) => (f.verifier = { ...f.verifier, bucketName: 'other-private-test' }),
    (f) => {
      const s = JSON.parse(f.snapshotBytes);
      s.authorization.signature = '0'.repeat(128);
      f.snapshotBytes = Buffer.from(JSON.stringify(s));
    },
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(() => verifyImmutableReadbackAnchor(f));
  }
});
