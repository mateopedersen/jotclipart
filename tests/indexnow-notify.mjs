import test from 'node:test';
import assert from 'node:assert/strict';
import { runIndexNowNotification } from '../scripts/seo/indexnow-notify.mjs';

test('notification failure preserves successful publication and records notification-only retry', () => {
  let saved;
  const result = runIndexNowNotification({
    root: '/unused',
    readPolicy: () => ({ submissionEnabled: true }),
    revision: 'a'.repeat(40),
    env: {},
    spawn: () => ({ status: 1, stderr: 'HTTP 429' }),
    save: (r) => {
      saved = r;
    },
  });
  assert.equal(result.status, 'PUBLISHED_NOTIFICATION_PENDING');
  assert.equal(saved.reason, 'HTTP 429');
  assert.match(saved.retry, /indexnow-release/);
  assert.doesNotMatch(saved.retry, /deploy/);
});
test('accepted notification records the exact sender result', () => {
  const result = runIndexNowNotification({
    root: '/unused',
    readPolicy: () => ({ submissionEnabled: true }),
    revision: 'a'.repeat(40),
    env: {},
    spawn: () => ({ status: 0, stdout: JSON.stringify({ updated: 0, receipts: [] }) }),
    save: () => {},
  });
  assert.equal(result.status, 'PUBLISHED_NOTIFICATION_COMPLETE');
  assert.equal(result.result.updated, 0);
});
test('explicit notification hold never starts a sender or alters the accepted ledger', () => {
  let saved;
  const result = runIndexNowNotification({
    root: '/unused',
    readPolicy: () => ({ submissionEnabled: true }),
    revision: 'b'.repeat(40),
    env: { UC_INDEXNOW_NOTIFY: '0' },
    spawn: () => {
      throw Error('sender must not run');
    },
    save: (r) => {
      saved = r;
    },
  });
  assert.equal(result.status, 'PUBLISHED_NOTIFICATION_HELD');
  assert.equal(saved, result);
  assert.equal(result.revision, 'b'.repeat(40));
  assert.equal(result.retry, undefined);
});
test('separate rendered revision is passed to the verified sender and its retry', () => {
  let args;
  const rendered = 'c'.repeat(40),
    control = 'd'.repeat(40);
  const result = runIndexNowNotification({
    root: '/unused',
    readPolicy: () => ({ submissionEnabled: true }),
    revision: control,
    renderedRevision: rendered,
    env: {},
    spawn: (_node, a) => {
      args = a;
      return { status: 1, stderr: 'temporarily unavailable' };
    },
    save: () => {},
  });
  assert.deepEqual(args.slice(-2), ['--rendered-revision', rendered]);
  assert.match(result.retry, new RegExp('--rendered-revision ' + rendered));
});
