// Scope and freshness checks only. The caller must authenticate the complete
// serialized lease with the existing per-session HMAC before permitting writes.
export const OWNER_MANAGED_STORAGE_POLICY = 'owner-managed-unlimited-v1';
export const RELEASE_WRITE_AUTH_MAX_AGE_MS = 45_000;

const fields = Object.freeze([
  'policy',
  'accountId',
  'bucket',
  'root',
  'revision',
  'authorizedBytes',
  'issuedAt',
  'measuredBytes',
]);
const hex32 = /^[a-f0-9]{32}$/;
const hex40 = /^[a-f0-9]{40}$/;
const hex64 = /^[a-f0-9]{64}$/;
// Cloudflare R2 bucket names are 3–63 lowercase letters, digits or hyphens,
// beginning and ending with a letter or digit.
const bucketName = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

function checkTime(now) {
  if (!Number.isSafeInteger(now) || now < 0) throw Error('Invalid authorization time');
}

function checkJob(job) {
  if (
    !job ||
    typeof job !== 'object' ||
    Array.isArray(job) ||
    job.storagePolicy !== OWNER_MANAGED_STORAGE_POLICY ||
    typeof job.accountId !== 'string' ||
    !hex32.test(job.accountId) ||
    typeof job.bucket !== 'string' ||
    !bucketName.test(job.bucket) ||
    typeof job.root !== 'string' ||
    !hex64.test(job.root) ||
    typeof job.revision !== 'string' ||
    !hex40.test(job.revision) ||
    !Number.isSafeInteger(job.authorizedBytes) ||
    job.authorizedBytes < 1
  )
    throw Error('Invalid release write job');
}

/** Creates a fresh release-scoped authorization; no account usage is measured. */
export function createReleaseWriteAuthorization(job, now = Date.now()) {
  checkTime(now);
  checkJob(job);
  return Object.freeze({
    policy: OWNER_MANAGED_STORAGE_POLICY,
    accountId: job.accountId,
    bucket: job.bucket,
    root: job.root,
    revision: job.revision,
    authorizedBytes: job.authorizedBytes,
    issuedAt: now,
    measuredBytes: null,
  });
}

/**
 * Validates an authenticated lease against independently trusted job data.
 * This does not verify an HMAC, bound the request body or perform any I/O.
 */
export function validateReleaseWriteAuthorization(lease, job, now = Date.now()) {
  checkTime(now);
  checkJob(job);
  if (!lease || typeof lease !== 'object' || Array.isArray(lease))
    throw Error('Invalid release write authorization');
  const keys = Reflect.ownKeys(lease);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== 'string' || !fields.includes(key))
  )
    throw Error('Invalid release write authorization fields');
  if (
    lease.policy !== job.storagePolicy ||
    lease.accountId !== job.accountId ||
    lease.bucket !== job.bucket ||
    lease.root !== job.root ||
    lease.revision !== job.revision ||
    lease.authorizedBytes !== job.authorizedBytes ||
    lease.measuredBytes !== null
  )
    throw Error('Release write authorization scope mismatch');
  if (
    !Number.isSafeInteger(lease.issuedAt) ||
    lease.issuedAt < 0 ||
    lease.issuedAt > now ||
    now - lease.issuedAt > RELEASE_WRITE_AUTH_MAX_AGE_MS
  )
    throw Error('Fresh release write authorization required');
  return true;
}
