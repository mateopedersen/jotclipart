import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inventoryHints } from '../delivery/storage-reservation.mjs';
import { createBoundInventoryReader } from '../delivery/inventory-reader.mjs';
import { createSignedInventoryFetch } from '../delivery/inventory-fetch.mjs';

// A stale *complete* census supplies range hints and bindings only. It cannot
// authorize a write: every reservation still performs a fresh full census.
export async function openNativeInventorySession(
  inventory,
  { spawnProcess = spawn, fetcher = fetch } = {},
) {
  const root = process.cwd(),
    dir = mkdtempSync(join(tmpdir(), 'uc-native-inventory-'));
  const secret = randomBytes(32).toString('hex'),
    marker = randomBytes(32).toString('hex');
  const hintBuckets = inventory.hintOnly === true ? inventory.buckets : inventoryHints(inventory);
  const buckets = hintBuckets
    .filter((b) => b.jurisdiction === 'default')
    .map((b, i) => ({ ...b, binding: `INVENTORY_${i}` }));
  const job = {
    root: marker,
    revision: 'inventory-only',
    accountId: inventory.accountId,
    bucket: '',
    secret,
    sourceOrigin: 'https://ultraclipart.com',
    inventoryBuckets: buckets,
    inventoryPages: 4,
  };
  const entry = join(dir, 'entry.mjs'),
    config = join(dir, 'wrangler.json');
  const worker = resolve(root, 'scripts/r2/native-inventory-worker.mjs');
  writeFileSync(
    entry,
    `import {nativeInventoryWorker} from ${JSON.stringify(worker)};\nexport default nativeInventoryWorker(${JSON.stringify(job)});\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    config,
    JSON.stringify({
      name: 'ultraclipart-private-inventory',
      main: entry,
      compatibility_date: '2026-10-23',
      account_id: inventory.accountId,
      r2_buckets: buckets.map((b) => ({
        binding: b.binding,
        bucket_name: b.bucket,
        preview_bucket_name: b.bucket,
      })),
    }),
    { mode: 0o600 },
  );
  const child = spawnProcess(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'dev',
      '--remote',
      '--ip',
      '127.0.0.1',
      '--port',
      '8899',
      '--config',
      config,
      '--show-interactive-dev-session=false',
    ],
    {
      cwd: root,
      env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
      stdio: 'ignore',
    },
  );
  let failed = false;
  child.on('error', () => {
    failed = true;
  });
  async function close() {
    if (child.exitCode === null && child.signalCode === null && !failed) {
      child.kill('SIGTERM');
      await Promise.race([new Promise((done) => child.once('exit', done)), delay(5000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await Promise.race([new Promise((done) => child.once('exit', done)), delay(5000)]);
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
  try {
    let ready = false;
    for (let i = 0; i < 90; i++) {
      if (failed || child.exitCode !== null || child.signalCode !== null)
        throw Error('Private inventory session failed');
      try {
        const response = await fetcher('http://127.0.0.1:8899/health', {
          signal: AbortSignal.timeout(2000),
        });
        if ((await response.json()).root === marker) {
          ready = true;
          break;
        }
      } catch {}
      await delay(1000);
    }
    if (!ready) throw Error('Private inventory session did not become ready');
    const reader = createBoundInventoryReader({
      buckets,
      fetchPage: createSignedInventoryFetch({ secret, fetcher }),
    });
    return {
      read: reader,
      owns(bucket, jurisdiction) {
        return buckets.some((item) => item.bucket === bucket && item.jurisdiction === jurisdiction);
      },
      update(fresh) {
        for (const hint of inventoryHints(fresh)) {
          const existing = buckets.find(
            (b) => b.bucket === hint.bucket && b.jurisdiction === hint.jurisdiction,
          );
          if (existing) existing.bounds = hint.bounds;
        }
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
