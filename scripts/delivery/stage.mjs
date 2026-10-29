import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  appendFileSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes, createHmac } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { collectDeliveryFiles, merkle } from './manifest.mjs';
import { measureReservation } from './storage-reservation.mjs';
import { freshBindingReservation } from '../r2/binding-reservation.mjs';
import { releaseRevision } from '../release-revision.mjs';
import { createSignedInventoryFetch } from './inventory-fetch.mjs';
import { createBoundInventoryReader, readOnlyRangeHints } from './inventory-reader.mjs';
import { awaitAccountWriter } from './account-lock.mjs';
import { encodeLocalBatch, preferLocalStageSource } from './local-batch.mjs';
import {
  deliveryActorCount,
  inventoryPageCount,
  IN_FLIGHT_ALLOWANCE_BYTES,
} from './staging-limits.mjs';
const root = process.cwd(),
  dist = resolve(process.argv[2] ?? 'dist'),
  revision = releaseRevision(),
  actors = deliveryActorCount();
if (revision === 'local') throw Error('Production revision required');
async function main() {
  const releaseLock = await awaitAccountWriter(process.env, {
    timeoutMs: Number(process.env.UC_DELIVERY_WRITER_WAIT_MS ?? 3_600_000),
    notify: console.log,
  });
  try {
    const allFiles = collectDeliveryFiles(dist, revision),
      tree = merkle(allFiles);
    const accountId = '48c779c8eaa80234e0bb9d57f96e588b',
      bucket = 'ultraclipart-pages';
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
    }).trim();
    const lockPath = join(resolve(common), 'ultraclipart-r2-writer.lock');
    const work = join(root, 'work/delivery', revision);
    mkdirSync(work, { recursive: true });
    const journalPath = join(work, 'verified.jsonl'),
      manifestPath = join(work, 'verified-manifest.json');
    const done = new Map();
    try {
      for (const line of readFileSync(journalPath, 'utf8').trim().split('\n')) {
        const row = JSON.parse(line);
        if (row.root === tree.root) done.set(row.path, row);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const records = allFiles.map((record, index) => ({ record, proof: tree.proof(index) }));
    let remaining = records.filter(({ record }) => {
      const old = done.get(record.path);
      return (
        !old || old.sha256 !== record.sha256 || old.bytes !== record.bytes || old.key !== record.key
      );
    });
    remaining.sort(
      (a, b) =>
        Number(b.record.path.startsWith('/previews/')) -
        Number(a.record.path.startsWith('/previews/')),
    );
    const secret = randomBytes(32).toString('hex');
    const inventoryBuckets = [];
    const sourceOrigin = process.env.UC_DELIVERY_SOURCE_ORIGIN ?? 'https://ultraclipart.com';
    if (
      sourceOrigin !== 'https://ultraclipart.com' &&
      !/^https:\/\/[a-f0-9]{8}\.ultraclipart\.pages\.dev$/.test(sourceOrigin)
    )
      throw Error('Only the site or a pinned Pages deployment may supply immutable sources');
    const job = {
      root: tree.root,
      revision,
      accountId,
      bucket,
      secret,
      sourceOrigin,
      inventoryBuckets,
      inventoryPages: inventoryPageCount(),
    };
    writeFileSync(
      join(work, 'job-entry.mjs'),
      `import {stagingWorker} from ${JSON.stringify(join(root, 'scripts/delivery/staging-worker.mjs'))};export default stagingWorker(${JSON.stringify(job)});\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      join(work, 'wrangler.json'),
      JSON.stringify({
        name: 'ultraclipart-private-migration',
        main: 'job-entry.mjs',
        compatibility_date: '2026-10-23',
        account_id: accountId,
        r2_buckets: [{ binding: 'TARGET', bucket_name: bucket, preview_bucket_name: bucket }],
      }),
    );
    let child,
      output,
      lease,
      leasePromise,
      cursor = 0,
      completed = done.size,
      nextProgress = (Math.floor(done.size / 200) + 1) * 200,
      failed = false,
      remoteReady = false,
      knownKeys;
    async function reservation(force = false) {
      if (!force && lease && Date.now() - lease.observedAt < 40_000) return lease;
      if (!leasePromise)
        leasePromise = (async () => {
          const unverified =
            remaining.slice(cursor).reduce((sum, x) => sum + x.record.bytes, 0) +
            IN_FLIGHT_ALLOWANCE_BYTES;
          const measuredStartedAt = Date.now();
          const measure = () => measureReservation(
            accountId,
            unverified,
            remoteReady
              ? createBoundInventoryReader({
                  buckets: inventoryBuckets,
                  fetchPage: createSignedInventoryFetch({ secret }),
                })
              : undefined,
            (inventory) => {
              const target = inventory.buckets.find(
                (b) => b.name === bucket && b.jurisdiction === 'default',
              );
              if (!target) throw Error('Existing target bucket is missing');
              knownKeys = new Set(target.objects.map((o) => o.key));
            },
          );
          const updateRanges = (roster) => {
            for (const current of inventoryBuckets) {
              const fresh = roster.find(
                (b) => b.bucket === current.bucket && b.jurisdiction === current.jurisdiction,
              );
              if (fresh) current.bounds = fresh.bounds;
            }
          };
          // An occasional slow complete census grants no write lease. Rebalance
          // only its read-only ranges and repeat a full measurement, at most twice.
          // Denied scopes, malformed inventories and capacity errors still stop.
          const measured = remoteReady
            ? await freshBindingReservation(measure, {
                onStale: (roster) => {
                  updateRanges(roster);
                  console.log('Slow complete census: read-only ranges refreshed; repeating the full measurement without granting a write lease.');
                },
              })
            : await measure();
          updateRanges(measured.roster);
          lease = { ...measured, root: tree.root, bucket };
          console.log(
            `Fresh account reservation: ${lease.measuredBytes} + ${lease.additionalBytes} bytes; complete measurement ${Date.now() - measuredStartedAt} ms`,
          );
          return lease;
        })().finally(() => (leasePromise = undefined));
      return leasePromise;
    }
    try {
      let bindings;
      if (process.env.UC_DELIVERY_INVENTORY_HINTS) {
        const hintPath = resolve(process.env.UC_DELIVERY_INVENTORY_HINTS);
        if (!hintPath.startsWith(root + '/'))
          throw Error('Inventory hints must remain inside the project');
        bindings = readOnlyRangeHints(
          JSON.parse(readFileSync(hintPath, 'utf8')),
          accountId,
          bucket,
        );
        console.log(
          'Prior complete-census ranges are read-only hints; fresh complete coverage is still required before staging.',
        );
      }
      if (!bindings) {
        try {
          bindings = (await reservation()).roster;
        } catch (error) {
          if (!Array.isArray(error.readOnlyInventoryHints)) throw error;
          bindings = error.readOnlyInventoryHints;
          console.log('Slow cold census: bootstrapping read-only inventory; no write lease issued');
        }
      }
      inventoryBuckets.push(
        ...bindings
          .filter((b) => b.jurisdiction === 'default')
          .map((b, index) => ({
            ...b,
            binding: b.bucket === bucket ? 'TARGET' : `INVENTORY_${index}`,
          })),
      );
      writeFileSync(
        join(work, 'job-entry.mjs'),
        `import {stagingWorker} from ${JSON.stringify(join(root, 'scripts/delivery/staging-worker.mjs'))};export default stagingWorker(${JSON.stringify(job)});\n`,
        { mode: 0o600 },
      );
      const config = JSON.parse(readFileSync(join(work, 'wrangler.json'), 'utf8'));
      config.r2_buckets = inventoryBuckets.map((b) => ({
        binding: b.binding,
        bucket_name: b.bucket,
        preview_bucket_name: b.bucket,
      }));
      writeFileSync(join(work, 'wrangler.json'), JSON.stringify(config));
      output = openSync(join(work, 'private-session.log'), 'a', 0o600);
      child = spawn(
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
          join(work, 'wrangler.json'),
          '--show-interactive-dev-session=false',
        ],
        {
          cwd: root,
          env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
          stdio: ['ignore', output, output],
        },
      );
      child.on('error', () => {
        failed = true;
      });
      let ready = false;
      for (let attempt = 0; attempt < 90; attempt++) {
        if (child.exitCode !== null || failed)
          throw Error('Private remote staging session failed; inspect local redacted diagnostics');
        try {
          const response = await fetch('http://127.0.0.1:8899/health', {
            signal: AbortSignal.timeout(2000),
          });
          const data = await response.json();
          if (data.root === tree.root) {
            ready = true;
            break;
          }
        } catch {}
        await wait(1000);
      }
      if (!ready) throw Error('Private remote staging session did not become ready');
      remoteReady = true;
      // A slow REST census cannot authorize a write. Re-read the full live
      // roster and every object through the bounded remote reader first.
      await reservation(true);
      console.log(
        `Private staging ready: ${remaining.length} remaining of ${allFiles.length}, root ${tree.root}`,
      );
      async function transfer(batch, local = false, leaseRetries = 0) {
        const current = await reservation();
        const { roster: _partitionHints, ...writeLease } = current;
        const body = {
          lease: writeLease,
          signature: createHmac('sha256', Buffer.from(secret, 'hex'))
            .update(JSON.stringify(writeLease))
            .digest('hex'),
          records: batch,
        };
        const serialized = JSON.stringify(body),
          encoded = local ? encodeLocalBatch(dist, body) : serialized;
        let last;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response = await fetch('http://127.0.0.1:8899/stage', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(local ? { 'X-UC-Body-Encoding': 'gzip' } : {}),
              },
              body: encoded,
              signal: AbortSignal.timeout(90_000),
            });
            if (response.status === 409) {
              await response.body.cancel();
              if (leaseRetries >= 3)
                throw Object.assign(Error('Fresh storage lease could not be acquired in time'), {
                  permanent: true,
                });
              await reservation(true);
              return transfer(batch, local, leaseRetries + 1);
            }
            if (!response.ok) {
              const detail = (await response.text()).slice(0, 500);
              if ([400, 401, 403, 413].includes(response.status))
                throw Object.assign(Error(`Staging refused: ${response.status}`), {
                  permanent: true,
                });
              throw Error(`Staging HTTP ${response.status}: ${detail}`);
            }
            const result = await response.json();
            if (result.root !== tree.root || result.verified?.length !== batch.length)
              throw Error('Invalid verification receipt');
            for (const { record } of batch) {
              const row = result.verified.find((v) => v.path === record.path);
              if (
                !row ||
                row.key !== record.key ||
                row.bytes !== record.bytes ||
                row.sha256 !== record.sha256
              )
                throw Error('Remote verification receipt differs');
              appendFileSync(
                journalPath,
                JSON.stringify({ ...row, root: tree.root, at: new Date().toISOString() }) + '\n',
              );
              done.set(row.path, row);
              completed++;
            }
            if (completed >= nextProgress || completed === allFiles.length) {
              while (nextProgress <= completed) nextProgress += 200;
              console.log(JSON.stringify({ verified: completed, total: allFiles.length }));
            }
            return;
          } catch (error) {
            if (error.permanent) throw error;
            last = error;
            if (attempt < 2) await wait(1000 * (attempt + 1));
          }
        }
        // A source not yet published, or changed CDN bytes, can only be replaced by
        // this exact reviewed local source. The Merkle proof and readback still apply.
        if (!local) {
          if (batch.length === 1) return transfer(batch, true);
          for (const record of batch) await transfer([record], true);
          return;
        }
        throw last;
      }
      if (process.env.UC_DELIVERY_PROBE_GZIP === '1') {
        const index = remaining.findLastIndex((x) => x.record.path.startsWith('/art/'));
        if (index >= 0) {
          const [probe] = remaining.splice(index, 1);
          await transfer([probe], true);
          console.log('PASS_PRIVATE_GZIP_RAW_SHA_AND_R2_READBACK');
        }
      }
      await Promise.allSettled(
        Array.from({ length: actors }, async () => {
          while (cursor < remaining.length && !failed) {
            const batch = [];
            const localGroup = preferLocalStageSource(remaining[cursor].record, knownKeys);
            // The byte limit and actor cap still bound the in-flight release
            // bytes. Larger groups make useful progress during each fresh
            // account-inventory lease without changing proofs or readback.
            const itemLimit = 64,
              byteLimit = 4_000_000;
            let groupBytes = 0;
            while (
              cursor < remaining.length &&
              batch.length < itemLimit &&
              (batch.length === 0 ||
                preferLocalStageSource(remaining[cursor].record, knownKeys) === localGroup) &&
              (batch.length === 0 || groupBytes + remaining[cursor].record.bytes <= byteLimit)
            ) {
              const row = remaining[cursor++];
              batch.push(row);
              groupBytes += row.record.bytes;
            }
            try {
              await transfer(batch, localGroup);
            } catch (error) {
              failed = true;
              throw error;
            }
          }
        }),
      ).then((results) => {
        const bad = results.find((r) => r.status === 'rejected');
        if (bad) throw bad.reason;
      });
      if (
        done.size !== allFiles.length ||
        allFiles.some((record) => done.get(record.path)?.sha256 !== record.sha256)
      )
        throw Error('Incomplete delivery verification');
      writeFileSync(
        manifestPath,
        JSON.stringify({
          schema: 1,
          status: 'remote-byte-verified',
          revision,
          bucket,
          root: tree.root,
          verified: allFiles.length,
          files: allFiles,
          at: new Date().toISOString(),
        }) + '\n',
      );
      console.log(`Verified delivery manifest: ${manifestPath}`);
    } finally {
      if (child) {
        child.kill('SIGTERM');
        await Promise.race([new Promise((resolve) => child.once('exit', resolve)), wait(5000)]);
      }
      if (output !== undefined) closeSync(output);
    }
  } finally {
    releaseLock();
  }
}
await main();
