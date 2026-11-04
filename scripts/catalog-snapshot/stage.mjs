// Guarded immutable metadata staging only. This command never activates a root.
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
import { spawn, execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { setTimeout as wait } from 'node:timers/promises';
import { merkle } from '../delivery/manifest.mjs';
import { awaitAccountWriter } from '../delivery/account-lock.mjs';
import { stopPrivateSession } from '../delivery/private-session.mjs';
import {
  OWNER_MANAGED_STORAGE_POLICY,
  createReleaseWriteAuthorization,
} from '../delivery/release-write-authorization.mjs';
import { validateVerificationReceipt } from '../delivery/verification-batch.mjs';
import { validateMetadataManifest, readMetadataBytes, sha256 } from './stage-manifest.mjs';
import { verifySourceFile, verifySourceCapsule } from './source-files.mjs';
import { verifyImmutableReadbackAnchor, splitImmutableReadbackPlan } from './reuse-readback.mjs';
function progress(value) {
  mkdirSync('work/catalog-snapshot', { recursive: true });
  writeFileSync(
    'work/catalog-snapshot/status.json',
    JSON.stringify({ ...value, at: new Date().toISOString() }),
  );
  console.log(JSON.stringify(value));
}
const root = process.cwd(),
  directory = resolve(process.argv[2] ?? '');
if (!process.argv[2] || !directory.startsWith(resolve('work') + '/'))
  throw Error('Prepared work directory required');
const manifest = validateMetadataManifest(
    JSON.parse(readFileSync(join(directory, 'manifest.json'))),
  ),
  audit = JSON.parse(readFileSync(join(directory, 'source-receipt.json'))),
  graph = JSON.parse(readFileSync(join(directory, 'graph-local-receipt.json'))),
  revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (
  manifest.revision !== audit.revision ||
  (audit.kind === 'BOUNDED_CONTENT_DELTA'
    ? audit.sourceCommit !== revision
    : audit.revision !== revision) ||
  audit.status !== 'CURRENT_SOURCE_AND_EDITORIAL_VERIFIED_NOT_A_DEPLOYMENT' ||
  graph.manifestRoot !== manifest.root ||
  graph.status !== 'LOCAL_SOURCE_GRAPH_VERIFIED_REMOTE_READBACK_REQUIRED' ||
  graph.sourceReceiptSHA256 !== sha256(readFileSync(join(directory, 'source-receipt.json')))
)
  throw Error('Current reviewed source and graph required');
if (audit.kind === 'BOUNDED_CONTENT_DELTA') {
  const packetBytes = readFileSync(join(directory, 'packet.json'));
  if (sha256(packetBytes) !== audit.packetSHA256) throw Error('Source packet changed');
  verifySourceCapsule(JSON.parse(packetBytes));
}
for (const [file, hash] of Object.entries(audit.sourceHashes))
  await verifySourceFile(
    {
      path: file,
      bytes: (await import('node:fs')).statSync(file).size,
      sha256: hash,
    },
    audit.kind === 'BOUNDED_CONTENT_DELTA' ? {} : { sourceRoot: process.cwd() },
  );
for (const r of manifest.records) readMetadataBytes(manifest, r);
const anchorDirectory = process.argv[3] ? resolve(process.argv[3]) : null;
let anchor = null;
if (anchorDirectory) {
  if (!anchorDirectory.startsWith(resolve('work') + '/'))
    throw Error('Protected prior signed receipt directory required');
  const prior = JSON.parse(readFileSync(join(anchorDirectory, 'production-snapshot.json'))),
    pub = JSON.parse(readFileSync('config/catalog-snapshot-public.json'));
  anchor = await verifyImmutableReadbackAnchor({
    snapshotBytes: readFileSync(join(anchorDirectory, 'production-snapshot.json')),
    graphBytes: readFileSync(join(anchorDirectory, 'graph-verified-receipt.json')),
    remoteBytes: readFileSync(join(anchorDirectory, 'remote-receipt.json')),
    verifier: {
      ...pub,
      publicKey: new Uint8Array(Buffer.from(pub.publicKeyHex, 'hex')),
      abiSHA256: prior.authorization?.abiSHA256,
    },
  });
}
const plan = splitImmutableReadbackPlan(manifest.records, anchor),
  scope = plan.fresh;
if (!scope.length)
  throw Error('No new immutable metadata to stage; use a separately verified pointer-only plan');
const release = await awaitAccountWriter(process.env, {
  timeoutMs: 3600000,
  notify: (x) => console.log(JSON.stringify(x)),
});
let stopped = true,
  child,
  output;
const session = join(directory, 'private-stage'),
  entry = join(session, 'entry.mjs'),
  secret = randomBytes(32).toString('hex'),
  tree = merkle(scope),
  job = {
    root: tree.root,
    revision: manifest.revision,
    accountId: '48c779c8eaa80234e0bb9d57f96e588b',
    bucket: 'ultraclipart-pages',
    secret,
    sourceOrigin: 'https://ultraclipart.com',
    storagePolicy: OWNER_MANAGED_STORAGE_POLICY,
    authorizedBytes: plan.freshBytes,
  };
try {
  createReleaseWriteAuthorization(job);
  mkdirSync(session, { recursive: true });
  const fd = openSync(entry, 'w', 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(
      fd,
      `import{stagingWorker}from ${JSON.stringify(join(root, 'scripts/delivery/staging-worker.mjs'))};export default stagingWorker(${JSON.stringify(job)});`,
    );
  } finally {
    closeSync(fd);
  }
  writeFileSync(
    join(session, 'wrangler.json'),
    JSON.stringify({
      name: 'ultraclipart-private-metadata',
      main: 'entry.mjs',
      compatibility_date: '2026-10-23',
      account_id: job.accountId,
      r2_buckets: [{ binding: 'TARGET', bucket_name: job.bucket, preview_bucket_name: job.bucket }],
    }),
  );
  output = openSync(join(session, 'session.log'), 'a', 0o600);
  fchmodSync(output, 0o600);
  stopped = false;
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
      join(session, 'wrangler.json'),
      '--show-interactive-dev-session=false',
    ],
    {
      cwd: root,
      env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
      stdio: ['ignore', output, output],
    },
  );
  let spawnError;
  child.on('error', (e) => (spawnError = e));
  let ready = false;
  for (let i = 0; i < 90; i++) {
    if (spawnError || child.exitCode !== null)
      throw Error('Private metadata session exited; inspect redacted local session log');
    try {
      const r = await fetch('http://127.0.0.1:8899/health', { signal: AbortSignal.timeout(2000) });
      if ((await r.json()).root === job.root) {
        ready = true;
        break;
      }
    } catch {}
    await wait(1000);
  }
  if (!ready) throw Error('Private metadata session did not start');
  let cursor = 0,
    failed = false,
    verified = 0;
  const started = Date.now(),
    rows = [];
  await Promise.allSettled(
    Array.from({ length: 8 }, async () => {
      while (cursor < scope.length && !failed) {
        const batch = [],
          blobs = {};
        let size = 0;
        while (
          cursor < scope.length &&
          batch.length < 64 &&
          (!batch.length || size + scope[cursor].bytes <= 4000000)
        ) {
          const i = cursor++,
            record = scope[i];
          batch.push({ record, proof: tree.proof(i) });
          blobs[record.path] = readMetadataBytes(manifest, record).toString('base64');
          size += record.bytes;
        }
        const payload = gzipSync(Buffer.from(JSON.stringify({ records: batch, blobs })));
        let result, last;
        for (let attempt = 0; attempt < 3 && !result; attempt++) {
          const lease = createReleaseWriteAuthorization(job, Date.now() - 1000),
            authorization = JSON.stringify({
              lease,
              signature: createHmac('sha256', Buffer.from(secret, 'hex'))
                .update(JSON.stringify(lease))
                .digest('hex'),
            });
          try {
            const r = await fetch('http://127.0.0.1:8899/stage', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-UC-Stage-Authorization': authorization,
                'X-UC-Body-Encoding': 'gzip',
              },
              body: payload,
              signal: AbortSignal.timeout(90000),
            });
            if (!r.ok) {
              await r.body?.cancel();
              const e = Error('Metadata stage HTTP ' + r.status);
              if (![408, 409, 429, 500, 502, 503, 504].includes(r.status)) e.permanent = true;
              throw e;
            }
            result = validateVerificationReceipt(await r.json(), batch, job.root);
          } catch (e) {
            last = e;
            if (e.permanent) break;
            if (attempt < 2) await wait(1000 * (attempt + 1));
          }
        }
        if (!result) {
          failed = true;
          throw last;
        }
        for (const r of result.verified) {
          if (typeof r.etag !== 'string' || !r.etag) throw Error('Missing immutable ETag');
          rows.push(r);
          appendFileSync(
            join(directory, 'remote-readback.jsonl'),
            JSON.stringify({ ...r, root: job.root, at: new Date().toISOString() }) + '\n',
          );
        }
        verified += batch.length;
        progress({
          phase: 'metadata-remote-byte-readback',
          verified: verified + plan.reused.length,
          total: manifest.records.length,
          freshReadback: verified,
          reusedSignedObjects: plan.reused.length,
          seconds: Math.round((Date.now() - started) / 1000),
          revision,
          root: job.root,
        });
      }
    }),
  ).then((results) => {
    const bad = results.find((r) => r.status === 'rejected');
    if (bad) throw bad.reason;
  });
  if (verified !== scope.length || new Set(rows.map((r) => r.key)).size !== verified)
    throw Error('Metadata readback incomplete');
  writeFileSync(
    join(directory, 'remote-receipt.json'),
    JSON.stringify(
      {
        schema: 1,
        status: anchor
          ? 'REMOTE_METADATA_CHANGED_READBACK_AND_SIGNED_REUSE_VERIFIED_NOT_ACTIVATED'
          : 'REMOTE_METADATA_BYTES_SHA_MIME_VERIFIED_NOT_ACTIVATED',
        revision: manifest.revision,
        root: manifest.root,
        writeRoot: job.root,
        objects: manifest.records.length,
        bytes: plan.freshBytes + plan.reusedBytes,
        freshReadbackObjects: verified,
        reusedSignedObjects: plan.reused.length,
        reuseAnchor: anchor
          ? {
              snapshotSHA256: anchor.snapshotSHA256,
              graphReceiptSHA256: anchor.graphReceiptSHA256,
              remoteReceiptSHA256: anchor.remoteReceiptSHA256,
            }
          : null,
        accountId: job.accountId,
        bucket: job.bucket,
        accountUsageMeasured: false,
        storagePolicy: job.storagePolicy,
        sourceReceiptSHA256: graph.sourceReceiptSHA256,
        files: [...rows, ...plan.reused],
        seconds: (Date.now() - started) / 1000,
        at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  progress({
    phase: 'metadata-staged-not-live',
    verified: manifest.records.length,
    total: manifest.records.length,
    freshReadback: verified,
    reusedSignedObjects: plan.reused.length,
    root: manifest.root,
    writeRoot: job.root,
    revision,
  });
} finally {
  try {
    await stopPrivateSession(child);
    stopped = true;
  } finally {
    if (output !== undefined) closeSync(output);
    if (stopped) {
      try {
        unlinkSync(entry);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      release();
    }
  }
}
