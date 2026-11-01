import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completeMediaWaveJournals,
  completeReleaseMediaWaveJournals,
} from '../scripts/r2/binding-waves.mjs';
import { artwork } from './fixtures/publication.mjs';
import { releaseFixture } from './fixtures/publication-release.mjs';

function fixture() {
  const records = [1, 2, 3].map((n) => ({
    record: {
      wave: n === 1 ? 1 : 2,
      path: '/f' + n,
      key: 'k' + n,
      bytes: n * 10,
      sha256: String(n).repeat(64),
      assetId: 'art' + n,
    },
  }));
  const done = new Map(records.map(({ record }) => [record.path, { ...record }]));
  return {
    records,
    waves: [
      { number: 1, batchSha256: 'a'.repeat(64) },
      { number: 2, batchSha256: 'b'.repeat(64) },
    ],
    done,
    missing: new Set(['/f2']),
    snapshot: {
      buckets: [
        {
          name: 'media',
          jurisdiction: 'default',
          objects: records.map(({ record }) => ({ key: record.key, bytes: record.bytes })),
        },
      ],
    },
    lease: {
      bucket: 'media',
      observedAt: 1000,
      measuredBytes: 600,
      inventoryScope: { jurisdictions: [] },
    },
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:01:00Z',
    now: 2000,
  };
}

test('verified existing and freshly uploaded media produce complete separate wave evidence', () => {
  const f = fixture(),
    result = completeMediaWaveJournals(f);
  assert.equal(result.length, 2);
  assert.equal(result[0].verifiedObjects.length, 1);
  assert.equal(result[1].verifiedObjects.length, 2);
  assert.match(result[0].transport, /read-only/);
  assert.match(result[1].transport, /signed-lease/);
  assert(result.every((x) => x.publishApproved === false));
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

test('release-scoped wave journals prove the full byte-verified batch without claiming account usage', () => {
  const bodies = new Map(),
    a = artwork('first', bodies),
    b = artwork('second', bodies);
  const f = releaseFixture([[a], [b]]),
    journals = completeReleaseMediaWaveJournals(f);
  assert.equal(journals.length, 2);
  assert.equal(
    journals.reduce((sum, j) => sum + j.waveBytes, 0),
    f.job.authorizedBytes,
  );
  for (const j of journals) {
    assert.equal(j.schemaVersion, 3);
    assert.equal(j.accountUsageMeasured, false);
    assert.equal(j.aggregateBytes, null);
    assert.equal(j.inventoryScope, null);
    assert.equal(j.publishApproved, false);
    assert.equal(j.root, f.job.root);
    assert(j.verifiedObjects.every((o) => Array.isArray(o.releaseProof)));
  }
  assert.match(journals[0].transport, /existing-independent/);
  assert.match(journals[1].transport, /conditional-create/);
});

test('release-scoped journals fail closed on incomplete, misplaced, tampered or unverified evidence', () => {
  for (const mutate of [
    (f) => f.done.delete(f.records[0].record.path),
    (f) => (f.done.get(f.records[0].record.path).sha256 = 'c'.repeat(64)),
    (f) => f.done.get(f.records[0].record.path).bytes++,
    (f) => (f.done.get(f.records[0].record.path).root = 'c'.repeat(64)),
    (f) => (f.done.get(f.records[0].record.path).accountId = 'c'.repeat(32)),
    (f) => (f.done.get(f.records[0].record.path).bucket = 'other-bucket'),
    (f) => (f.done.get(f.records[0].record.path).jurisdiction = 'eu'),
    (f) => (f.records[0].proof[0].hash = 'c'.repeat(64)),
    (f) => (f.job.root = 'c'.repeat(64)),
    (f) => f.job.authorizedBytes++,
    (f) => (f.job.storagePolicy = 'invented-account-limit'),
    (f) => f.waves[0].batch[0].bytes++,
    (f) => (f.waves[0].batch[0].bucket = 'other-bucket'),
    (f) => f.waves.pop(),
    (f) => f.waves.push(f.waves[0]),
    (f) => f.missing.add('/outside-release'),
    (f) => (f.records[0].record.path = f.records[1].record.path),
    (f) => (f.completedAt = 'not a date'),
  ]) {
    const bodies = new Map(),
      a = artwork('first', bodies),
      b = artwork('second', bodies);
    const f = releaseFixture([[a], [b]]);
    mutate(f);
    assert.throws(() => completeReleaseMediaWaveJournals(f));
  }
});
