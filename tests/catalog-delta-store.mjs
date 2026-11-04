import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeltaStore } from '../scripts/catalog-snapshot/delta-store.mjs';
import { sha256 } from '../scripts/catalog-snapshot/stage-manifest.mjs';
function fixture() {
  const objects = new Map(),
    pack = (value) => {
      const b = Buffer.from(JSON.stringify(value)),
        sha = sha256(b),
        d = { key: 'catalog/objects/artworks/' + sha + '.json', sha256: sha, bytes: b.length };
      objects.set(d.key, b);
      return d;
    },
    leaf = pack({ schema: 1, text: 'accepted' }),
    root = pack({ schema: 1, child: leaf }),
    orphan = pack({ schema: 1, text: 'outside predecessor' }),
    context = {
      authorizationVerified: true,
      snapshot: { status: 'SOURCE_MEDIA_GRAPH_VERIFIED', indexes: { artworks: root } },
    },
    bucket = {
      get: async (key) => {
        const b = objects.get(key);
        return b ? { size: b.length, arrayBuffer: async () => b } : null;
      },
    };
  return { pack, root, leaf, orphan, context, bucket };
}
test('delta overlay admits only reached predecessor references and verifies changed closure', async () => {
  const f = fixture(),
    s = createDeltaStore(f.bucket, f.context);
  assert.equal(await s.bucket.get(f.leaf.key), null);
  await s.bucket.get(f.root.key);
  assert((await s.bucket.get(f.leaf.key)).size === f.leaf.bytes);
  assert.equal(await s.bucket.get(f.orphan.key), null);
  const b = Buffer.from(JSON.stringify({ schema: 1, child: f.leaf })),
    sha = sha256(b),
    d = { key: 'catalog/objects/artworks/' + sha + '.json', sha256: sha, bytes: b.length };
  await s.bucket.put(d.key, b);
  assert.equal(s.verifyChangedClosure({ artworks: d }).catalogScans, 0);
  const bad = Buffer.from(JSON.stringify({ schema: 1, child: f.orphan })),
    badSHA = sha256(bad),
    badD = {
      key: 'catalog/objects/artworks/' + badSHA + '.json',
      sha256: badSHA,
      bytes: bad.length,
    };
  await s.bucket.put(badD.key, bad);
  assert.throws(() => s.verifyChangedClosure({ artworks: badD }), /orphan/);
});
test('source fixtures and corrupt prior objects are not implicitly approved', async () => {
  const f = fixture();
  assert.throws(
    () => createDeltaStore(f.bucket, { ...f.context, authorizationVerified: false }),
    /Authenticated/,
  );
  assert.throws(
    () =>
      createDeltaStore(f.bucket, {
        ...f.context,
        snapshot: { ...f.context.snapshot, fixture: true },
      }),
    /Authenticated/,
  );
  const s = createDeltaStore(
    {
      get: async () => ({
        size: f.root.bytes,
        arrayBuffer: async () => Buffer.alloc(f.root.bytes),
      }),
    },
    f.context,
  );
  await assert.rejects(() => s.bucket.get(f.root.key), /Corrupt/);
});
