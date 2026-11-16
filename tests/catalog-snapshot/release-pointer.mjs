import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activateSnapshot,
  validateSnapshot,
  snapshotDigest,
} from '../../server/catalog-snapshot/release-pointer.mjs';
const parent = 'a'.repeat(40),
  revision = 'b'.repeat(40),
  sha = 'c'.repeat(64);
const indexes = Object.fromEntries(
  ['artworks', 'collections', 'search', 'recent', 'related', 'counts', 'sitemaps'].map((name) => [
    name,
    { sha256: sha, bytes: 3, key: `catalog/objects/${name}/${sha}.json` },
  ]),
);
const snapshot = { schema: 1, revision, parentRevision: parent, indexes };
const ok = async (s) => ({
  status: 'VERIFIED',
  revision: s.revision,
  parentRevision: s.parentRevision,
  snapshotSha256: await snapshotDigest(s),
});
function bucket() {
  let value = { revision: parent },
    etag = 'v1',
    writes = 0;
  return {
    get: async () => ({ etag, json: async () => value }),
    put: async (_key, body, options) => {
      if (options.onlyIf.etagMatches !== etag) return null;
      value = JSON.parse(body);
      etag = 'v2';
      writes++;
      return { etag };
    },
    change: () => {
      etag = 'other';
    },
    state: () => ({ value, writes }),
  };
}
test('all discovery indexes are required and scoped to immutable keys', () => {
  assert.throws(() =>
    validateSnapshot({ ...snapshot, indexes: { ...indexes, search: undefined } }),
  );
  assert.throws(() =>
    validateSnapshot({
      ...snapshot,
      indexes: { ...indexes, search: { ...indexes.search, key: 'catalog/active.json' } },
    }),
  );
});
test('unchanged objects can be reused across releases without crossing index scopes', () => {
  const next = { ...snapshot, revision: 'd'.repeat(40), parentRevision: revision };
  assert.equal(validateSnapshot(next).indexes.search.key, indexes.search.key);
  assert.throws(() =>
    validateSnapshot({
      ...next,
      indexes: { ...indexes, search: { ...indexes.search, key: indexes.artworks.key } },
    }),
  );
});
test('verified snapshot activates once', async () => {
  const b = bucket();
  await activateSnapshot({ bucket: b, pointerKey: 'catalog/active.json', snapshot, verify: ok });
  assert.equal(b.state().value.revision, revision);
  assert.equal(b.state().writes, 1);
});
test('failed verification leaves the pointer unchanged', async () => {
  const b = bucket();
  await assert.rejects(
    activateSnapshot({
      bucket: b,
      pointerKey: 'catalog/active.json',
      snapshot,
      verify: async () => ({ status: 'FAILED' }),
    }),
  );
  assert.equal(b.state().writes, 0);
});
test('changed production parent is rejected', async () => {
  const b = bucket();
  await assert.rejects(
    activateSnapshot({
      bucket: b,
      pointerKey: 'catalog/active.json',
      snapshot: { ...snapshot, parentRevision: 'd'.repeat(40) },
      verify: ok,
    }),
  );
  assert.equal(b.state().writes, 0);
});
test('concurrent activation cannot overwrite another release', async () => {
  const b = bucket();
  await assert.rejects(
    activateSnapshot({
      bucket: b,
      pointerKey: 'catalog/active.json',
      snapshot,
      verify: async (s) => {
        b.change();
        return ok(s);
      },
    }),
  );
  assert.equal(b.state().writes, 0);
});
test('verification cannot mutate the captured descriptor', async () => {
  const b = bucket();
  await assert.rejects(
    activateSnapshot({
      bucket: b,
      pointerKey: 'catalog/active.json',
      snapshot,
      verify: async (s) => {
        s.indexes.search.key = 'catalog/active.json';
        return ok(s);
      },
    }),
  );
  assert.equal(b.state().writes, 0);
});
test('proof must bind the complete descriptor digest', async () => {
  const b = bucket();
  await assert.rejects(
    activateSnapshot({
      bucket: b,
      pointerKey: 'catalog/active.json',
      snapshot,
      verify: async (s) => ({ ...(await ok(s)), snapshotSha256: 'f'.repeat(64) }),
    }),
  );
  assert.equal(b.state().writes, 0);
});
test('activation can never strip a private fixture label even with an approving callback', async () => {
  for (const label of [{ fixture: true }, { status: 'PRIVATE_UNPUBLISHABLE' }]) {
    const b = bucket();
    let called = false;
    await assert.rejects(
      activateSnapshot({
        bucket: b,
        pointerKey: 'catalog/active.json',
        snapshot: { ...snapshot, ...label },
        verify: async (s) => {
          called = true;
          return ok(s);
        },
      }),
    );
    assert.equal(called, false);
    assert.equal(b.state().writes, 0);
  }
});
test('new pointer scope is explicit even when both projects have the same predecessor', async () => {
  const oldKey = 'catalog/active.json',
    newKey = 'catalog/jotclipart/active.json';
  const values = new Map([
    [oldKey, { revision: parent }],
    [newKey, { revision: parent }],
  ]);
  const touched = [];
  const b = {
    get: async (key) => {
      touched.push(key);
      return { etag: 'v1', json: async () => values.get(key) };
    },
    put: async (key, body, options) => {
      touched.push(key);
      assert.equal(options.onlyIf.etagMatches, 'v1');
      values.set(key, JSON.parse(body));
      return { etag: 'v2' };
    },
  };
  await activateSnapshot({
    bucket: b,
    pointerKey: newKey,
    verifier: { activeKey: newKey },
    snapshot,
    verify: ok,
  });
  assert.equal(values.get(oldKey).revision, parent);
  assert.equal(values.get(newKey).revision, revision);
  assert(touched.every((key) => key === newKey));
  touched.length = 0;
  for (const options of [
    { pointerKey: oldKey, verifier: { activeKey: newKey } },
    { pointerKey: newKey, verifier: { activeKey: oldKey } },
    { pointerKey: newKey },
    { pointerKey: newKey, verifier: { activeKey: 'catalog/other/active.json' } },
  ])
    await assert.rejects(
      activateSnapshot({ bucket: b, snapshot, verify: ok, ...options }),
      /pointer scope/,
    );
  assert.deepEqual(touched, []);
});
