import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openNativeInventorySession } from '../scripts/r2/native-inventory-session.mjs';
import { JURISDICTIONS, SCOPE_VERSION, endpointFor } from '../scripts/r2/inventory.mjs';
import { bootstrapInventoryHints } from '../scripts/r2/inventory-bootstrap.mjs';
import { reserveInventory } from '../scripts/delivery/storage-reservation.mjs';

test('old journal can provide hints but never a fresh reservation', () => {
  const accountId = 'a'.repeat(32),
    now = Date.now();
  const scope = {
    accountId,
    scopeVersion: SCOPE_VERSION,
    observedAt: now - 60_000,
    jurisdictions: JURISDICTIONS.map((jurisdiction) => ({
      jurisdiction,
      endpoint: endpointFor(accountId, jurisdiction),
      complete: true,
      buckets: jurisdiction === 'default' ? ['media'] : [],
      proof: { source: 's3-list-buckets' },
    })),
  };
  const hints = bootstrapInventoryHints({ inventoryScope: scope }, accountId, [
    { bucket: 'media', key: 'a' },
    { bucket: 'media', key: 'a' },
    { bucket: 'media', key: 'b' },
  ]);
  assert.equal(hints.hintOnly, true);
  assert.equal(hints.complete, undefined);
  assert.throws(() => reserveInventory(hints, 1, now), /scope|coverage|inventory/i);
  assert.throws(
    () => bootstrapInventoryHints({ inventoryScope: scope }, 'b'.repeat(32)),
    /another account/,
  );
  assert.throws(
    () => bootstrapInventoryHints({ inventoryScope: { ...scope, jurisdictions: [] } }, accountId),
    /coverage/,
  );
});

test('slow inventory bootstrap is read-only, signed, bounded and cleans up', async () => {
  const accountId = 'a'.repeat(32);
  const inventory = {
    schemaVersion: 2,
    scopeVersion: SCOPE_VERSION,
    accountId,
    complete: true,
    observedAt: Date.now() - 60_000,
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
        objects: [{ key: 'a', bytes: 10 }],
      },
    ],
  };
  let job, entry, child;
  const spawnProcess = (_binary, args) => {
    const config = JSON.parse(readFileSync(args[args.indexOf('--config') + 1]));
    entry = config.main;
    const source = readFileSync(entry, 'utf8');
    job = JSON.parse(source.match(/nativeInventoryWorker\((.*)\);/)[1]);
    assert.equal(config.r2_buckets.length, 1);
    child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal) => {
      child.signalCode = signal;
      queueMicrotask(() => child.emit('exit'));
    };
    return child;
  };
  const fetcher = async (url, options = {}) => {
    if (url.endsWith('/health')) return Response.json({ root: job.root });
    const { command, signature } = JSON.parse(options.body);
    assert.equal(
      signature,
      createHmac('sha256', Buffer.from(job.secret, 'hex'))
        .update(JSON.stringify(command))
        .digest('hex'),
    );
    assert.equal(command.bucket, 'media');
    return Response.json({
      IsTruncated: false,
      ...(command.treeRead ? { CommonPrefixes: [] } : {}),
      Contents: [
        { Key: 'a', Size: 10 },
        { Key: 'b', Size: 20 },
      ],
    });
  };
  const session = await openNativeInventorySession(inventory, { spawnProcess, fetcher });
  const worker = (await import(pathToFileURL(entry).href)).default;
  assert.equal((await worker.fetch(new Request('http://localhost/stage'), {})).status, 404);
  const command = { action: 'list', bucket: 'media', jurisdiction: 'default', at: Date.now() };
  const signature = createHmac('sha256', Buffer.from(job.secret, 'hex'))
    .update(JSON.stringify(command))
    .digest('hex');
  const actual = await worker.fetch(
    new Request('http://localhost/inventory', {
      method: 'POST',
      body: JSON.stringify({ command, signature }),
    }),
    {
      INVENTORY_0: {
        list: async () => ({
          objects: [{ key: 'a', size: 10, etag: 'r2-version' }],
          truncated: false,
        }),
      },
    },
  );
  assert.deepEqual((await actual.json()).Contents, [{ Key: 'a', Size: 10, ETag: 'r2-version' }]);
  assert.deepEqual(
    (
      await session.read({ bucket: 'media', jurisdiction: 'default' }, () => {
        throw Error('fallback');
      })
    ).Contents,
    [
      { Key: 'a', Size: 10 },
      { Key: 'b', Size: 20 },
    ],
  );
  assert.equal(
    await session.read({ bucket: 'new', jurisdiction: 'default' }, async () => 'fallback'),
    'fallback',
  );
  session.update(inventory);
  await session.close();
  assert.equal(child.signalCode, 'SIGTERM');
  assert.equal(existsSync(entry), false);
});
