// Real workerd/R2 emulation, isolated in temporary storage. Never opens a remote
// Cloudflare session, reads account credentials or uses production bucket names.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHmac, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { digest, merkle } from '../../scripts/delivery/manifest.mjs';
import { verifyExistingFiles } from '../../scripts/delivery/verification-batch.mjs';

const require = createRequire(import.meta.resolve('wrangler'));
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const accountId = 'a'.repeat(32),
  bucket = 'local-fixture',
  secret = 'b'.repeat(64);
const data = Array.from({ length: 129 }, (_, n) => Buffer.from(`independent fixture ${n}`));
const records = data.map((bytes, n) => ({
  path: `/previews/p1/${n}.webp`,
  key: `delivery/test/${n}.webp`,
  bytes: bytes.length,
  sha256: digest(bytes),
  mime: 'image/webp',
}));
const tree = merkle(records),
  root = tree.root;
const batch = records.map((record, n) => ({ record, proof: tree.proof(n) }));
const priorRecords = records.slice(0, -1).map((record, n) => ({
  ...record,
  previousRoot: 'e'.repeat(64),
  etag: createHash('md5').update(data[n]).digest('hex'),
}));
const reuseTree = merkle(priorRecords);
const code = await build({
  stdin: {
    contents: `import {stagingWorker} from './scripts/delivery/staging-worker.mjs';
    export default stagingWorker(${JSON.stringify({ accountId, bucket, secret, root, reuseRoot: reuseTree.root, revision: 'c'.repeat(40) })});`,
    resolveDir: new URL('../..', import.meta.url).pathname,
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  write: false,
});
const mf = new Miniflare(
  convertV4MiniflareOptions({
    cf: false,
    r2Persist: false,
    workers: [
      {
        name: 'delivery-fixture',
        modules: true,
        script: code.outputFiles[0].text,
        compatibilityDate: '2026-10-19',
        r2Buckets: ['TARGET'],
        outboundService: () => {
          throw Error('Local staging test may not fetch external sources');
        },
      },
    ],
  }),
);
try {
  const storage = await mf.getR2Bucket('TARGET');
  for (let n = 0; n < data.length - 1; n++)
    await storage.put(records[n].key, data[n], { httpMetadata: { contentType: 'image/webp' } });
  const verified = [];
  const missing = await verifyExistingFiles(batch, {
    root,
    accountId,
    bucket,
    secret,
    actors: 4,
    onVerified: (row) => verified.push(row),
    fetcher: (url, init) => mf.dispatchFetch(url, init),
  });
  assert.equal(verified.length, 128);
  assert.equal(missing.length, 1);
  assert.equal((await storage.list()).objects.length, 128);
  const reused = [];
  const index = new Map(records.map((row, n) => [row.path, n]));
  const stillMissing = await verifyExistingFiles(batch, {
    root,
    accountId,
    bucket,
    secret,
    actors: 4,
    onVerified: (row) => reused.push(row),
    fetcher: (url, init) => mf.dispatchFetch(url, init),
    attachPrior(row) {
      const n = index.get(row.record.path);
      if (n === priorRecords.length) return row;
      return {
        ...row,
        prior: {
          etag: priorRecords[n].etag,
          previousRoot: priorRecords[n].previousRoot,
          proof: reuseTree.proof(n),
        },
      };
    },
  });
  assert.equal(stillMissing.length, 1);
  assert.equal(
    reused.filter((row) => row.verification === 'prior-byte-proof-and-current-etag').length,
    128,
  );
  assert.equal((await storage.list()).objects.length, 128);
  const lease = { root, accountId, bucket, observedAt: Date.now(), projectedBytes: 100_000 };
  const signature = createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(JSON.stringify(lease))
    .digest('hex');
  const response = await mf.dispatchFetch('http://localhost/stage', {
    method: 'POST',
    body: JSON.stringify({
      lease,
      signature,
      records: missing,
      blobs: { [records.at(-1).path]: data.at(-1).toString('base64') },
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).verified[0].sha256, records.at(-1).sha256);
  const uploaded = await storage.get(records.at(-1).key);
  assert.equal(digest(Buffer.from(await uploaded.arrayBuffer())), records.at(-1).sha256);
  assert.equal(Buffer.from(uploaded.checksums.sha256).toString('hex'), records.at(-1).sha256);
  await assert.rejects(storage.put('invalid-native-checksum', 'wrong', { sha256: '0'.repeat(64) }));
  assert.equal(await storage.head('invalid-native-checksum'), null);
  assert.equal((await storage.list()).objects.length, 129);
  console.log(
    JSON.stringify({
      status: 'PASS_LOCAL_WORKERD_R2',
      independentlyVerified: 128,
      reusedWithoutReadingBody: 128,
      missingStagedWithFreshLease: 1,
      nativeSha256Verified: true,
      externalRequests: 0,
      workerSourceSha256: digest(
        readFileSync(new URL('../../scripts/delivery/staging-worker.mjs', import.meta.url)),
      ),
    }),
  );
} finally {
  await mf.dispose();
}
