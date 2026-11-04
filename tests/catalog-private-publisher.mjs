import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHmac, createHash } from 'node:crypto';
import { privateSnapshotPublisher } from '../server/catalog-snapshot/private-publish-worker.mjs';
import { productionSnapshotMessage } from '../server/catalog-snapshot/signed-production-snapshot.mjs';
import { snapshotDigest } from '../server/catalog-snapshot/release-pointer.mjs';
const rawHash = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
async function fixture() {
  const pair = generateKeyPairSync('ed25519'),
    verifier = {
      accountId: 'a'.repeat(32),
      bucketName: 'private-local-test',
      keyId: 'private-test',
      abiSHA256: 'b'.repeat(64),
      publicKeyHex: Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url').toString(
        'hex',
      ),
    },
    make = (revision, parentRevision, parentSnapshotSHA256) => {
      const value = {
        schema: 1,
        status: 'SOURCE_MEDIA_GRAPH_VERIFIED',
        revision,
        parentRevision,
        indexes: Object.fromEntries(
          ['artworks', 'collections', 'search', 'recent', 'related', 'counts', 'sitemaps'].map(
            (f) => [
              f,
              {
                key: `catalog/objects/${f}/${'c'.repeat(64)}.json`,
                bytes: 2,
                sha256: 'c'.repeat(64),
              },
            ],
          ),
        ),
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
          parentSnapshotSHA256,
          issuedAt: Date.now() - 1000,
        },
      };
      value.authorization.signature = sign(
        null,
        productionSnapshotMessage(value),
        pair.privateKey,
      ).toString('hex');
      return value;
    },
    parent = make('a'.repeat(40), 'b'.repeat(40), '5'.repeat(64)),
    parentDigest = await snapshotDigest(parent),
    snapshot = make('c'.repeat(40), parent.revision, parentDigest),
    job = {
      mode: 'VERIFIED_CONTENT_DELTA_ACTIVATION',
      secret: 'd'.repeat(64),
      parentSnapshotSHA256: parentDigest,
      snapshotSHA256: rawHash(snapshot),
      snapshot,
      verifier,
    };
  let value = structuredClone(parent),
    puts = 0,
    collision = false;
  const bucket = {
      get: async () => ({
        size: JSON.stringify(value).length,
        etag: rawHash(value),
        httpMetadata: { contentType: 'application/json' },
        json: async () => structuredClone(value),
        arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(value)).buffer,
      }),
      put: async (key, bytes, options) => {
        assert.equal(key, 'catalog/active.json');
        assert.equal(options.onlyIf.etagMatches, rawHash(value));
        puts++;
        if (collision) return null;
        value = JSON.parse(new TextDecoder().decode(bytes));
        return { etag: rawHash(value) };
      },
    },
    request = (extra = {}, wrong = false) => {
      const command = {
          action: 'activate-verified-catalog-delta',
          snapshotSHA256: job.snapshotSHA256,
          parentSnapshotSHA256: job.parentSnapshotSHA256,
          accountId: verifier.accountId,
          bucket: verifier.bucketName,
          at: Date.now() - 1000,
          ...extra,
        },
        signature = wrong
          ? '0'.repeat(64)
          : createHmac('sha256', Buffer.from(job.secret, 'hex'))
              .update(JSON.stringify(command))
              .digest('hex');
      return new Request('http://private.invalid/activate', {
        method: 'POST',
        body: JSON.stringify({ command, signature }),
      });
    };
  return {
    job,
    worker: privateSnapshotPublisher(job),
    bucket,
    request,
    puts: () => puts,
    collision: () => (collision = true),
    changeParent: () => (value = make('d'.repeat(40), 'e'.repeat(40), 'f'.repeat(64))),
  };
}
test('content-only atomic activation preserves parent and rejects unauthenticated or stale scope', async () => {
  const f = await fixture();
  assert.equal(
    (await f.worker.fetch(f.request({ at: Date.now() - 46000 }), { TARGET: f.bucket })).status,
    409,
  );
  assert.equal((await f.worker.fetch(f.request({}, true), { TARGET: f.bucket })).status, 403);
  assert.equal(f.puts(), 0);
  const r = await f.worker.fetch(f.request(), { TARGET: f.bucket });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'VERIFIED_CONTENT_DELTA_POINTER_ACTIVE');
  assert.equal(f.puts(), 1);
  assert.equal((await f.worker.fetch(f.request(), { TARGET: f.bucket })).status, 200);
  assert.equal(f.puts(), 1);
});
test('concurrent predecessor and failed conditional swap cannot report a successful publication', async () => {
  const f = await fixture();
  f.changeParent();
  assert.equal((await f.worker.fetch(f.request(), { TARGET: f.bucket })).status, 409);
  assert.equal(f.puts(), 0);
  const g = await fixture();
  g.collision();
  assert.equal((await g.worker.fetch(g.request(), { TARGET: g.bucket })).status, 409);
  assert.equal(g.puts(), 1);
});
