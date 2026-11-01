import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { stagingWorker } from '../scripts/delivery/staging-worker.mjs';
import { digest, merkle } from '../scripts/delivery/manifest.mjs';
import {
  createReleaseWriteAuthorization,
  OWNER_MANAGED_STORAGE_POLICY,
} from '../scripts/delivery/release-write-authorization.mjs';

// An in-memory double deliberately has no inventory/list implementation: a
// successful new-policy write must be authorized by the reviewed manifest and
// followed by actual object bytes, not a fabricated read or account census.
function fixture({ count = 1, authorizedBytes, storedTransform, alreadyStored = false } = {}) {
  const source = Array.from({ length: count }, (_, i) => Buffer.from(`source-payload-${i}`));
  const records = source.map((bytes, i) => ({
    path: `/previews/p1/${String(i).padStart(24, '0')}-440.webp`,
    key: `delivery/reviewed/object-${i}.webp`,
    bytes: bytes.length,
    sha256: digest(bytes),
    mime: 'image/webp',
  }));
  const tree = merkle(records);
  const job = {
    accountId: 'a'.repeat(32),
    bucket: 'ultraclipart-pages',
    root: tree.root,
    revision: 'b'.repeat(40),
    secret: 'c'.repeat(64),
    sourceOrigin: 'https://ultraclipart.com',
    storagePolicy: OWNER_MANAGED_STORAGE_POLICY,
    authorizedBytes: authorizedBytes ?? source.reduce((sum, b) => sum + b.length, 0),
  };
  const rows = records.map((record, i) => ({ record, proof: tree.proof(i) }));
  const blobs = Object.fromEntries(
    records.map((record, i) => [record.path, source[i].toString('base64')]),
  );
  const objects = new Map();
  if (alreadyStored)
    for (let i = 0; i < records.length; i++)
      objects.set(records[i].key, { bytes: Buffer.from(source[i]), mime: records[i].mime });
  const counts = { get: 0, put: 0, bodyRead: 0, list: 0 };
  const env = {
    TARGET: {
      list: async () => {
        counts.list++;
        throw Error('Account inventory must not be requested');
      },
      get: async (key) => {
        counts.get++;
        const object = objects.get(key);
        if (!object) return null;
        return {
          size: object.size ?? object.bytes.length,
          httpMetadata: { contentType: object.mime },
          etag: object.etag ?? 'actual-object-etag',
          ...(object.noBody
            ? {}
            : {
                arrayBuffer: async () => {
                  counts.bodyRead++;
                  return Buffer.from(object.bytes);
                },
              }),
        };
      },
      put: async (key, bytes, options) => {
        counts.put++;
        assert.equal(options.onlyIf.etagDoesNotMatch, '*');
        if (objects.has(key)) return null;
        const item = { bytes: Buffer.from(bytes), mime: options.httpMetadata.contentType };
        const stored = storedTransform ? storedTransform(item) : item;
        if (stored) objects.set(key, stored);
        return stored;
      },
    },
  };
  const sign = (lease, secret = job.secret) =>
    createHmac('sha256', Buffer.from(secret, 'hex')).update(JSON.stringify(lease)).digest('hex');
  const auth = (changes = {}, at = Date.now()) => {
    const lease = { ...createReleaseWriteAuthorization(job, at), ...changes };
    return { lease, signature: sign(lease) };
  };
  const send = (
    body,
    { header = false, worker = stagingWorker(job), target = env, path = '/stage' } = {},
  ) => {
    const value = structuredClone(body);
    const headers = {};
    if (header) {
      headers['X-UC-Stage-Authorization'] = JSON.stringify({
        lease: value.lease,
        signature: value.signature,
      });
      delete value.lease;
      delete value.signature;
    }
    return worker.fetch(
      new Request(`https://private.example${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(value),
      }),
      target,
    );
  };
  const body = (changes = {}) => ({ ...auth(changes), records: rows, blobs });
  return { source, records, rows, blobs, job, objects, counts, env, sign, auth, body, send };
}

test('fresh HMAC lease and Merkle-proven bytes write once and read back real stored bytes', async () => {
  const f = fixture({ count: 2 });
  const response = await f.send(f.body(), { header: true });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.root, f.job.root);
  assert.equal(result.verified.length, 2);
  for (let i = 0; i < f.records.length; i++) {
    assert.equal(result.verified[i].sha256, f.records[i].sha256);
    assert.deepEqual(f.objects.get(f.records[i].key).bytes, f.source[i]);
  }
  assert.deepEqual(f.counts, { get: 4, put: 2, bodyRead: 2, list: 0 });
  assert.equal((await f.send(f.body())).status, 200);
  assert.deepEqual(f.counts, { get: 6, put: 2, bodyRead: 4, list: 0 });
});

test('a real existing exact object is read and verified without an overwrite', async () => {
  const f = fixture({ alreadyStored: true });
  assert.equal((await f.send(f.body())).status, 200);
  assert.deepEqual(f.counts, { get: 1, put: 0, bodyRead: 1, list: 0 });
  f.objects.get(f.records[0].key).bytes = Buffer.alloc(f.records[0].bytes, 7);
  await assert.rejects(f.send(f.body()), /Remote checksum mismatch/);
  assert.equal(f.counts.put, 0);
  assert.equal(f.counts.bodyRead, 2);
});

test('a concurrent conflicting creator cannot be overwritten or reported as verified', async () => {
  const f = fixture();
  const competing = Buffer.alloc(f.records[0].bytes, 8);
  f.env.TARGET.put = async (key, _bytes, options) => {
    f.counts.put++;
    assert.equal(options.onlyIf.etagDoesNotMatch, '*');
    // Another writer wins between the initial GET and the conditional PUT.
    f.objects.set(key, { bytes: competing, mime: f.records[0].mime });
    return null;
  };
  await assert.rejects(f.send(f.body()), /Remote checksum mismatch/);
  assert.deepEqual(f.objects.get(f.records[0].key).bytes, competing);
  assert.deepEqual(f.counts, { get: 2, put: 1, bodyRead: 1, list: 0 });
});

test('signed invalid scopes, fields and timestamps fail before any object access', async () => {
  const f = fixture();
  const badLeases = [
    { root: 'f'.repeat(64) },
    { accountId: 'f'.repeat(32) },
    { bucket: 'other-bucket' },
    { revision: 'f'.repeat(40) },
    { policy: 'wrong-policy' },
    { authorizedBytes: f.job.authorizedBytes + 1 },
    { authorizedBytes: 0 },
    { authorizedBytes: NaN },
    { authorizedBytes: Number.MAX_SAFE_INTEGER + 1 },
    { measuredBytes: 0 },
    { issuedAt: Date.now() - 60_000 },
    { issuedAt: Date.now() + 60_000 },
    { issuedAt: NaN },
    { issuedAt: -1 },
    { unexpected: true },
  ];
  for (const changes of badLeases)
    assert.equal((await f.send(f.body(changes))).status, 409, JSON.stringify(changes));
  for (const field of [
    'policy',
    'root',
    'accountId',
    'bucket',
    'revision',
    'authorizedBytes',
    'issuedAt',
    'measuredBytes',
  ]) {
    const body = f.body();
    delete body.lease[field];
    body.signature = f.sign(body.lease);
    assert.equal((await f.send(body)).status, 409, `missing ${field}`);
  }
  const invalid = f.body();
  invalid.signature = '0'.repeat(64);
  assert.equal((await f.send(invalid)).status, 403);
  const alteredAfterSigning = f.body();
  alteredAfterSigning.lease.issuedAt--;
  assert.equal((await f.send(alteredAfterSigning)).status, 403);
  assert.deepEqual(f.counts, { get: 0, put: 0, bodyRead: 0, list: 0 });
});

test('45-second boundary is honored by the actual worker for each request', async (t) => {
  const f = fixture();
  const fixed = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => fixed);
  const onBoundary = f.body({ issuedAt: fixed - 45_000 });
  assert.equal((await f.send(onBoundary)).status, 200);
  const stale = f.body({ issuedAt: fixed - 45_001 });
  assert.equal((await f.send(stale)).status, 409);
  assert.equal(f.counts.put, 1);
});

test('tampered Merkle records and proofs are rejected before storage access', async () => {
  const f = fixture({ count: 2 });
  const changed = f.body();
  changed.records = structuredClone(f.rows);
  changed.records[1].record.key = 'outside/reviewed/manifest';
  assert.equal((await f.send(changed)).status, 403);
  const invalidProof = f.body();
  invalidProof.records = structuredClone(f.rows);
  invalidProof.records[1].proof[0].hash = 'f'.repeat(64);
  assert.equal((await f.send(invalidProof)).status, 403);
  const repeated = f.body();
  repeated.records = [f.rows[0], f.rows[0]];
  assert.equal((await f.send(repeated)).status, 400);
  assert.deepEqual(f.counts, { get: 0, put: 0, bodyRead: 0, list: 0 });
});

test('reviewed release-byte bound is enforced for a request before any storage access', async () => {
  const f = fixture({ authorizedBytes: 1 });
  assert.equal((await f.send(f.body())).status, 413);
  assert.deepEqual(f.counts, { get: 0, put: 0, bodyRead: 0, list: 0 });
});

test('changed source bytes cannot be written even with a valid lease and manifest', async () => {
  const f = fixture();
  const body = f.body();
  body.blobs = { [f.records[0].path]: Buffer.alloc(f.records[0].bytes, 5).toString('base64') };
  await assert.rejects(f.send(body), /Source checksum mismatch/);
  assert.deepEqual(f.counts, { get: 1, put: 0, bodyRead: 0, list: 0 });
});

for (const [problem, storedTransform] of [
  ['missing', () => null],
  ['wrong size', (object) => ({ ...object, size: object.bytes.length - 1 })],
  ['wrong bytes', (object) => ({ ...object, bytes: Buffer.alloc(object.bytes.length, 9) })],
  ['wrong MIME', (object) => ({ ...object, mime: 'text/plain' })],
  ['metadata only', (object) => ({ ...object, noBody: true })],
]) {
  test(`a ${problem} post-write readback cannot produce a verified receipt`, async () => {
    const f = fixture({ storedTransform });
    await assert.rejects(f.send(f.body()), /Remote checksum mismatch/);
    assert.equal(f.counts.put, 1);
    assert.equal(f.counts.get, 2);
  });
}

test('read-only verification reports absent objects, never invents readback or writes them', async () => {
  const f = fixture();
  const command = {
    action: 'verify',
    root: f.job.root,
    accountId: f.job.accountId,
    bucket: f.job.bucket,
    at: Date.now(),
  };
  const response = await f.send(
    { command, signature: f.sign(command), records: f.rows },
    { path: '/verify' },
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.verified, []);
  assert.equal(result.missing.length, 1);
  assert.deepEqual(f.counts, { get: 1, put: 0, bodyRead: 0, list: 0 });
});

test('an explicitly unknown storage policy cannot silently downgrade to a legacy lease', async () => {
  const f = fixture();
  const legacyLease = {
    root: f.job.root,
    accountId: f.job.accountId,
    bucket: f.job.bucket,
    projectedBytes: 1000,
    observedAt: Date.now(),
  };
  const worker = stagingWorker({ ...f.job, storagePolicy: 'owner-managed-unlimited-v2' });
  const response = await f.send(
    { lease: legacyLease, signature: f.sign(legacyLease), records: f.rows, blobs: f.blobs },
    { worker },
  );
  assert([400, 403, 409].includes(response.status));
  assert.deepEqual(f.counts, { get: 0, put: 0, bodyRead: 0, list: 0 });
  // The independently signed read-only path remains usable; it cannot write.
  const command = {
    action: 'verify',
    root: f.job.root,
    accountId: f.job.accountId,
    bucket: f.job.bucket,
    at: Date.now(),
  };
  const verification = await f.send(
    { command, signature: f.sign(command), records: f.rows },
    { path: '/verify', worker },
  );
  assert.equal(verification.status, 200);
  assert.equal((await verification.json()).missing.length, 1);
  assert.equal(f.counts.put, 0);
});

test('a new-policy lease is not accepted by an unconfigured legacy job', async () => {
  const f = fixture();
  const legacyJob = { ...f.job };
  delete legacyJob.storagePolicy;
  delete legacyJob.authorizedBytes;
  assert.equal((await f.send(f.body(), { worker: stagingWorker(legacyJob) })).status, 409);
  assert.deepEqual(f.counts, { get: 0, put: 0, bodyRead: 0, list: 0 });
});
