import test from 'node:test';
import assert from 'node:assert/strict';
import {runIndexNowNotification} from '../scripts/seo/indexnow-notify.mjs';

test('notification failure preserves successful publication and records notification-only retry',()=>{
  let saved;
  const result=runIndexNowNotification({root:'/unused',revision:'a'.repeat(40),spawn:()=>({status:1,stderr:'HTTP 429'}),save:r=>{saved=r}});
  assert.equal(result.status,'PUBLISHED_NOTIFICATION_PENDING');
  assert.equal(saved.reason,'HTTP 429');assert.match(saved.retry,/indexnow-release/);
  assert.doesNotMatch(saved.retry,/deploy/);
});
test('accepted notification records the exact sender result',()=>{
  const result=runIndexNowNotification({root:'/unused',revision:'a'.repeat(40),spawn:()=>({status:0,stdout:JSON.stringify({updated:0,receipts:[]})}),save:()=>{}});
  assert.equal(result.status,'PUBLISHED_NOTIFICATION_COMPLETE');assert.equal(result.result.updated,0);
});
