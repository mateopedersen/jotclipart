// Isolated protocol fixtures only. No remote service or production data is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHmac, createHash } from 'node:crypto';
import { privateCatalogReader } from '../server/catalog-snapshot/private-read-worker.mjs';
import { remoteCatalogBucket } from '../scripts/catalog-snapshot/remote-reader.mjs';
import { productionSnapshotMessage } from '../server/catalog-snapshot/signed-production-snapshot.mjs';
import { snapshotDigest } from '../server/catalog-snapshot/release-pointer.mjs';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const oldKey = 'catalog/active.json',
  newKey = 'catalog/jotclipart/active.json';
async function fixture(activeKey) {
  const pair = generateKeyPairSync('ed25519');
  const verifier = {
    accountId: 'a'.repeat(32),
    bucketName: 'private-reader-fixture',
    keyId: 'private-reader',
    abiSHA256: 'b'.repeat(64),
    publicKeyHex: Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url').toString(
      'hex',
    ),
    ...(activeKey === undefined ? {} : { activeKey }),
  };
  const metadata = Buffer.from(JSON.stringify({ privateFixture: true })),
    digest = hash(metadata);
  const snapshot = {
    schema: 1,
    status: 'SOURCE_MEDIA_GRAPH_VERIFIED',
    revision: 'c'.repeat(40),
    parentRevision: 'd'.repeat(40),
    indexes: Object.fromEntries(
      ['artworks', 'collections', 'search', 'recent', 'related', 'counts', 'sitemaps'].map(
        (facet) => [
          facet,
          {
            key: `catalog/objects/${facet}/${digest}.json`,
            sha256: digest,
            bytes: metadata.length,
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
      parentSnapshotSHA256: '5'.repeat(64),
      issuedAt: Date.now() - 1000,
    },
  };
  snapshot.authorization.signature = sign(
    null,
    productionSnapshotMessage(snapshot),
    pair.privateKey,
  ).toString('hex');
  const pointerBytes = Buffer.from(JSON.stringify(snapshot));
  const metadataKey = snapshot.indexes.counts.key;
  const values = new Map([
    [oldKey, pointerBytes],
    [newKey, pointerBytes],
    [metadataKey, metadata],
  ]);
  const reads = [];
  const bucket = {
    get: async (key) => {
      reads.push(key);
      const bytes = values.get(key);
      if (!bytes) return null;
      return {
        size: bytes.length,
        etag: hash(bytes),
        json: async () => JSON.parse(bytes),
        arrayBuffer: async () => bytes,
      };
    },
  };
  const job = {
    mode: 'PINNED_CATALOG_READ_ONLY',
    secret: 'e'.repeat(64),
    parentSnapshotSHA256: await snapshotDigest(snapshot),
    verifier,
  };
  const request = (extra = {}, omitNamespace = false) => {
    const command = {
      action: 'read-pinned-catalog-metadata',
      parentSnapshotSHA256: job.parentSnapshotSHA256,
      accountId: verifier.accountId,
      bucket: verifier.bucketName,
      at: Date.now() - 1000,
      keys: [activeKey ?? oldKey, metadataKey],
      ...(activeKey !== undefined && !omitNamespace ? { pointerKey: activeKey } : {}),
      ...extra,
    };
    const signature = createHmac('sha256', Buffer.from(job.secret, 'hex'))
      .update(JSON.stringify(command))
      .digest('hex');
    return new Request('http://private.invalid/read', {
      method: 'POST',
      body: JSON.stringify({ command, signature }),
    });
  };
  return {
    job,
    request,
    values,
    reads,
    bucket,
    metadataKey,
    pointerBytes,
    worker: privateCatalogReader(job),
  };
}
test('legacy reader preserves its default command, response and selected pointer behavior', async () => {
  const f = await fixture();
  const response = await f.worker.fetch(f.request(), { TARGET: f.bucket });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(Object.keys(result), ['parentSnapshotSHA256', 'objects']);
  assert.deepEqual(
    result.objects.map((r) => r.key),
    [oldKey, f.metadataKey],
  );
  assert(!f.reads.includes(newKey));
});
test('new reader authenticates its exact namespace even when both pointer bodies are identical', async () => {
  const f = await fixture(newKey);
  assert.deepEqual(f.values.get(oldKey), f.values.get(newKey));
  const response = await f.worker.fetch(f.request(), { TARGET: f.bucket });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.pointerKey, newKey);
  assert.deepEqual(
    result.objects.map((r) => r.key),
    [newKey, f.metadataKey],
  );
  assert(f.reads.every((key) => key === newKey || key === f.metadataKey));
  assert.equal(result.objects[0].sha256, hash(f.pointerBytes));
});
test('cross-project, unscoped and wrong-verifier read commands fail before any bucket access', async () => {
  const f = await fixture(newKey);
  for (const request of [
    f.request({ pointerKey: oldKey }),
    f.request({ keys: [oldKey] }),
    f.request({}, true),
  ])
    assert.equal((await f.worker.fetch(request, { TARGET: f.bucket })).status, 409);
  const oldWorker = privateCatalogReader({
    ...f.job,
    verifier: { ...f.job.verifier, activeKey: oldKey },
  });
  assert.equal((await oldWorker.fetch(f.request(), { TARGET: f.bucket })).status, 409);
  assert.deepEqual(f.reads, []);
  for (const activeKey of [
    null,
    '',
    'catalog/other/active.json',
    'catalog/jotclipart/../active.json',
  ])
    assert.throws(
      () => privateCatalogReader({ ...f.job, verifier: { ...f.job.verifier, activeKey } }),
      /pointer scope/,
    );
});
test('retargeting a signed read namespace cannot reuse the original HMAC', async () => {
  const f = await fixture(newKey);
  const envelope = await f.request({ pointerKey: oldKey }).json();
  envelope.command.pointerKey = newKey;
  const response = await f.worker.fetch(
    new Request('http://private.invalid/read', {
      method: 'POST',
      body: JSON.stringify(envelope),
    }),
    { TARGET: f.bucket },
  );
  assert.equal(response.status, 403);
  assert.deepEqual(f.reads, []);
});
test('only the selected pointer has the filename-SHA exception; immutable bytes remain strict', async () => {
  const f = await fixture(newKey);
  f.values.set(f.metadataKey, Buffer.from('changed immutable bytes'));
  await assert.rejects(
    f.worker.fetch(f.request(), { TARGET: f.bucket }),
    /Corrupt content-addressed/,
  );
  assert(!f.reads.includes(oldKey));
});
test('new remote client and worker agree on HMAC namespace and never cache the mutable pointer', async () => {
  const f = await fixture(newKey),
    diskReads = [],
    diskWrites = [];
  let calls = 0;
  const bucket = remoteCatalogBucket({
    activeKey: newKey,
    secret: f.job.secret,
    parentSnapshotSHA256: f.job.parentSnapshotSHA256,
    accountId: f.job.verifier.accountId,
    bucket: f.job.verifier.bucketName,
    diskCache: {
      get: (key) => {
        diskReads.push(key);
        return null;
      },
      put: (key) => diskWrites.push(key),
    },
    fetcher: (url, options) => {
      calls++;
      return f.worker.fetch(new Request(url, options), { TARGET: f.bucket });
    },
  });
  await bucket.get(newKey);
  await bucket.get(newKey);
  assert.equal(calls, 2);
  assert.deepEqual(diskReads, []);
  assert.deepEqual(diskWrites, []);
  assert.equal(bucket.metrics().cacheEntries, 0);
  await bucket.get(f.metadataKey);
  await bucket.get(f.metadataKey);
  assert.equal(calls, 3);
  assert.deepEqual(diskWrites, [f.metadataKey]);
  assert.equal(bucket.metrics().cacheEntries, 1);
  await assert.rejects(bucket.get(oldKey), /Invalid private metadata key/);
  assert.equal(calls, 3);
  assert(!f.reads.includes(oldKey));
  f.values.set(newKey, Buffer.from('{}'));
  await assert.rejects(bucket.get(newKey));
  assert.equal(calls, 6); // Three bounded retries still cannot return a cached pointer.
  assert(!f.reads.includes(oldKey));
});
test('remote client requires the selected response namespace and rejects unrelated pointers early', async () => {
  for (const responseScope of [undefined, oldKey]) {
    const f = await fixture(newKey);
    let requests = 0;
    const bucket = remoteCatalogBucket({
      activeKey: newKey,
      secret: f.job.secret,
      parentSnapshotSHA256: f.job.parentSnapshotSHA256,
      accountId: f.job.verifier.accountId,
      bucket: f.job.verifier.bucketName,
      fetcher: async () => {
        requests++;
        return Response.json({
          parentSnapshotSHA256: f.job.parentSnapshotSHA256,
          ...(responseScope === undefined ? {} : { pointerKey: responseScope }),
          objects: [
            {
              key: newKey,
              body: f.pointerBytes.toString('base64'),
              bytes: f.pointerBytes.length,
              sha256: hash(f.pointerBytes),
            },
          ],
        });
      },
    });
    await assert.rejects(bucket.get(newKey), /root or cardinality/);
    await assert.rejects(bucket.get(oldKey), /Invalid private metadata key/);
    assert.equal(requests, 1);
  }
});
test('new client still verifies complete body digests and immutable filename hashes', async () => {
  const f = await fixture(newKey);
  for (const target of [newKey, f.metadataKey]) {
    const bytes = Buffer.from('untrusted response');
    const bucket = remoteCatalogBucket({
      activeKey: newKey,
      secret: f.job.secret,
      parentSnapshotSHA256: f.job.parentSnapshotSHA256,
      accountId: f.job.verifier.accountId,
      bucket: f.job.verifier.bucketName,
      fetcher: async () =>
        Response.json({
          parentSnapshotSHA256: f.job.parentSnapshotSHA256,
          pointerKey: newKey,
          objects: [
            {
              key: target,
              bytes: bytes.length,
              body: bytes.toString('base64'),
              sha256: target === newKey ? '0'.repeat(64) : hash(bytes),
            },
          ],
        }),
    });
    await assert.rejects(bucket.get(target), /Private read bytes differ/);
    assert.equal(bucket.metrics().cacheEntries, 0);
  }
  for (const activeKey of [null, '', 'catalog/other/active.json'])
    assert.throws(
      () =>
        remoteCatalogBucket({
          activeKey,
          secret: f.job.secret,
          parentSnapshotSHA256: f.job.parentSnapshotSHA256,
          accountId: f.job.verifier.accountId,
          bucket: f.job.verifier.bucketName,
        }),
      /pointer scope/,
    );
});
