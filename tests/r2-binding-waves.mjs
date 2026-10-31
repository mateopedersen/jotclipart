import test from 'node:test';
import assert from 'node:assert/strict';
import { completeMediaWaveJournals } from '../scripts/r2/binding-waves.mjs';

function fixture() {
  const records = [1, 2, 3].map((n) => ({ record: { wave: n === 1 ? 1 : 2, path: '/f' + n, key: 'k' + n, bytes: n * 10, sha256: String(n).repeat(64), assetId: 'art' + n } }));
  const done = new Map(records.map(({ record }) => [record.path, { ...record }]));
  return { records, waves: [{ number: 1, batchSha256: 'a'.repeat(64) }, { number: 2, batchSha256: 'b'.repeat(64) }], done, missing: new Set(['/f2']), snapshot: { buckets: [{ name: 'media', jurisdiction: 'default', objects: records.map(({ record }) => ({ key: record.key, bytes: record.bytes })) }] }, lease: { bucket: 'media', observedAt: 1000, measuredBytes: 600, inventoryScope: { jurisdictions: [] } }, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z', now: 2000 };
}

test('verified existing and freshly uploaded media produce complete separate wave evidence', () => {
  const f = fixture(), result = completeMediaWaveJournals(f);
  assert.equal(result.length, 2);
  assert.equal(result[0].verifiedObjects.length, 1);
  assert.equal(result[1].verifiedObjects.length, 2);
  assert.match(result[0].transport, /read-only/);
  assert.match(result[1].transport, /signed-lease/);
  assert(result.every(x => x.publishApproved === false));
});

test('missing or mismatched readback, incomplete inventory and stale census never yield journals', () => {
  for (const variant of ['missing', 'sha', 'inventory', 'size', 'stale', 'duplicate']) {
    const f = fixture();
    if (variant === 'missing') f.done.delete('/f2');
    if (variant === 'sha') f.done.get('/f2').sha256 = 'x'.repeat(64);
    if (variant === 'inventory') f.snapshot.buckets[0].objects.pop();
    if (variant === 'size') f.snapshot.buckets[0].objects[1].bytes++;
    if (variant === 'stale') f.now = f.lease.observedAt + 45_001;
    if (variant === 'duplicate') f.waves.push(f.waves[0]);
    assert.throws(() => completeMediaWaveJournals(f));
  }
});
