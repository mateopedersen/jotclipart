import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteCatalogBucket } from '../scripts/catalog-snapshot/remote-reader.mjs';
import { sha256 } from '../scripts/catalog-snapshot/stage-manifest.mjs';
const settings = {
  secret: 'a'.repeat(64),
  parentSnapshotSHA256: 'b'.repeat(64),
  accountId: 'c'.repeat(32),
  bucket: 'private-test',
};
test('private point reader coalesces duplicate requests, verifies bytes and bounds memory without listing', async () => {
  const b = Buffer.from('{"example":true}'),
    sha = sha256(b),
    key = 'catalog/objects/artworks/' + sha + '.json';
  let requests = 0;
  const bucket = remoteCatalogBucket({
    ...settings,
    cacheEntries: 1,
    fetcher: async (_, init) => {
      requests++;
      const c = JSON.parse(init.body).command;
      assert.deepEqual(c.keys, [key]);
      return Response.json({
        parentSnapshotSHA256: settings.parentSnapshotSHA256,
        objects: [
          { key, bytes: b.length, sha256: sha, body: b.toString('base64'), etag: 'fixture' },
        ],
      });
    },
  });
  const [a, d] = await Promise.all([bucket.get(key), bucket.get(key)]);
  assert.deepEqual(await a.json(), { example: true });
  assert.deepEqual(await d.json(), { example: true });
  assert.equal(requests, 1);
  await bucket.get(key);
  assert.equal(requests, 1);
  assert.deepEqual(bucket.metrics(), {
    requests: 1,
    receivedBytes: b.length,
    cacheEntries: 1,
    catalogScans: 0,
  });
  await assert.rejects(() => bucket.get('users/private.json'), /Invalid/);
});
test('private read refuses a foreign root or body digest rather than returning incomplete records', async () => {
  const b = Buffer.from('{}'),
    sha = sha256(b),
    key = 'catalog/objects/counts/' + sha + '.json';
  for (const row of [
    { parentSnapshotSHA256: 'd'.repeat(64), objects: [] },
    {
      parentSnapshotSHA256: settings.parentSnapshotSHA256,
      objects: [{ key, bytes: 2, sha256: sha, body: 'eHg=' }],
    },
  ]) {
    const bucket = remoteCatalogBucket({ ...settings, fetcher: async () => Response.json(row) });
    await assert.rejects(() => bucket.get(key));
  }
});
