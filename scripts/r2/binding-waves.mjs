import assert from 'node:assert/strict';

/** Construct journals only after one complete post-transfer account inventory.
 * Each file must also have its own independent full-body readback receipt.
 * This helper neither performs I/O nor authorizes, publishes, or writes files.
 */
export function completeMediaWaveJournals({ records, waves, done, snapshot, lease, missing, startedAt, completedAt, now = Date.now() }) {
  assert(Array.isArray(records) && records.length > 0 && Array.isArray(waves));
  assert(done instanceof Map && missing instanceof Set);
  assert(Number.isFinite(Date.parse(startedAt)) && Number.isFinite(Date.parse(completedAt)));
  assert(lease && Number.isSafeInteger(lease.observedAt) && now >= lease.observedAt && now - lease.observedAt <= 45_000, 'Fresh post-transfer inventory required');
  assert(Number.isSafeInteger(lease.measuredBytes) && lease.measuredBytes >= 0 && lease.measuredBytes <= 10_000_000_000_000);
  assert(lease.inventoryScope && Array.isArray(snapshot?.buckets));
  const target = snapshot.buckets.find(b => b.name === lease.bucket && b.jurisdiction === 'default');
  assert(target && Array.isArray(target.objects));
  const current = new Map(target.objects.map(o => [o.key, o]));
  assert.equal(done.size, records.length, 'Every file requires a readback');
  const journals = [];
  for (const wave of waves) {
    const group = records.filter(({ record }) => record.wave === wave.number);
    assert(group.length > 0, 'A requested wave is empty');
    for (const { record } of group) {
      const row = done.get(record.path);
      assert(row && row.key === record.key && row.bytes === record.bytes && row.sha256 === record.sha256, 'Missing or inconsistent readback');
      assert.equal(current.get(record.key)?.bytes, record.bytes, 'Complete account inventory omitted verified source');
    }
    journals.push({
      schemaVersion: 2,
      inventoryScope: lease.inventoryScope,
      batchSha256: wave.batchSha256,
      startedAt,
      status: 'uploaded-and-byte-verified',
      verifiedObjects: group.map(({ record }) => ({ jurisdiction: 'default', bucket: lease.bucket, key: record.key, sha256: record.sha256, bytes: record.bytes })),
      verifiedArtworkIds: [...new Set(group.map(({ record }) => record.assetId))],
      publishApproved: false,
      completedAt,
      aggregateBytes: lease.measuredBytes,
      transport: group.some(({ record }) => missing.has(record.path))
        ? 'private-r2-binding-merkle-signed-lease-and-independent-get-sha256'
        : 'private-r2-binding-read-only-full-body-sha256-and-complete-inventory',
    });
  }
  assert.equal(journals.reduce((n, j) => n + j.verifiedObjects.length, 0), records.length, 'Every record must belong to exactly one journal');
  return journals;
}
