import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createReleaseWriteAuthorization,
  validateReleaseWriteAuthorization,
  OWNER_MANAGED_STORAGE_POLICY,
  RELEASE_WRITE_AUTH_MAX_AGE_MS,
} from '../scripts/delivery/release-write-authorization.mjs';

const now = 1_800_000_000_000;
const job = Object.freeze({
  accountId: 'a'.repeat(32),
  bucket: 'ultraclipart-pages',
  root: 'b'.repeat(64),
  revision: 'c'.repeat(40),
  storagePolicy: OWNER_MANAGED_STORAGE_POLICY,
  authorizedBytes: 1_234_567,
});

test('creates an immutable release-scoped authorization with explicitly unknown usage', () => {
  const lease = createReleaseWriteAuthorization(job, now);
  assert.deepEqual(lease, {
    policy: 'owner-managed-unlimited-v1',
    accountId: job.accountId,
    bucket: job.bucket,
    root: job.root,
    revision: job.revision,
    authorizedBytes: job.authorizedBytes,
    issuedAt: now,
    measuredBytes: null,
  });
  assert(Object.isFrozen(lease));
  assert.throws(() => {
    lease.measuredBytes = 0;
  }, TypeError);
  assert.equal(validateReleaseWriteAuthorization(lease, job, now), true);
  assert.equal(
    validateReleaseWriteAuthorization(JSON.parse(JSON.stringify(lease)), job, now),
    true,
  );
});

test('permits any positive safe release byte count without an aggregate storage cap', () => {
  for (const authorizedBytes of [1, 10_000_000_000_001, Number.MAX_SAFE_INTEGER]) {
    const current = { ...job, authorizedBytes };
    assert(
      validateReleaseWriteAuthorization(
        createReleaseWriteAuthorization(current, now),
        current,
        now,
      ),
    );
  }
  for (const authorizedBytes of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    '1',
    null,
    undefined,
  ]) {
    assert.throws(() => createReleaseWriteAuthorization({ ...job, authorizedBytes }, now), /job/i);
  }
});

test('validates Cloudflare bucket names, account, release root and revision strictly', () => {
  for (const bucket of [
    '',
    'ab',
    '-abc',
    'abc-',
    'Upper',
    'has.dot',
    'white space',
    'a'.repeat(64),
    null,
    undefined,
  ])
    assert.throws(() => createReleaseWriteAuthorization({ ...job, bucket }, now), /job/i);
  for (const bucket of ['abc', 'a'.repeat(63), 'one--two']) {
    const current = { ...job, bucket };
    assert(
      validateReleaseWriteAuthorization(
        createReleaseWriteAuthorization(current, now),
        current,
        now,
      ),
    );
  }
  for (const [field, values] of Object.entries({
    accountId: ['', 'a'.repeat(31), 'g'.repeat(32), 'A'.repeat(32), 123, undefined],
    root: ['', 'a'.repeat(63), 'g'.repeat(64), 'A'.repeat(64), undefined],
    revision: ['', 'a'.repeat(39), 'g'.repeat(40), 'A'.repeat(40), undefined],
    storagePolicy: ['', 'v1', 'owner-managed-unlimited-v2', true, undefined],
  }))
    for (const value of values)
      assert.throws(() => createReleaseWriteAuthorization({ ...job, [field]: value }, now), /job/i);
});

test('rejects any scope change, missing or extra field and claimed account usage', () => {
  const lease = createReleaseWriteAuthorization(job, now);
  for (const [field, value] of Object.entries({
    policy: 'other',
    accountId: 'f'.repeat(32),
    bucket: 'other-bucket',
    root: 'f'.repeat(64),
    revision: 'f'.repeat(40),
    authorizedBytes: job.authorizedBytes + 1,
    measuredBytes: 0,
  }))
    assert.throws(
      () => validateReleaseWriteAuthorization({ ...lease, [field]: value }, job, now),
      /scope/i,
    );
  for (const field of Object.keys(lease)) {
    const incomplete = { ...lease };
    delete incomplete[field];
    assert.throws(() => validateReleaseWriteAuthorization(incomplete, job, now));
  }
  assert.throws(
    () => validateReleaseWriteAuthorization({ ...lease, projectedBytes: 0 }, job, now),
    /fields/i,
  );
  assert.throws(
    () => validateReleaseWriteAuthorization({ ...lease, [Symbol('extra')]: 1 }, job, now),
    /fields/i,
  );
  assert.throws(() => validateReleaseWriteAuthorization(null, job, now), /authorization/i);
  assert.throws(() => validateReleaseWriteAuthorization([], job, now), /authorization/i);
  assert.throws(
    () => validateReleaseWriteAuthorization(lease, { ...job, storagePolicy: 'v1' }, now),
    /job/i,
  );
});

test('accepts exactly 45 seconds and rejects stale, future and invalid times', () => {
  const lease = createReleaseWriteAuthorization(job, now);
  assert.equal(RELEASE_WRITE_AUTH_MAX_AGE_MS, 45_000);
  assert(validateReleaseWriteAuthorization(lease, job, now + 45_000));
  assert.throws(() => validateReleaseWriteAuthorization(lease, job, now + 45_001), /fresh/i);
  assert.throws(() => validateReleaseWriteAuthorization(lease, job, now - 1), /fresh/i);
  for (const invalid of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    assert.throws(() => createReleaseWriteAuthorization(job, invalid), /time/i);
    assert.throws(() => validateReleaseWriteAuthorization(lease, job, invalid), /time/i);
    assert.throws(
      () => validateReleaseWriteAuthorization({ ...lease, issuedAt: invalid }, job, now),
      /fresh/i,
    );
  }
});

test('scope validation is not authentication; callers must verify the HMAC separately', () => {
  const lease = createReleaseWriteAuthorization(job, now);
  const forged = { ...lease, issuedAt: now - 1 };
  // This deliberately succeeds: the worker must reject this without a valid HMAC.
  assert(validateReleaseWriteAuthorization(forged, job, now));
});
