// Native workerd/R2 with synthetic data only. No credentials, production
// bucket, external request, publication or user artwork is involved.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { digest, merkle } from '../../scripts/delivery/manifest.mjs';
import { createReservationPrefetch } from '../../scripts/r2/reservation-prefetch.mjs';
import { completeMediaWaveJournals } from '../../scripts/r2/binding-waves.mjs';

const require = createRequire(import.meta.resolve('wrangler'));
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const accountId = 'a'.repeat(32), bucket = 'local-fixture', secret = 'b'.repeat(64);
const data = Array.from({ length: 24 }, (_, i) => Buffer.from(`prefetch-test-fixture-${i}`));
const records = data.map((bytes, i) => ({ path: `/previews/p1/${i}.webp`, key: `fixture/${i}.webp`,
  bytes: bytes.length, sha256: digest(bytes), mime: 'image/webp', wave: 1 }));
const tree = merkle(records), root = tree.root;
const batch = records.map((record, i) => ({ record, proof: tree.proof(i) }));
const code = await build({ stdin: {
  contents: `import {stagingWorker} from './scripts/delivery/staging-worker.mjs'; export default stagingWorker(${JSON.stringify({accountId,bucket,secret,root,revision:'c'.repeat(40)})});`,
  resolveDir: new URL('../..', import.meta.url).pathname,
}, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
const mf = new Miniflare(convertV4MiniflareOptions({cf:false,r2Persist:false,workers:[{
  name:'local-prefetch-fixture',modules:true,script:code.outputFiles[0].text,
  compatibilityDate:'2026-10-19',r2Buckets:['TARGET'],
  outboundService:()=>{throw Error('External requests are forbidden in this test');},
}]}));
try {
  const storage = await mf.getR2Bucket('TARGET');
  let lease = { root, accountId, bucket, observedAt: Date.now(), projectedBytes: 128_000_000 },
      remaining = records.length, censusActive = false, overlapWrites = 0, scans = 0;
  const prefetch = createReservationPrefetch({
    current: () => lease,
    canPrefetch: () => remaining > 0,
    warmAfterMs: 5,
    refresh: async () => {
      const start = Date.now(); censusActive = true;
      const seen = await storage.list();
      await delay(200); // Represent an expensive, complete read of the account.
      assert(Array.isArray(seen.objects));
      lease = { root, accountId, bucket, observedAt: start, projectedBytes: 128_000_000 };
      censusActive = false; scans++;
    },
  });
  prefetch.schedule();
  await delay(15);
  const done = new Map();
  for (let i = 0; i < batch.length; i++) {
    const signed = { ...lease };
    const signature = createHmac('sha256', Buffer.from(secret,'hex')).update(JSON.stringify(signed)).digest('hex');
    const response = await mf.dispatchFetch('http://localhost/stage', { method:'POST', body:JSON.stringify({
      lease:signed, signature, records:[batch[i]], blobs:{[records[i].path]:data[i].toString('base64')},
    }) });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(result.verified[0].sha256, records[i].sha256);
    done.set(records[i].path, result.verified[0]);
    if (censusActive) overlapWrites++;
    remaining--;
    await delay(8);
  }
  await prefetch.stop();
  assert(overlapWrites > 0, 'native R2 writes must continue during the read-only census');
  assert(scans > 0);
  const listed = await storage.list();
  assert.equal(listed.objects.length, records.length);
  for (const [i, record] of records.entries()) {
    const actual = await storage.get(record.key);
    assert.equal(digest(Buffer.from(await actual.arrayBuffer())), digest(data[i]));
  }
  const postTransferLease = {bucket,observedAt:Date.now(),measuredBytes:records.reduce((n,r)=>n+r.bytes,0),inventoryScope:{jurisdictions:[]}};
  const snapshot = {buckets:[{name:bucket,jurisdiction:'default',objects:listed.objects.map(o=>({key:o.key,bytes:o.size}))}]};
  const journals = completeMediaWaveJournals({ records:batch, waves:[{number:1,batchSha256:'d'.repeat(64)}],
    done, snapshot, lease:postTransferLease, missing:new Set(records.map(r=>r.path)),
    startedAt:new Date().toISOString(), completedAt:new Date().toISOString() });
  assert.equal(journals.length,1);
  console.log(JSON.stringify({status:'PASS_LOCAL_WORKERD_PREFETCH_OVERLAP', stagedAndShaVerified:records.length,
    writesDuringCensus:overlapWrites, completedCensuses:scans, finalIndependentCensus:true, externalRequests:0}));
} finally { await mf.dispose(); }
