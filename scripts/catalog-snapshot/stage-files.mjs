// Bounded binary transport; exact Merkle scope, fresh requests and full readback.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { merkle } from '../delivery/manifest.mjs';
import {
  createReleaseWriteAuthorization,
  OWNER_MANAGED_STORAGE_POLICY,
} from '../delivery/release-write-authorization.mjs';
import { validateVerificationReceipt } from '../delivery/verification-batch.mjs';
import { withPrivateCatalogSession } from './operator-session.mjs';
import { verifySourceFile } from './source-files.mjs';
export async function stageScopedFiles({
  records,
  sourceByKey,
  revision,
  verifier,
  directory,
  media = true,
  benchmarkPrefix = null,
  progress = () => {},
}) {
  if (
    !Array.isArray(records) ||
    !records.length ||
    records.length > 6000 ||
    new Set(records.map((r) => r.key)).size !== records.length
  )
    throw Error('Bounded exact source scope required');
  for (const r of records) {
    if (!sourceByKey[r.key] || r.bytes > 8000000 || !r.key.includes(r.sha256.slice(0, 12)))
      throw Error('Content addressed native source required');
    await verifySourceFile(
      { path: sourceByKey[r.key], bytes: r.bytes, sha256: r.sha256 },
      benchmarkPrefix ? { sourceRoot: 'public' } : {},
    );
  }
  const tree = merkle(records),
    job = {
      root: tree.root,
      revision,
      accountId: verifier.accountId,
      bucket: verifier.bucketName,
      verifier,
      sourceOrigin: 'https://ultraclipart.com',
      storagePolicy: OWNER_MANAGED_STORAGE_POLICY,
      authorizedBytes: records.reduce((n, r) => n + r.bytes, 0),
      media,
      ...(benchmarkPrefix ? { benchmark: true, testPrefix: benchmarkPrefix } : {}),
    };
  createReleaseWriteAuthorization(job);
  return withPrivateCatalogSession(
    {
      directory: join(directory, 'binary-session'),
      kind: benchmarkPrefix ? 'benchmark' : 'stager',
      job,
    },
    async ({ secret }) => {
      let cursor = 0;
      const verified = [],
        started = Date.now();
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          while (cursor < records.length) {
            const i = cursor++,
              record = records[i],
              batch = [{ record, proof: tree.proof(i) }],
              bytes = readFileSync(sourceByKey[record.key]);
            let last, result;
            for (let attempt = 0; attempt < 3 && !result; attempt++) {
              const lease = createReleaseWriteAuthorization(job, Date.now() - 1000),
                signature = createHmac('sha256', Buffer.from(secret, 'hex'))
                  .update(JSON.stringify(lease))
                  .digest('hex');
              try {
                const r = await fetch('http://127.0.0.1:8899/stage', {
                  method: 'POST',
                  headers: {
                    'content-type': 'application/octet-stream',
                    'x-uc-stage-metadata': JSON.stringify({ records: batch }),
                    'x-uc-stage-authorization': JSON.stringify({ lease, signature }),
                  },
                  body: bytes,
                  signal: AbortSignal.timeout(90000),
                });
                if (!r.ok)
                  throw Object.assign(Error('Scoped binary staging HTTP ' + r.status), {
                    permanent: ![408, 409, 429, 500, 502, 503, 504].includes(r.status),
                  });
                result = validateVerificationReceipt(await r.json(), batch, tree.root);
              } catch (e) {
                last = e;
                if (e.permanent) throw e;
                if (attempt < 2) await wait(1000 * (attempt + 1));
              }
            }
            if (!result) throw last;
            verified.push(...result.verified);
            progress({
              phase: 'incoming-files-verified',
              verified: verified.length,
              total: records.length,
              bytes: verified.reduce((n, r) => n + r.bytes, 0),
              seconds: (Date.now() - started) / 1000,
            });
          }
        }),
      );
      if (new Set(verified.map((r) => r.key)).size !== records.length)
        throw Error('Incomplete changed-file readback');
      const receipt = {
        status: 'EXACT_INCOMING_FILES_REMOTE_BYTES_SHA_MIME_VERIFIED',
        revision,
        root: tree.root,
        accountId: job.accountId,
        bucket: job.bucket,
        files: verified.sort((a, b) => a.key.localeCompare(b.key)),
        bytes: job.authorizedBytes,
        seconds: (Date.now() - started) / 1000,
        accountInventoryCalls: 0,
        oldCatalogScans: 0,
      };
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'incoming-files-receipt.json'),
        JSON.stringify(receipt, null, 2),
      );
      if (benchmarkPrefix) {
        let deleted = 0;
        for (let offset = 0; offset < records.length;) {
          const batch = [];
          let size = 0;
          while (
            offset < records.length &&
            batch.length < 64 &&
            size + records[offset].bytes <= 8000000
          ) {
            const i = offset++;
            batch.push({ record: records[i], proof: tree.proof(i) });
            size += records[i].bytes;
          }
          if (!batch.length) throw Error('Cleanup byte budget');
          const command = {
              action: 'verify',
              root: tree.root,
              accountId: job.accountId,
              bucket: job.bucket,
              at: Date.now() - 1000,
            },
            signature = createHmac('sha256', Buffer.from(secret, 'hex'))
              .update(JSON.stringify(command))
              .digest('hex'),
            r = await fetch('http://127.0.0.1:8899/cleanup', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ command, signature, records: batch }),
              signal: AbortSignal.timeout(90000),
            });
          if (!r.ok) throw Error('Exact private test cleanup HTTP ' + r.status);
          const proof = await r.json();
          if (
            proof.root !== tree.root ||
            JSON.stringify(proof.deleted.slice().sort()) !==
              JSON.stringify(batch.map((x) => x.record.key).sort())
          )
            throw Error('Test cleanup scope differs');
          deleted += batch.length;
        }
        writeFileSync(
          join(directory, 'private-cleanup-receipt.json'),
          JSON.stringify(
            {
              status: 'EXACT_PRIVATE_BENCHMARK_FILES_DELETED',
              deleted,
              root: tree.root,
              productionFilesTouched: 0,
            },
            null,
            2,
          ),
        );
      }
      return receipt;
    },
  );
}
