import test from 'node:test';
import assert from 'node:assert/strict';
import { assertReusableIncomingReceipt } from '../scripts/catalog-snapshot/incoming-reuse.mjs';
import { assertCompleteTopicSearchDelta } from '../scripts/catalog-snapshot/topic-search-preflight.mjs';
import { merkle } from '../scripts/delivery/manifest.mjs';

const records = [{ path: '/one.webp', key: 'one.abc.webp', bytes: 7,
  sha256: 'a'.repeat(64), mime: 'image/webp' }];
const root = merkle(records).root, verifier = { accountId: 'owner', bucketName: 'media' };
const receipt = { status: 'EXACT_INCOMING_FILES_REMOTE_BYTES_SHA_MIME_VERIFIED',
  root, accountId: 'owner', bucket: 'media', bytes: 7,
  revision: 'b'.repeat(40), files: records.map(({path,key,bytes,sha256}) => ({path,key,bytes,sha256,etag:'exact'})) };

test('recovery admits only the complete identical media manifest; data epoch is independent', () => {
  assert.doesNotThrow(() => assertReusableIncomingReceipt(receipt, records, root, verifier));
  assert.doesNotThrow(() => assertReusableIncomingReceipt({...receipt,revision:'c'.repeat(40)}, records, root, verifier));
  for (const patch of [{root:'f'.repeat(64)},{accountId:'foreign'},{bucket:'other'},
    {bytes:8},{files:[]},{files:[...receipt.files,...receipt.files]},
    {files:[{...receipt.files[0],sha256:'f'.repeat(64)}]},
    {files:[{...receipt.files[0],key:'foreign'}]},
    {status:'PREPARED_NOT_VERIFIED'}])
    assert.throws(() => assertReusableIncomingReceipt({...receipt,...patch},records,root,verifier));
});

test('append-only topic retains both accepted categories before transport', () => {
  const old = {keyword:'Tesla clipart',primaryCluster:'Transport',
    clusters:[{name:'Transport',path:'/collection/transport/'},{name:'Technology',path:'/collection/technology/'}]};
  const change = {slug:'tesla',record:structuredClone(old),artworkIds:['old','new']};
  const ids = new Set(['new']);
  assert.doesNotThrow(() => assertCompleteTopicSearchDelta(old,change,ids));
  const dropped = structuredClone(change);dropped.record.clusters.pop();
  assert.throws(() => assertCompleteTopicSearchDelta(old,dropped,ids),/complete scoped member delta/);
  const renamed=structuredClone(change);renamed.record.keyword='Different meaning';
  assert.throws(() => assertCompleteTopicSearchDelta(old,renamed,ids),/complete scoped member delta/);
  assert.doesNotThrow(() => assertCompleteTopicSearchDelta(old,dropped,new Set(['old','new'])));
  assert.doesNotThrow(() => assertCompleteTopicSearchDelta(null,change,ids));
});
