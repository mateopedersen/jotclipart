import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBoundInventoryReader,
  inventoryBoundaries,
  readOnlyRangeHints,
} from '../scripts/delivery/inventory-reader.mjs';
import { inventoryHints, reserveInventory } from '../scripts/delivery/storage-reservation.mjs';
import { JURISDICTIONS, SCOPE_VERSION, endpointFor } from '../scripts/r2/inventory.mjs';
import {
  deliveryActorCount,
  IN_FLIGHT_ALLOWANCE_BYTES,
  MAX_SINGLE_SOURCE_BYTES,
  inventoryPageCount,
} from '../scripts/delivery/staging-limits.mjs';
test('multi-page inventory remains explicitly bounded and defaults to the free-safe single page', () => {
  assert.equal(inventoryPageCount({}), 1);
  assert.equal(inventoryPageCount({ UC_DELIVERY_INVENTORY_PAGES: '4' }), 4);
  for (const value of ['0', '5', 'NaN', '4.5', ''])
    assert.throws(() => inventoryPageCount({ UC_DELIVERY_INVENTORY_PAGES: value }));
});
test('configured transfer concurrency cannot exceed the existing in-flight byte reservation', () => {
  assert.equal(deliveryActorCount({}), 8);
  assert.equal(deliveryActorCount({ UC_DELIVERY_ACTORS: '16' }), 16);
  for (const value of ['0', '-1', '17', '24', '1.5', 'NaN', '16x', ''])
    assert.throws(() => deliveryActorCount({ UC_DELIVERY_ACTORS: value }));
  assert.equal(
    deliveryActorCount({ UC_DELIVERY_ACTORS: '16' }) * MAX_SINGLE_SOURCE_BYTES,
    IN_FLIGHT_ALLOWANCE_BYTES,
  );
});
test('a slow cold census supplies read-only partitions but never a write reservation', () => {
  const accountId = 'a'.repeat(32),
    now = Date.now();
  const inventory = {
    schemaVersion: 2,
    scopeVersion: SCOPE_VERSION,
    accountId,
    complete: true,
    observedAt: now - 45_001,
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
        objects: [{ key: 'first', bytes: 10 }],
      },
    ],
  };
  assert.throws(() => reserveInventory(inventory, 1, now), /Fresh complete/);
  const hints = inventoryHints(inventory);
  assert.deepEqual(hints, [{ bucket: 'media', jurisdiction: 'default', bounds: [] }]);
  assert.equal(hints[0].observedAt, undefined);
  assert.equal(hints[0].projectedBytes, undefined);
  assert.throws(() => inventoryHints({ ...inventory, jurisdictions: [] }), /coverage/);
  assert.throws(() => inventoryHints({ ...inventory, complete: false }), /Incomplete/);
  assert.throws(
    () => reserveInventory({ ...inventory, observedAt: now }, 10_000_000_000_001, now),
    /cap|budget|10/i,
  );
});
const cmp = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
function reader(keys, bounds) {
  let active = 0,
    peak = 0;
  const rows = keys.sort(cmp).map((Key, i) => ({ Key, Size: i + 1 }));
  return {
    rows,
    read: createBoundInventoryReader({
      buckets: [{ bucket: 'media', jurisdiction: 'default', bounds }],
      fetchPage: async (command) => {
        peak = Math.max(peak, ++active);
        await Promise.resolve();
        const start = command.cursor
          ? Number(command.cursor)
          : command.startAfter
            ? rows.findIndex((r) => cmp(r.Key, command.startAfter) > 0)
            : 0;
        const selected = start < 0 ? [] : rows.slice(start, start + 2),
          next = start + selected.length;
        active--;
        return {
          Contents: selected,
          IsTruncated: next < rows.length && start >= 0,
          NextContinuationToken: next < rows.length ? String(next) : undefined,
        };
      },
    }),
    peak: () => peak,
  };
}
test('complete ranges include inserted/deleted boundary keys and Unicode with bounded readers', async () => {
  const source = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'é', '🙂'];
  const bounds = inventoryBoundaries(
    source.map((key) => ({ key })),
    3,
  );
  const changed = source.filter((k) => k !== 'f').concat(['0', 'bb', 'z', 'Ω']);
  const { read, rows, peak } = reader(changed, bounds);
  const actual = await read({ bucket: 'media', jurisdiction: 'default' }, () => {
    throw Error('fallback');
  });
  assert.deepEqual(actual.Contents, rows);
  assert.equal(actual.IsTruncated, false);
  assert(peak() <= 16);
  const many = Array.from({ length: 64 }, (_, i) => `key-${String(i).padStart(3, '0')}`);
  const larger = reader(
    many,
    inventoryBoundaries(
      many.map((key) => ({ key })),
      1,
    ),
  );
  assert.deepEqual(
    (await larger.read({ bucket: 'media', jurisdiction: 'default' }, () => {})).Contents,
    larger.rows,
  );
  assert.equal(larger.peak(), 16);
  assert.throws(
    () => createBoundInventoryReader({ buckets: [], fetchPage: async () => {}, concurrency: 17 }),
    /Bounded/,
  );
});
test('unknown buckets are measured by the original complete-account transport', async () => {
  const { read } = reader(['a'], []);
  const expected = { IsTruncated: false, Contents: [{ Key: 'other', Size: 7 }] };
  assert.equal(
    await read({ bucket: 'new-bucket', jurisdiction: 'default' }, async () => expected),
    expected,
  );
});
test('looping, malformed or overlapping object inventory fails closed', async () => {
  const read = createBoundInventoryReader({
    buckets: [{ bucket: 'media', jurisdiction: 'default', bounds: [] }],
    fetchPage: async () => ({ IsTruncated: true, NextContinuationToken: 'same', Contents: [] }),
  });
  await assert.rejects(
    read({ bucket: 'media', jurisdiction: 'default' }, () => {}),
    /looping/,
  );
  const bad = createBoundInventoryReader({
    buckets: [{ bucket: 'media', jurisdiction: 'default', bounds: [] }],
    fetchPage: async () => ({
      IsTruncated: false,
      Contents: [
        { Key: 'b', Size: 1 },
        { Key: 'a', Size: 1 },
      ],
    }),
  });
  await assert.rejects(
    bad({ bucket: 'media', jurisdiction: 'default' }, () => {}),
    /unordered/,
  );
});
test('a second publisher cannot mutate a live private session before acquiring its account lock', async () => {
  const fs = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const directory = fs.mkdtempSync(join(tmpdir(), 'uc-account-lock-'));
  try {
    const revision = 'a'.repeat(40),
      job = join(directory, 'work/delivery', revision);
    fs.mkdirSync(job, { recursive: true });
    const entry = join(job, 'job-entry.mjs');
    fs.writeFileSync(entry, 'original-private-session');
    fs.writeFileSync(join(directory, '.ultraclipart-r2-writer.lock'), 'active-writer');
    const result = spawnSync(
      process.execPath,
      [new URL('../scripts/delivery/stage.mjs', import.meta.url).pathname, '/not-a-build'],
      {
        cwd: directory,
        env: {
          ...process.env,
          CF_PAGES: '1',
          CF_PAGES_COMMIT_SHA: revision,
          UC_R2_LOCK_ROOT: directory,
          UC_DELIVERY_WRITER_WAIT_MS: '20',
        },
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    assert.notEqual(result.status, 0);
    assert(result.stderr.includes('EEXIST'));
    assert(result.stderr.includes('lock was preserved'));
    assert.equal(fs.readFileSync(entry, 'utf8'), 'original-private-session');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('transient inventory failures reduce page size while 403 stops without retry', async () => {
  const { createSignedInventoryFetch } = await import('../scripts/delivery/inventory-fetch.mjs');
  const calls = [];
  const read = createSignedInventoryFetch({
    secret: 'a'.repeat(64),
    wait: async () => {},
    fetcher: async (url, init) => {
      const command = JSON.parse(init.body).command;
      calls.push(command);
      return calls.length === 1
        ? new Response('busy', { status: 503 })
        : Response.json({ IsTruncated: false, Contents: [{ Key: 'actual', Size: 9 }] });
    },
  });
  const result = await read({ bucket: 'media', jurisdiction: 'default', cursor: 'same-scope' });
  assert.deepEqual(
    calls.map((c) => c.limit),
    [1000, 500],
  );
  assert.equal(calls[1].cursor, 'same-scope');
  assert.equal(result.Contents[0].Size, 9);
  let forbidden = 0;
  const denied = createSignedInventoryFetch({
    secret: 'a'.repeat(64),
    wait: async () => {},
    fetcher: async () => {
      forbidden++;
      return new Response('denied', { status: 403 });
    },
  });
  await assert.rejects(denied({ bucket: 'media', jurisdiction: 'default' }), /refused: 403/);
  assert.equal(forbidden, 1);
});

test('saved range partitions are account-bound hints and cannot substitute for a storage reservation', () => {
  const accountId = 'a'.repeat(32),
    hints = {
      accountId,
      hintOnly: true,
      buckets: [{ bucket: 'media', jurisdiction: 'default', bounds: ['first', 'last'] }],
    };
  const value = readOnlyRangeHints(hints, accountId, 'media');
  assert.deepEqual(value, hints.buckets);
  assert.equal(value.observedAt, undefined);
  assert.throws(() => reserveInventory(value, 1), /scope/);
  for (const input of [
    { ...hints, hintOnly: false },
    { ...hints, accountId: 'b'.repeat(32) },
    { ...hints, buckets: [] },
    { ...hints, buckets: [...hints.buckets, ...hints.buckets] },
    { ...hints, buckets: [{ ...hints.buckets[0], bounds: ['last', 'first'] }] },
  ])
    assert.throws(() => readOnlyRangeHints(input, accountId, 'media'));
});
