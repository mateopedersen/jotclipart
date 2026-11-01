import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { merkle } from '../delivery/manifest.mjs';
import {
  OWNER_MANAGED_STORAGE_POLICY,
  createReleaseWriteAuthorization,
  validateReleaseWriteAuthorization,
} from '../delivery/release-write-authorization.mjs';
import { validateBatch } from './plan.mjs';

/** Construct journals only after one complete post-transfer account inventory.
 * Each file must also have its own independent full-body readback receipt.
 * This helper neither performs I/O nor authorizes, publishes, or writes files.
 */
export function completeMediaWaveJournals({
  records,
  waves,
  done,
  snapshot,
  lease,
  missing,
  startedAt,
  completedAt,
  now = Date.now(),
}) {
  assert(Array.isArray(records) && records.length > 0 && Array.isArray(waves));
  assert(done instanceof Map && missing instanceof Set);
  assert(Number.isFinite(Date.parse(startedAt)) && Number.isFinite(Date.parse(completedAt)));
  assert(
    lease &&
      Number.isSafeInteger(lease.observedAt) &&
      now >= lease.observedAt &&
      now - lease.observedAt <= 45_000,
    'Fresh post-transfer inventory required',
  );
  assert(
    Number.isSafeInteger(lease.measuredBytes) &&
      lease.measuredBytes >= 0 &&
      lease.measuredBytes <= 10_000_000_000_000,
  );
  assert(lease.inventoryScope && Array.isArray(snapshot?.buckets));
  const target = snapshot.buckets.find(
    (b) => b.name === lease.bucket && b.jurisdiction === 'default',
  );
  assert(target && Array.isArray(target.objects));
  const current = new Map(target.objects.map((o) => [o.key, o]));
  assert.equal(done.size, records.length, 'Every file requires a readback');
  const journals = [];
  for (const wave of waves) {
    const group = records.filter(({ record }) => record.wave === wave.number);
    assert(group.length > 0, 'A requested wave is empty');
    for (const { record } of group) {
      const row = done.get(record.path);
      assert(
        row && row.key === record.key && row.bytes === record.bytes && row.sha256 === record.sha256,
        'Missing or inconsistent readback',
      );
      assert.equal(
        current.get(record.key)?.bytes,
        record.bytes,
        'Complete account inventory omitted verified source',
      );
    }
    journals.push({
      schemaVersion: 2,
      inventoryScope: lease.inventoryScope,
      batchSha256: wave.batchSha256,
      startedAt,
      status: 'uploaded-and-byte-verified',
      verifiedObjects: group.map(({ record }) => ({
        jurisdiction: 'default',
        bucket: lease.bucket,
        key: record.key,
        sha256: record.sha256,
        bytes: record.bytes,
      })),
      verifiedArtworkIds: [...new Set(group.map(({ record }) => record.assetId))],
      publishApproved: false,
      completedAt,
      aggregateBytes: lease.measuredBytes,
      transport: group.some(({ record }) => missing.has(record.path))
        ? 'private-r2-binding-merkle-signed-lease-and-independent-get-sha256'
        : 'private-r2-binding-read-only-full-body-sha256-and-complete-inventory',
    });
  }
  assert.equal(
    journals.reduce((n, j) => n + j.verifiedObjects.length, 0),
    records.length,
    'Every record must belong to exactly one journal',
  );
  return journals;
}

/**
 * Record independently read-back media for exactly one reviewed release.
 * The authorization below validates scope only: it is not a claim that account
 * usage was measured or that a new authorization performed the earlier writes.
 * This pure helper performs no storage access, publication or approval.
 */
export function completeReleaseMediaWaveJournals({
  records,
  waves,
  done,
  job,
  missing,
  startedAt,
  completedAt,
  now = Date.now(),
}) {
  const authorization = createReleaseWriteAuthorization(job, now);
  validateReleaseWriteAuthorization(authorization, job, now);
  assert.equal(job.storagePolicy, OWNER_MANAGED_STORAGE_POLICY);
  assert(Array.isArray(records) && records.length > 0 && Array.isArray(waves) && waves.length > 0);
  assert(done instanceof Map && missing instanceof Set);
  assert(typeof startedAt === 'string' && typeof completedAt === 'string');
  const start = Date.parse(startedAt),
    end = Date.parse(completedAt);
  assert(
    Number.isFinite(start) && Number.isFinite(end) && start <= end && end <= now,
    'Invalid verification interval',
  );

  const source = records.map((item) => {
    assert(
      item && item.record && Array.isArray(item.proof),
      'A record and its Merkle proof are required',
    );
    return item.record;
  });
  const tree = merkle(source);
  assert.equal(tree.root, job.root, 'Reviewed record root differs from release scope');
  const paths = new Set(),
    keys = new Set(),
    groups = new Map();
  let totalBytes = 0;
  for (const [index, { record, proof }] of records.entries()) {
    assert(
      record &&
        typeof record.path === 'string' &&
        record.path.startsWith('/') &&
        !record.path.split('/').includes('..') &&
        typeof record.key === 'string' &&
        record.key &&
        Number.isSafeInteger(record.bytes) &&
        record.bytes > 0 &&
        /^[a-f0-9]{64}$/.test(record.sha256 ?? '') &&
        typeof record.assetId === 'string' &&
        record.assetId &&
        Number.isSafeInteger(record.wave) &&
        record.wave > 0,
      'Invalid release record',
    );
    assert(!paths.has(record.path) && !keys.has(record.key), 'Duplicate release path or key');
    paths.add(record.path);
    keys.add(record.key);
    assert.deepEqual(proof, tree.proof(index), 'Release proof differs from its source record');
    totalBytes += record.bytes;
    assert(Number.isSafeInteger(totalBytes), 'Unsafe release byte sum');
    const row = done.get(record.path);
    assert(
      row &&
        row.path === record.path &&
        row.key === record.key &&
        row.bytes === record.bytes &&
        row.sha256 === record.sha256 &&
        row.root === job.root &&
        row.accountId === job.accountId &&
        row.bucket === job.bucket &&
        row.jurisdiction === 'default',
      'Missing or inconsistent release-scoped independent readback',
    );
    const group = groups.get(record.wave) ?? [];
    group.push({ record, proof });
    groups.set(record.wave, group);
  }
  assert.equal(
    totalBytes,
    job.authorizedBytes,
    'Authorized bytes differ from the complete release',
  );
  assert.equal(done.size, records.length, 'Every release record requires one readback');
  for (const path of missing) assert(paths.has(path), 'Missing-object set is outside the release');

  const seenWaves = new Set(),
    seenArtworks = new Set(),
    journals = [];
  for (const wave of waves) {
    assert(
      wave &&
        Number.isSafeInteger(wave.number) &&
        wave.number > 0 &&
        !seenWaves.has(wave.number) &&
        /^[a-f0-9]{64}$/.test(wave.batchSha256 ?? ''),
      'Invalid or duplicated release wave',
    );
    seenWaves.add(wave.number);
    const group = groups.get(wave.number);
    assert(group?.length, 'A requested wave is empty');
    const batch = validateBatch(wave.batch);
    assert.equal(batch.length, group.length, 'Wave does not cover its complete reviewed batch');
    const batchByKey = new Map(batch.map((object) => [object.key, object]));
    assert.equal(batchByKey.size, batch.length, 'Duplicate wave key');
    const ids = new Set();
    let waveBytes = 0;
    for (const { record } of group) {
      const object = batchByKey.get(record.key);
      assert(
        object &&
          object.bucket === job.bucket &&
          (object.jurisdiction ?? 'default') === 'default' &&
          object.assetId === record.assetId &&
          object.kind === record.kind &&
          object.bytes === record.bytes &&
          object.sha256 === record.sha256 &&
          typeof object.path === 'string' &&
          resolve(object.path) === resolve('public' + record.path),
        'Wave differs from reviewed source batch',
      );
      ids.add(record.assetId);
      waveBytes += record.bytes;
    }
    assert(ids.size > 0 && ids.size <= 50, 'A wave must contain at most 50 complete artworks');
    for (const id of ids) {
      assert(!seenArtworks.has(id), 'Artwork is split or duplicated across waves');
      seenArtworks.add(id);
    }
    journals.push({
      schemaVersion: 3,
      storagePolicy: OWNER_MANAGED_STORAGE_POLICY,
      accountUsageMeasured: false,
      aggregateBytes: null,
      inventoryScope: null,
      accountId: job.accountId,
      bucket: job.bucket,
      root: job.root,
      revision: job.revision,
      authorizedBytes: job.authorizedBytes,
      waveNumber: wave.number,
      waveBytes,
      batchSha256: wave.batchSha256,
      startedAt,
      completedAt,
      status: 'uploaded-and-byte-verified',
      verifiedObjects: group.map(({ record, proof }) => ({
        jurisdiction: 'default',
        bucket: job.bucket,
        key: record.key,
        sha256: record.sha256,
        bytes: record.bytes,
        releaseRecord: record,
        releaseProof: proof,
      })),
      verifiedArtworkIds: [...ids],
      publishApproved: false,
      transport: group.some(({ record }) => missing.has(record.path))
        ? 'private-r2-binding-conditional-create-and-independent-get-sha256'
        : 'private-r2-binding-existing-independent-get-sha256',
    });
  }
  assert.equal(seenWaves.size, groups.size, 'Every record must belong to exactly one journal');
  assert.equal(
    journals.reduce((sum, journal) => sum + journal.waveBytes, 0),
    totalBytes,
  );
  return journals;
}
