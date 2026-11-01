import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  openSync,
  closeSync,
  fchmodSync,
  unlinkSync,
  appendFileSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes, createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { collectDeliveryFiles, merkle } from './manifest.mjs';
import { releaseRevision } from '../release-revision.mjs';
import { awaitAccountWriter } from './account-lock.mjs';
import { prepareLocalStagePayload, preferLocalStageSource } from './local-batch.mjs';
import {
  splitVerificationPhase,
  verifyExistingFiles,
  validateVerificationReceipt,
} from './verification-batch.mjs';
import { verifiedReuse } from './verified-reuse.mjs';
import { readIncrementalPlan, incrementalCollectionOptions } from './incremental.mjs';
import { deliveryActorCount } from './staging-limits.mjs';
import { stopPrivateSession } from './private-session.mjs';
import {
  OWNER_MANAGED_STORAGE_POLICY,
  createReleaseWriteAuthorization,
} from './release-write-authorization.mjs';
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
  let releaseAllowed = true;
  try {
    const incrementalPlan = readIncrementalPlan(root);
    const allFiles = collectDeliveryFiles(
        dist,
        revision,
        incrementalCollectionOptions(root, incrementalPlan),
      ),
      tree = merkle(allFiles);
    const accountId = '48c779c8eaa80234e0bb9d57f96e588b',
      bucket = 'ultraclipart-pages';
    const work = join(root, 'work/delivery', revision);
    mkdirSync(work, { recursive: true });
    const journalPath = join(work, 'verified.jsonl'),
      manifestPath = join(work, 'verified-manifest.json');
    // Old candidate journals describe earlier reads, not current R2 state.
    // Recheck every manifest entry on resume; accepted predecessor proofs can
    // avoid rereading unchanged bodies only after a current matching R2 ETag.
    const done = new Map();
    const records = allFiles.map((record, index) => ({ record, proof: tree.proof(index) }));
    const reuse = await verifiedReuse(root, records);
    let remaining = [...records];
    remaining.sort(
      (a, b) =>
        Number(b.record.path.startsWith('/previews/')) -
        Number(a.record.path.startsWith('/previews/')),
    );
    const secret = randomBytes(32).toString('hex');
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
      storagePolicy: OWNER_MANAGED_STORAGE_POLICY,
      authorizedBytes: allFiles.reduce((sum, file) => sum + file.bytes, 0),
      reuseRoot: reuse.root,
    };
    // Validate the exact reviewed scope before opening a private remote session.
    createReleaseWriteAuthorization(job);
    const entryPath = join(work, 'job-entry.mjs');
    const entryFd = openSync(entryPath, 'w', 0o600);
    try {
      // Opening an existing path does not apply its creation mode.
      fchmodSync(entryFd, 0o600);
      writeFileSync(
        entryFd,
        `import {stagingWorker} from ${JSON.stringify(join(root, 'scripts/delivery/staging-worker.mjs'))};export default stagingWorker(${JSON.stringify(job)});\n`,
      );
    } finally {
      closeSync(entryFd);
    }
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
      cursor = 0,
      completed = done.size,
      nextProgress = (Math.floor(done.size / 200) + 1) * 200,
      failed = false,
      knownKeys;
    function recordVerified(row) {
      const prior = done.get(row.path);
      if (prior?.sha256 === row.sha256 && prior.key === row.key && prior.bytes === row.bytes)
        return;
      appendFileSync(
        journalPath,
        JSON.stringify({ ...row, root: tree.root, at: new Date().toISOString() }) + '\n',
      );
      done.set(row.path, row);
      if (!prior) completed++;
      if (completed >= nextProgress || completed === allFiles.length) {
        while (nextProgress <= completed) nextProgress += 200;
        console.log(JSON.stringify({ verified: completed, total: allFiles.length }));
      }
    }
    function reservation() {
      // Fresh authentication is bound to this release, never an account-size estimate.
      return createReleaseWriteAuthorization(job);
    }
    try {
      output = openSync(join(work, 'private-session.log'), 'a', 0o600);
      fchmodSync(output, 0o600);
      releaseAllowed = false;
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
      // Reads allocate no storage. Independently hash the shared assets without
      // granting a write lease or repeatedly measuring account capacity. Missing
      // files alone join the ordinary release-scoped conditional-write path below.
      if (process.env.UC_DELIVERY_VERIFY_EXISTING !== '0') {
        const { existingCandidates, writes } = splitVerificationPhase(remaining, revision);
        const missing = await verifyExistingFiles(existingCandidates, {
          actors,
          root: tree.root,
          accountId,
          bucket,
          secret,
          onVerified: recordVerified,
          attachPrior: reuse.attach,
        });
        remaining = [...missing, ...writes];
        console.log(
          `Read-only verification: ${existingCandidates.length - missing.length} existing files verified; ${remaining.length} files require release-scoped staging.`,
        );
      }
      // Each write authenticates this exact release independently of read-only receipts.
      console.log(
        `Private staging ready: ${remaining.length} remaining of ${allFiles.length}, root ${tree.root}`,
      );
      async function transfer(batch, local = false, leaseRetries = 0, preparedPayload) {
        // File reads, base64 conversion and compression precede lease acquisition.
        // A lease retry reuses the same immutable, source-bound payload.
        const encoded =
          preparedPayload ??
          (local
            ? await prepareLocalStagePayload(dist, batch)
            : JSON.stringify({ records: batch }));
        const current = await reservation();
        const writeLease = current;
        const authorization = JSON.stringify({
          lease: writeLease,
          signature: createHmac('sha256', Buffer.from(secret, 'hex'))
            .update(JSON.stringify(writeLease))
            .digest('hex'),
        });
        if (authorization.length > 16_000)
          throw Error('Release authorization metadata exceeds bound');
        let last;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response = await fetch('http://127.0.0.1:8899/stage', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-UC-Stage-Authorization': authorization,
                ...(local ? { 'X-UC-Body-Encoding': 'gzip' } : {}),
              },
              body: encoded,
              signal: AbortSignal.timeout(90_000),
            });
            if (response.status === 409) {
              await response.body.cancel();
              if (leaseRetries >= 3)
                throw Object.assign(
                  Error('Fresh release authorization could not be acquired in time'),
                  {
                    permanent: true,
                  },
                );
              await reservation(true);
              return transfer(batch, local, leaseRetries + 1, encoded);
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
            validateVerificationReceipt(result, batch, tree.root);
            for (const row of result.verified) recordVerified(row);
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
            // Byte and actor limits bound each invocation without weakening
            // per-object Merkle proofs, conditional writes or full readback.
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
          storagePolicy: OWNER_MANAGED_STORAGE_POLICY,
          accountUsageMeasured: false,
          revision,
          bucket,
          root: tree.root,
          verified: allFiles.length,
          files: allFiles,
          ...(incrementalPlan ? { incrementalPlan } : {}),
          at: new Date().toISOString(),
        }) + '\n',
      );
      console.log(`Verified delivery manifest: ${manifestPath}`);
    } finally {
      try {
        await stopPrivateSession(child);
        releaseAllowed = true;
      } finally {
        if (output !== undefined) closeSync(output);
        // Only a confirmed stopped child allows removal of its private input.
        if (releaseAllowed) {
          try {
            unlinkSync(entryPath);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
      }
    }
  } finally {
    // If process termination cannot be confirmed, preserve the account lock.
    if (releaseAllowed) releaseLock();
  }
}
await main();
