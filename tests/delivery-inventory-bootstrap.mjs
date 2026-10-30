import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveBootstrapHints,
  cachedBootstrapHints,
  liveBootstrapBindings,
  loadBootstrapBindings,
} from '../scripts/delivery/inventory-bootstrap.mjs';
const account = 'a'.repeat(32),
  target = 'ultraclipart-pages';
const old = [
  { bucket: target, jurisdiction: 'default', bounds: ['delivery/a', 'delivery/m'] },
  { bucket: 'deleted-bucket', jurisdiction: 'default', bounds: [] },
];
test('signed cache stores partition hints only; tampering and a different account invalidate reuse', () => {
  const root = mkdtempSync(join(tmpdir(), 'uc-hint-test-'));
  try {
    saveBootstrapHints(root, account, target, old);
    assert.deepEqual(cachedBootstrapHints(root, account, target), old);
    assert.equal(cachedBootstrapHints(root, 'b'.repeat(32), target), null);
    const path = join(root, 'work/delivery/inventory-range-hints.json'),
      saved = JSON.parse(readFileSync(path));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(saved.data).sort(), [
      'accountId',
      'buckets',
      'hintOnly',
      'schema',
    ]);
    saved.data.buckets[0].bounds = ['forged'];
    writeFileSync(path, JSON.stringify(saved));
    assert.equal(cachedBootstrapHints(root, account, target), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('fresh names remove deleted buckets and add new buckets without reading objects or authorizing storage', async () => {
  const calls = [];
  const transport = {
    aws: async (command, args, endpoint) => {
      calls.push(command);
      assert.equal(command, 'list-buckets');
      const jur = endpoint.includes('.eu.')
        ? 'eu'
        : endpoint.includes('.us.')
          ? 'us'
          : endpoint.includes('.fedramp-high.')
            ? 'fedramp-high'
            : endpoint.includes('.fedramp.')
              ? 'fedramp'
              : 'default';
      const names =
        jur === 'default' ? [target, 'new-bucket'] : jur === 'eu' ? ['europe-media'] : [];
      return { Buckets: names.map((Name) => ({ Name })), TotalCount: names.length };
    },
  };
  const result = await liveBootstrapBindings(account, target, old, transport);
  assert.equal(calls.length, 5);
  assert(!result.some((b) => b.bucket === 'deleted-bucket'));
  assert.deepEqual(result.find((b) => b.bucket === target).bounds, old[0].bounds);
  assert.deepEqual(result.find((b) => b.bucket === 'new-bucket').bounds, []);
  assert(result.some((b) => b.bucket === 'europe-media' && b.jurisdiction === 'eu'));
  assert(
    result.every(
      (b) => Object.keys(b).sort().join() === ['bounds', 'bucket', 'jurisdiction'].join(),
    ),
  );
});
test('missing cache retains cold path; denied or malformed live scope cannot be called empty', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uc-hint-test-'));
  try {
    assert.equal(
      await loadBootstrapBindings(root, account, target, {
        aws: () => {
          throw Error('must not query');
        },
      }),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  await assert.rejects(
    liveBootstrapBindings(account, target, old, {
      aws: async () => {
        throw Error('Denied');
      },
    }),
    /Denied/,
  );
  await assert.rejects(
    liveBootstrapBindings(account, target, old, {
      aws: async () => ({ Buckets: [{ Name: target }], TotalCount: 2 }),
    }),
    /Incomplete/,
  );
  await assert.rejects(
    liveBootstrapBindings(account, target, old, {
      aws: async () => ({ Buckets: [], TotalCount: 0 }),
    }),
    /Target bucket missing/,
  );
});
test('real paginated rosters and explicit disabled jurisdiction proofs are respected', async () => {
  const transport = {
    aws: async (command, args, endpoint) => {
      if (endpoint.includes('.fedramp')) throw Error('not allocated');
      if (endpoint.includes('.eu.') || endpoint.includes('.us.'))
        return { Buckets: [], TotalCount: 0 };
      return args.includes('--continuation-token')
        ? { Buckets: [{ Name: 'new-bucket' }], TotalCount: 2 }
        : { Buckets: [{ Name: target }], TotalCount: 2, NextContinuationToken: 'next' };
    },
    proveAbsent: async (a, j) => ({
      source: 'cloudflare-entitlement-disabled',
      accountId: a,
      jurisdiction: j,
      entitlementKey: 'r2.fedramp',
      allocated: false,
      endpoint: `https://api.cloudflare.com/client/v4/accounts/${a}/entitlements`,
      observedAt: Date.now(),
    }),
  };
  const result = await liveBootstrapBindings(account, target, old, transport);
  assert.equal(result.length, 2);
  assert(result.some((b) => b.bucket === 'new-bucket'));
});
test('an invented disabled European scope is rejected by the shared all-jurisdiction proof gate', async () => {
  const transport = {
    aws: async (c, a, e) => {
      if (e.includes('.eu.')) throw Error('Denied');
      return {
        Buckets:
          e.includes('.r2.') && !e.includes('.us.') && !e.includes('.fedramp')
            ? [{ Name: target }]
            : [],
        TotalCount: e.includes('.r2.') && !e.includes('.us.') && !e.includes('.fedramp') ? 1 : 0,
      };
    },
    proveAbsent: async (a, j) => ({
      source: 'cloudflare-entitlement-disabled',
      accountId: a,
      jurisdiction: j,
      entitlementKey: 'r2.fedramp',
      allocated: false,
      endpoint: `https://api.cloudflare.com/client/v4/accounts/${a}/entitlements`,
      observedAt: Date.now(),
    }),
  };
  await assert.rejects(
    liveBootstrapBindings(account, target, old, transport),
    /disabled-jurisdiction/,
  );
});
