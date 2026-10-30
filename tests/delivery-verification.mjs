import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { stagingWorker } from '../scripts/delivery/staging-worker.mjs';
import { digest, merkle } from '../scripts/delivery/manifest.mjs';
import {
  splitVerificationPhase,
  validateVerificationReceipt,
  verifyExistingBatch,
  verifyExistingFiles,
} from '../scripts/delivery/verification-batch.mjs';

function fixture(count = 3, size = 20) {
  const accountId = 'a'.repeat(32),
    bucket = 'test',
    secret = 'b'.repeat(64);
  const bytes = Array.from({ length: count }, (_, n) => Buffer.alloc(size, n % 256));
  const records = bytes.map((data, i) => ({
    path: `/previews/p1/${i}.webp`,
    key: `delivery/preview/${i}.webp`,
    bytes: data.length,
    sha256: digest(data),
    mime: 'image/webp',
  }));
  const tree = merkle(records),
    root = tree.root;
  const batch = records.map((record, n) => ({ record, proof: tree.proof(n) }));
  const values = new Map(
    records.map((record, n) => [
      record.key,
      {
        size: bytes[n].length,
        httpMetadata: { contentType: record.mime },
        arrayBuffer: async () => bytes[n],
        etag: `etag-${n}`,
      },
    ]),
  );
  let reads = 0,
    writes = 0;
  const env = {
    TARGET: {
      get: async (key) => {
        reads++;
        return values.get(key) ?? null;
      },
      put: async () => {
        writes++;
        throw Error('Read-only path attempted to write');
      },
    },
  };
  const worker = stagingWorker({ accountId, bucket, root, secret, revision: 'c'.repeat(40) });
  const options = {
    root,
    accountId,
    bucket,
    secret,
    wait: async () => {},
    fetcher: (url, init) => worker.fetch(new Request(url, init), env),
  };
  function body(command = { action: 'verify', root, accountId, bucket, at: Date.now() }) {
    return {
      command,
      signature: createHmac('sha256', Buffer.from(secret, 'hex'))
        .update(JSON.stringify(command))
        .digest('hex'),
      records: batch,
    };
  }
  const send = (value, endpoint = '/verify', headers = {}) =>
    worker.fetch(
      new Request(`https://private.test${endpoint}`, {
        method: 'POST',
        body: JSON.stringify(value),
        headers,
      }),
      env,
    );
  return {
    records,
    batch,
    options,
    values,
    worker,
    env,
    root,
    body,
    send,
    counts: () => ({ reads, writes }),
  };
}

test('existing assets get independent byte verification with no lease, source fetch or writes', async () => {
  const f = fixture();
  const result = await verifyExistingBatch(f.batch, f.options);
  assert.equal(result.verified.length, 3);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(f.counts(), { reads: 3, writes: 0 });
});

test('missing assets are explicitly queued, never fabricated, written or fetched publicly by verification', async () => {
  const f = fixture();
  f.values.delete(f.records[1].key);
  const result = await verifyExistingBatch(f.batch, f.options);
  assert.equal(result.verified.length, 2);
  assert.equal(result.missing[0].path, f.records[1].path);
  assert.deepEqual(f.counts(), { reads: 3, writes: 0 });
});

for (const kind of ['bytes', 'size', 'mime']) {
  test(`corrupt existing ${kind} stops the batch instead of being relabeled as missing`, async () => {
    const f = fixture(),
      value = f.values.get(f.records[1].key);
    if (kind === 'bytes') value.arrayBuffer = async () => Buffer.alloc(20, 99);
    if (kind === 'size') value.size = 19;
    if (kind === 'mime') value.httpMetadata.contentType = 'text/plain';
    await assert.rejects(verifyExistingBatch(f.batch, f.options), /422/);
    assert.deepEqual(f.counts(), { reads: 3, writes: 0 });
  });
}

test('signed read commands cannot grant writes, accept bodies or bypass storage reservations', async () => {
  const f = fixture();
  assert.equal((await f.send(f.body(), '/stage')).status, 409);
  assert.equal((await f.send({ ...f.body(), blobs: {} })).status, 400);
  assert.equal((await f.send({ ...f.body(), lease: {} })).status, 400);
  assert.equal(
    (
      await f.send(f.body(), '/verify', {
        'X-UC-Stage-Authorization': JSON.stringify({ lease: {}, signature: 'x' }),
      })
    ).status,
    400,
  );
  assert.deepEqual(f.counts(), { reads: 0, writes: 0 });
});

test('expired, future, malformed and cross-release/account/bucket read commands fail before storage access', async () => {
  const f = fixture(),
    base = f.body().command;
  for (const changes of [
    { at: Date.now() - 46_000 },
    { at: Date.now() + 60_000 },
    { at: 'invalid' },
    { root: 'd'.repeat(64) },
    { bucket: 'other' },
    { accountId: 'e'.repeat(32) },
  ])
    assert.equal((await f.send(f.body({ ...base, ...changes }))).status, 409);
  assert.equal((await f.send({ ...f.body(), signature: '0'.repeat(64) })).status, 403);
  assert.deepEqual(f.counts(), { reads: 0, writes: 0 });
});

test('a tampered last proof rejects the entire read batch before any storage access', async () => {
  const f = fixture(),
    body = f.body();
  body.records = structuredClone(body.records);
  body.records.at(-1).record.key = 'other/object';
  assert.equal((await f.send(body)).status, 403);
  assert.deepEqual(f.counts(), { reads: 0, writes: 0 });
});

test('duplicate paths and oversized read batches are rejected without opening objects', async () => {
  const f = fixture(2, 4_100_000);
  assert.equal((await f.send(f.body())).status, 413);
  const small = fixture();
  assert.equal(
    (await small.send({ ...small.body(), records: [small.batch[0], small.batch[0]] })).status,
    400,
  );
  assert.equal(
    (await small.send({ ...small.body(), records: Array(65).fill(small.batch[0]) })).status,
    400,
  );
  assert.deepEqual(f.counts(), { reads: 0, writes: 0 });
  assert.deepEqual(small.counts(), { reads: 0, writes: 0 });
});

test('incomplete, duplicate, foreign, changed and contradictory receipts never persist partial success', async () => {
  const f = fixture(),
    rows = f.records.map((r) => ({ ...r, etag: 'test' }));
  const good = { root: f.root, verified: rows, missing: [] };
  validateVerificationReceipt(good, f.batch, f.root, true);
  for (const bad of [
    { ...good, root: 'bad' },
    { ...good, missing: undefined },
    { ...good, verified: rows.slice(1) },
    { ...good, verified: [...rows, rows[0]] },
    { ...good, verified: [...rows.slice(1), { ...rows[0], key: 'other' }] },
    { ...good, verified: rows.slice(1), missing: [rows[1]] },
  ]) {
    let persisted = 0;
    await assert.rejects(
      verifyExistingFiles(f.batch, {
        ...f.options,
        actors: 1,
        onVerified: () => persisted++,
        fetcher: async () => Response.json(bad),
      }),
      /receipt/,
    );
    assert.equal(persisted, 0);
  }
});

test('bounded orchestration verifies every object once and queues only proven missing objects', async () => {
  const f = fixture(257),
    absent = [0, 63, 64, 256];
  absent.forEach((n) => f.values.delete(f.records[n].key));
  const persisted = [];
  let active = 0,
    peak = 0;
  const missing = await verifyExistingFiles(f.batch, {
    ...f.options,
    actors: 3,
    onVerified: (row) => persisted.push(row.path),
    fetcher: async (url, init) => {
      active++;
      peak = Math.max(peak, active);
      try {
        return await f.options.fetcher(url, init);
      } finally {
        active--;
      }
    },
  });
  assert.equal(persisted.length, 253);
  assert.equal(new Set(persisted).size, 253);
  assert.deepEqual(
    missing.map(({ record }) => record.path),
    absent.map((n) => f.records[n].path),
  );
  assert(peak <= 3);
  assert.deepEqual(f.counts(), { reads: 257, writes: 0 });
});

test('transient failures retry with fresh signed commands; forbidden access stops immediately', async () => {
  const f = fixture(1),
    stamps = [];
  let clock = Date.now() - 1000,
    attempts = 0;
  const result = await verifyExistingBatch(f.batch, {
    ...f.options,
    now: () => clock++,
    fetcher: async (url, init) => {
      stamps.push(JSON.parse(init.body).command.at);
      return attempts++ === 0
        ? new Response('busy', { status: 503 })
        : f.options.fetcher(url, init);
    },
  });
  assert.equal(result.verified.length, 1);
  assert(stamps[1] > stamps[0]);
  attempts = 0;
  await assert.rejects(
    verifyExistingBatch(f.batch, {
      ...f.options,
      fetcher: async () => {
        attempts++;
        return new Response('denied', { status: 403 });
      },
    }),
    /403/,
  );
  assert.equal(attempts, 1);
});

test('phase planning preserves HTML revision staging and rejects concurrency beyond the existing cap', async () => {
  const rows = [
    '/art/item/index.html',
    '/previews/p1/item.webp',
    '/edit/item/index.html',
    '/_astro/a.js',
  ].map((path) => ({ record: { path } }));
  const split = splitVerificationPhase(rows);
  assert.deepEqual(
    split.existingCandidates.map((r) => r.record.path),
    [rows[1].record.path, rows[3].record.path],
  );
  assert.deepEqual(
    split.writes.map((r) => r.record.path),
    [rows[0].record.path, rows[2].record.path],
  );
  for (const actors of [0, 17, 1.5, '16'])
    await assert.rejects(verifyExistingFiles([], { actors }), /Bounded/);
});
