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
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { merkle } from '../delivery/manifest.mjs';
import { reviewedBindingInput } from './reviewed-binding-input.mjs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { measureReservation } from '../delivery/storage-reservation.mjs';
import { bootstrapInventoryHints } from './inventory-bootstrap.mjs';
import { freshBindingReservation } from './binding-reservation.mjs';
import { createSignedInventoryFetch } from '../delivery/inventory-fetch.mjs';
import { createBoundInventoryReader, readOnlyRangeHints } from '../delivery/inventory-reader.mjs';
import { acquireAccountWriter } from '../delivery/account-lock.mjs';
import { verifyExistingFiles } from '../delivery/verification-batch.mjs';
import { completeMediaWaveJournals } from './binding-waves.mjs';
import { createReservationPrefetch } from './reservation-prefetch.mjs';
import {
  deliveryActorCount,
  inventoryPageCount,
  IN_FLIGHT_ALLOWANCE_BYTES,
} from '../delivery/staging-limits.mjs';
const args = process.argv.slice(2);
if (!args[0] || args.includes('--help')) {
  console.log('node scripts/r2/binding-ingest.mjs reviewed-input.json [--check|--pilot]');
  process.exit(args.includes('--help') ? 0 : 1);
}
if (args.slice(1).some((a) => !['--check', '--pilot'].includes(a)))
  throw Error('Unknown binding ingest option');
const root = process.cwd(),
  dist = resolve('public'),
  input = reviewedBindingInput(resolve(args[0])),
  pilot = args.includes('--pilot');
if (args.includes('--check')) {
  console.log(
    JSON.stringify({
      status: 'REVIEWED_BINDING_INPUT_VALID',
      artworks: input.added.length,
      waves: input.waves.length,
      files: input.records.length,
      remoteWrites: 0,
    }),
  );
  process.exit(0);
}
const selected = pilot ? input.records.filter((r) => r.wave === input.waves.length) : input.records;
const revision = createHash('sha256').update(JSON.stringify(selected)).digest('hex').slice(0, 40),
  actors = deliveryActorCount();
process.env.WRANGLER_AUTH_FILE ??=
  '/Users/melihozcan/Library/Preferences/.wrangler/config/default.toml';
async function main() {
  const releaseLock = acquireAccountWriter();
  try {
    const allFiles = selected,
      tree = merkle(allFiles);
    const accountId = '48c779c8eaa80234e0bb9d57f96e588b',
      bucket = 'ultraclipart-media';
    const work = join(root, 'work/r2-binding', revision);
    mkdirSync(work, { recursive: true });
    const journalPath = join(work, 'verified.jsonl'),
      manifestPath = join(work, 'verified-manifest.json');
    // A resumed process independently reads every object again, including prior receipts.
    const done = new Map(),
      records = allFiles.map((record, index) => ({ record, proof: tree.proof(index) }));
    let remaining = records;
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
      media: true,
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
      snapshot;
    // The next census is only a read. Each actual write continues to require
    // a complete, fresh, signed reservation; the pending-byte allowance also
    // covers all (at most 16) in-flight sources when a census starts.
    const prefetch = createReservationPrefetch({
      refresh: () => reservation(true),
      current: () => lease,
      canPrefetch: () => remoteReady && !failed && cursor < remaining.length,
      onError: () => console.log('Background inventory read failed; a fresh census will be required before writing.'),
    });
    async function reservation(force = false) {
      if (!force && lease && Date.now() - lease.observedAt < 40_000) return lease;
      if (!leasePromise)
        leasePromise = (async () => {
          const unverified =
            remaining.slice(cursor).reduce((sum, x) => sum + x.record.bytes, 0) +
            IN_FLIGHT_ALLOWANCE_BYTES;
          const measuredStartedAt = Date.now();
          const measure = () =>
            measureReservation(
              accountId,
              unverified,
              remoteReady
                ? createBoundInventoryReader({
                    buckets: inventoryBuckets,
                    fetchPage: createSignedInventoryFetch({ secret }),
                  })
                : undefined,
              (inventory) => {
                snapshot = inventory;
              },
            );
          const updateRanges = (hints) => {
            for (const current of inventoryBuckets) {
              const fresh = hints.find(
                (b) => b.bucket === current.bucket && b.jurisdiction === current.jurisdiction,
              );
              if (fresh) current.bounds = fresh.bounds;
            }
          };
          const measured = remoteReady
            ? await freshBindingReservation(measure, { onStale: updateRanges })
            : await measure();
          for (const current of inventoryBuckets) {
            const fresh = measured.roster.find(
              (b) => b.bucket === current.bucket && b.jurisdiction === current.jurisdiction,
            );
            if (fresh) current.bounds = fresh.bounds;
          }
          writeFileSync(
            join(work, 'inventory-hints.json'),
            JSON.stringify({ accountId, hintOnly: true, buckets: measured.roster }) + '\n',
          );
          lease = { ...measured, root: tree.root, bucket };
          console.log(
            `Fresh account reservation: ${lease.measuredBytes} + ${lease.additionalBytes} bytes; complete measurement ${Date.now() - measuredStartedAt} ms`,
          );
          return lease;
        })().finally(() => (leasePromise = undefined));
      const result = await leasePromise;
      prefetch.schedule();
      return result;
    }
    try {
      let bindings;
      if (input.descriptor.inventoryHintBuckets) {
        const hintsFile = resolve(input.descriptor.inventoryHintBuckets);
        assert(hintsFile.startsWith(root + '/'));
        const hints = JSON.parse(readFileSync(hintsFile, 'utf8'));
        bindings = readOnlyRangeHints(hints, accountId, bucket);
        console.log(
          'Prior complete-census ranges are read-only hints; a fresh complete account measurement remains mandatory.',
        );
      }
      if (!bindings && input.descriptor.inventoryHintJournal) {
        const hintFile = resolve(input.descriptor.inventoryHintJournal);
        assert(hintFile.startsWith(root + '/'));
        const previous = JSON.parse(readFileSync(hintFile, 'utf8'));
        const known = input.records.map((r) => ({ bucket, key: r.key }));
        for (const file of JSON.parse(readFileSync('data/publication.json', 'utf8')).files) {
          const url = new URL(file.url);
          if (url.hostname === 'assets.ultraclipart.com')
            known.push({ bucket, key: decodeURIComponent(url.pathname.slice(1)) });
        }
        if (input.descriptor.inventoryKnownManifest) {
          const manifestFile = resolve(input.descriptor.inventoryKnownManifest);
          assert(manifestFile.startsWith(root + '/'));
          const prior = JSON.parse(readFileSync(manifestFile, 'utf8'));
          assert.equal(prior.status, 'remote-byte-verified');
          for (const file of prior.files) known.push({ bucket: prior.bucket, key: file.key });
        }
        bindings = bootstrapInventoryHints(previous, accountId, known).buckets;
        console.log(
          'Prior keys supply read-only partition hints; no write reservation issued until a fresh complete account census.',
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
      // Read existing objects through the authenticated, read-only endpoint.
      // Every body is independently hashed against this exact release root.
      // A missing object is only queued here; this path can never write it.
      const verificationStartedAt = new Date().toISOString();
      remaining = await verifyExistingFiles(records, {
        root: tree.root,
        accountId,
        bucket,
        secret,
        actors,
        onVerified: (row) => {
          assert(!done.has(row.path), 'Duplicate independently verified object');
          appendFileSync(
            journalPath,
            JSON.stringify({ ...row, root: tree.root, at: new Date().toISOString(), transport: 'fresh-read-only-full-body-sha256' }) + '\n',
          );
          done.set(row.path, row);
          completed++;
        },
      });
      const initiallyMissing = new Set(remaining.map(({ record }) => record.path));
      console.log(JSON.stringify({ readOnlyVerified: done.size, missingForFreshReservedWrite: remaining.length, total: allFiles.length }));
      nextProgress = (Math.floor(completed / 200) + 1) * 200;
      // Read-only verification cannot authorize a write. Re-read the complete
      // account roster and current objects before issuing any staging lease.
      await reservation(true);
      console.log(
        `Private staging ready: ${remaining.length} remaining of ${allFiles.length}, root ${tree.root}`,
      );
      async function transfer(batch, local = false, leaseRetries = 0) {
        const current = await reservation();
        const { roster: _partitionHints, inventoryScope: _scopeEvidence, ...writeLease } = current;
        const body = {
          lease: writeLease,
          signature: createHmac('sha256', Buffer.from(secret, 'hex'))
            .update(JSON.stringify(writeLease))
            .digest('hex'),
          records: batch,
        };
        assert.equal(batch.length, 1, 'One exact raw source per invocation');
        const serialized = JSON.stringify(body),
          encoded = readFileSync(join(dist, batch[0].record.path));
        assert(serialized.length <= 16000);
        assert.equal(encoded.length, batch[0].record.bytes);
        let last;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response = await fetch('http://127.0.0.1:8899/stage', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/octet-stream',
                'X-UC-Stage-Metadata': serialized,
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
      for (const wave of [...new Set(records.map((x) => x.record.wave))]) {
        const end = remaining.findLastIndex((x) => x.record.wave === wave) + 1;
        const results = await Promise.allSettled(
          Array.from({ length: actors }, async () => {
            while (cursor < end && !failed) {
              const row = remaining[cursor++];
              try {
                await transfer([row], true);
              } catch (e) {
                failed = true;
                throw e;
              }
            }
          }),
        );
        const failure = results.find((r) => r.status === 'rejected');
        if (failure) throw failure.reason;
        console.log(JSON.stringify({ transferredWave: wave, verified: done.size, total: allFiles.length, pilot, finalInventoryPending: true }));
      }
      if (
        done.size !== allFiles.length ||
        allFiles.some((record) => done.get(record.path)?.sha256 !== record.sha256)
      )
        throw Error('Incomplete delivery verification');
      // Every write already used a fresh signed capacity reservation and its
      // own full-body readback. One fresh complete post-transfer census now
      // confirms all waves before any final wave journal can be created.
      // A speculative census may have started while writes were still in
      // flight. Finish it and then measure again for final evidence.
      await prefetch.stop();
      await reservation(true);
      const selectedWaves = input.waves.filter((wave) => records.some(({ record }) => record.wave === wave.number));
      const journals = completeMediaWaveJournals({ records, waves: selectedWaves, done, snapshot, lease, missing: initiallyMissing, startedAt: verificationStartedAt, completedAt: new Date().toISOString() });
      for (const [index, journal] of journals.entries()) {
        const wave = selectedWaves[index].number;
        writeFileSync(join(work, `wave-${String(wave).padStart(2, '0')}.journal.json`), JSON.stringify(journal, null, 2) + '\n');
      }
      console.log(JSON.stringify({ finalCompleteInventoryVerified: true, journaledWaves: journals.length, verified: done.size }));
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
      console.log(`Verified media manifest: ${manifestPath}`);
      writeFileSync(
        resolve(process.argv[2]) + (pilot ? '.pilot-complete.json' : '.binding-complete.json'),
        JSON.stringify({
          status: pilot ? 'PILOT_BYTE_VERIFIED' : 'ALL_REVIEWED_MEDIA_BINDING_BYTE_VERIFIED',
          work,
          manifestPath,
          root: tree.root,
          verified: allFiles.length,
          completedAt: new Date().toISOString(),
        }) + '\n',
      );
    } finally {
      await prefetch.stop();
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
