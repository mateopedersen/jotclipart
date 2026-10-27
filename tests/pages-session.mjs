import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert/strict');
const {
  createSessionManager,
  expiredSession,
} = require('../scripts/delivery/pages-session-manager.cjs');
test('parallel upload batches share one proactive session renewal', async () => {
  let now = 0,
    calls = 0,
    applied;
  const renew = createSessionManager(
    async () => {
      calls++;
      return 'fresh-test-session';
    },
    (token) => {
      applied = token;
    },
    () => now,
  );
  await renew();
  assert.equal(calls, 0);
  now = 26 * 60 * 1000;
  await Promise.all(Array.from({ length: 6 }, () => renew()));
  assert.equal(calls, 1);
  assert.equal(applied, 'fresh-test-session');
  await renew();
  assert.equal(calls, 1);
});
test('expired API sessions can renew without treating ordinary forbidden responses as expiry', async () => {
  assert(expiredSession({ notes: [{ text: 'Expired JWT' }] }));
  assert(expiredSession({ code: 8000013 }));
  assert(!expiredSession({ status: 403, notes: [{ text: 'Permission denied' }] }));
  let calls = 0;
  const renew = createSessionManager(
    async () => {
      calls++;
      return 'fresh-test-session';
    },
    () => {},
  );
  await renew(true);
  assert.equal(calls, 1);
});
test('failed renewal stops uploads and a later attempt can recover', async () => {
  let calls = 0,
    applied = false;
  const renew = createSessionManager(
    async () => {
      if (++calls === 1) throw Error('offline');
      return 'fresh-test-session';
    },
    () => {
      applied = true;
    },
  );
  await assert.rejects(renew(true), /offline/);
  assert(!applied);
  await renew(true);
  assert(applied);
});
