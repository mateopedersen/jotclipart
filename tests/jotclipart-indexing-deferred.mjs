import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  readIndexNowPolicy,
  assertIndexNowSubmissionEnabled,
} from '../scripts/seo/indexnow-policy.mjs';
import { sendChanges, runIndexNow } from '../scripts/seo/indexnow-release.mjs';
import { runIndexNowNotification } from '../scripts/seo/indexnow-notify.mjs';
const root = resolve(import.meta.dirname, '..');
test('the checked owner policy disables new-site submission without changing sitemap preparation', () => {
  const policy = readIndexNowPolicy(root);
  assert.equal(policy.host, 'jotclipart.com');
  assert.equal(policy.submissionEnabled, false);
  assert.equal(policy.submissionStatus, 'OWNER_DEFERRED_2026_11_16');
  assert.throws(() => assertIndexNowSubmissionEnabled(policy), /OWNER_DEFERRED/);
  assert.throws(
    () => assertIndexNowSubmissionEnabled({ ...policy, submissionEnabled: true }),
    /OWNER_DEFERRED/,
  );
});
test('a publication hook cannot override the owner hold through an environment flag or spawn a sender', () => {
  let calls = 0;
  const result = runIndexNowNotification({
    root,
    revision: 'a'.repeat(40),
    env: { UC_INDEXNOW_NOTIFY: '1' },
    spawn: () => {
      calls++;
      throw Error('must not start');
    },
    save: () => {},
  });
  assert.equal(calls, 0);
  assert.equal(result.status, 'PUBLISHED_NOTIFICATION_HELD');
  assert.equal(result.retry, undefined);
  const unreadable = runIndexNowNotification({
    root,
    revision: 'a'.repeat(40),
    readPolicy: () => {
      throw Error('unavailable');
    },
    spawn: () => {
      calls++;
    },
    save: () => {},
  });
  assert.equal(unreadable.status, 'PUBLISHED_NOTIFICATION_HELD');
  assert.equal(calls, 0);
});
test('direct sender and CLI entry reject the owner hold before a request or accepted-ledger write', async () => {
  let requests = 0,
    saves = 0;
  await assert.rejects(
    sendChanges({
      config: readIndexNowPolicy(root),
      previous: {},
      current: { 'https://jotclipart.com/': 'a'.repeat(64) },
      request: async () => {
        requests++;
        throw Error('must not request');
      },
      save: async () => {
        saves++;
      },
    }),
    /OWNER_DEFERRED/,
  );
  await assert.rejects(runIndexNow({ root, send: true }), /OWNER_DEFERRED/);
  assert.equal(requests, 0);
  assert.equal(saves, 0);
});
