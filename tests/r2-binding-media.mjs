import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { stagingWorker } from '../scripts/delivery/staging-worker.mjs';
import { merkle, digest } from '../scripts/delivery/manifest.mjs';
import { reservationEvidence } from '../scripts/delivery/storage-reservation.mjs';
import { JURISDICTIONS, SCOPE_VERSION, endpointFor } from '../scripts/r2/inventory.mjs';
const accountId = 'a'.repeat(32),
  secret = 'b'.repeat(64),
  bucket = 'media';
function fixture(overrides = {}) {
  const bytes = Buffer.from('%PDF-1.7\nreviewed original'),
    record = {
      path: '/catalog/topic/scene.pdf',
      key: 'topic/scene.pdf.' + digest(bytes).slice(0, 16) + '.pdf',
      bytes: bytes.length,
      sha256: digest(bytes),
      mime: 'application/pdf',
      contentDisposition: 'attachment; filename="scene.pdf"',
      ...overrides,
    },
    tree = merkle([record]),
    job = { root: tree.root, accountId, bucket, revision: 'c'.repeat(40), secret, media: true },
    lease = { root: tree.root, accountId, bucket, projectedBytes: 1000000, observedAt: Date.now() },
    body = {
      lease,
      signature: createHmac('sha256', Buffer.from(secret, 'hex'))
        .update(JSON.stringify(lease))
        .digest('hex'),
      records: [{ record, proof: tree.proof(0) }],
    };
  let value,
    metadata,
    puts = 0;
  const env = {
    TARGET: {
      get: async () =>
        value && {
          size: value.length,
          httpMetadata: metadata,
          etag: 'verified-version',
          arrayBuffer: async () => value,
        },
      put: async (k, b, options) => {
        assert.equal(options.onlyIf.etagDoesNotMatch, '*');
        value = Buffer.from(b);
        metadata = options.httpMetadata;
        puts++;
      },
    },
  };
  return {
    bytes,
    record,
    body,
    worker: stagingWorker(job),
    env,
    request: (b = bytes, m = body) =>
      new Request('https://private.example/stage', {
        method: 'POST',
        headers: { 'X-UC-Stage-Metadata': JSON.stringify(m) },
        body: b,
      }),
    setValue: (b) => {
      value = Buffer.from(b);
    },
    setMetadata: (m) => {
      metadata = m;
    },
    puts: () => puts,
  };
}
test('binding media preserves PDF attachment metadata and verifies actual remote bytes', async () => {
  const f = fixture();
  assert.equal((await f.worker.fetch(f.request(), f.env)).status, 200);
  assert.equal(f.puts(), 1);
  assert.equal((await f.worker.fetch(f.request(), f.env)).status, 200);
  assert.equal(f.puts(), 1);
  f.setValue('wrong');
  await assert.rejects(f.worker.fetch(f.request(), f.env), /Remote checksum mismatch/);
  assert.equal(f.puts(), 1);
});
test('matching media bytes with wrong stored PDF metadata are rejected without rewriting', async () => {
  const f = fixture();
  await f.worker.fetch(f.request(), f.env);
  f.setMetadata({ contentType: 'application/pdf', contentDisposition: 'inline' });
  await assert.rejects(f.worker.fetch(f.request(), f.env), /Remote checksum mismatch/);
  assert.equal(f.puts(), 1);
});
test('bad native source, changed Merkle record and expired reservation never write', async () => {
  const f = fixture();
  await assert.rejects(f.worker.fetch(f.request('bad'), f.env), /Source checksum mismatch/);
  const other = structuredClone(f.body);
  other.records[0].record.key = 'outside/key';
  assert.equal((await f.worker.fetch(f.request(f.bytes, other), f.env)).status, 403);
  const expired = structuredClone(f.body);
  expired.lease.observedAt -= 46000;
  assert.equal((await f.worker.fetch(f.request(f.bytes, expired), f.env)).status, 409);
  assert.equal(f.puts(), 0);
});
test('native media still rejects oversized PDFs, unsafe filenames and unrelated MIME', async () => {
  for (const props of [
    { bytes: 1000001 },
    { contentDisposition: 'attachment; filename="../bad.pdf"' },
    { mime: 'text/html' },
  ]) {
    const f = fixture(props);
    assert.equal((await f.worker.fetch(f.request(), f.env)).status, 400);
    assert.equal(f.puts(), 0);
  }
});
test('binding publication evidence preserves complete fresh jurisdiction coverage and budget', () => {
  const now = Date.now(),
    inventory = {
      schemaVersion: 2,
      scopeVersion: SCOPE_VERSION,
      accountId,
      complete: true,
      observedAt: now,
      jurisdictions: JURISDICTIONS.map((jurisdiction) => ({
        jurisdiction,
        endpoint: endpointFor(accountId, jurisdiction),
        complete: true,
        buckets: jurisdiction === 'default' ? ['media'] : [],
        proof: { source: 's3-list-buckets' },
      })),
      buckets: [
        {
          name: 'media',
          jurisdiction: 'default',
          complete: true,
          objects: [{ key: 'known', bytes: 10 }],
        },
      ],
    };
  const out = reservationEvidence(inventory, 20, now);
  assert.equal(out.projectedBytes, 30);
  assert.deepEqual(out.inventoryScope.jurisdictions, inventory.jurisdictions);
  assert.equal(out.inventoryScope.scopeVersion, SCOPE_VERSION);
  assert.throws(
    () => reservationEvidence({ ...inventory, observedAt: now - 45001 }, 1, now),
    /Fresh complete/,
  );
  assert.throws(() => reservationEvidence({ ...inventory, jurisdictions: [] }, 1, now), /coverage/);
  assert.throws(() => reservationEvidence(inventory, 10000000000000, now), /budget|cap/i);
});

test('stale but complete measurements retry only full reads; denied or unknown coverage stops immediately', async () => {
  const { freshBindingReservation } = await import('../scripts/r2/binding-reservation.mjs');
  let calls = 0;
  const stale = () =>
    Object.assign(Error('Fresh complete account inventory required'), {
      readOnlyInventoryHints: [],
    });
  assert.equal(
    await freshBindingReservation(
      async () => {
        if (++calls < 3) throw stale();
        return 'fresh';
      },
      { wait: async () => {} },
    ),
    'fresh',
  );
  assert.equal(calls, 3);
  for (const error of [Error('scope denied'), Error('Fresh complete account inventory required')]) {
    calls = 0;
    await assert.rejects(
      freshBindingReservation(
        async () => {
          calls++;
          throw error;
        },
        { wait: async () => {} },
      ),
    );
    assert.equal(calls, 1);
  }
  calls = 0;
  await assert.rejects(
    freshBindingReservation(
      async () => {
        calls++;
        throw stale();
      },
      { wait: async () => {} },
    ),
  );
  assert.equal(calls, 3);
});

test('rejected capability proofs trigger only bounded complete retries, never a lease', async () => {
  const { freshBindingReservation } = await import('../scripts/r2/binding-reservation.mjs');
  const rejected = () => Error('Invalid disabled-jurisdiction capability proof');
  let calls = 0;
  const result = await freshBindingReservation(
    async () => {
      if (++calls < 3) throw rejected();
      return { measured: 'fresh complete account inventory' };
    },
    { wait: async () => {} },
  );
  assert.equal(calls, 3);
  assert.deepEqual(result, { measured: 'fresh complete account inventory' });
  calls = 0;
  await assert.rejects(
    freshBindingReservation(
      async () => {
        calls++;
        throw rejected();
      },
      { wait: async () => {} },
    ),
    /Invalid disabled-jurisdiction capability proof/,
  );
  assert.equal(calls, 3);
});

test('complete stale measurements can rebalance ranges without ever becoming a write lease', async () => {
  const { freshBindingReservation } = await import('../scripts/r2/binding-reservation.mjs');
  let calls = 0,
    hints;
  const result = await freshBindingReservation(
    async () => {
      if (++calls === 1)
        throw Object.assign(Error('Fresh complete account inventory required'), {
          readOnlyInventoryHints: [{ bucket: 'media', bounds: ['balanced-key'] }],
        });
      assert.equal(hints[0].bounds[0], 'balanced-key');
      return { fresh: true };
    },
    {
      wait: async () => {},
      onStale: (value) => {
        hints = value;
      },
    },
  );
  assert.deepEqual(result, { fresh: true });
  assert.equal(calls, 2);
});

test('a self-consistent checksum cannot disguise a wrong file format or active SVG as reviewed media', async () => {
  const { validateBindingBytes } = await import('../scripts/r2/reviewed-binding-input.mjs');
  const check = (kind, text) => {
    const bytes = Buffer.from(text);
    return () => validateBindingBytes({ kind, bytes: bytes.length, sha256: digest(bytes) }, bytes);
  };
  assert.throws(check('pdf', 'RIFF0000WEBP'), /PDF/);
  assert.throws(check('webp', '%PDF-1.7'), /WebP/);
  for (const text of [
    '<svg><script>alert(1)</script></svg>',
    '<svg onload="run()"></svg>',
    '<svg><image href="https://elsewhere/image"/></svg>',
  ])
    assert.throws(check('svg', text), /Unsafe SVG/);
  assert.doesNotThrow(check('pdf', '%PDF-1.7 reviewed'));
  assert.doesNotThrow(check('svg', '<svg><path d="M0 0L1 1"/></svg>'));
});
