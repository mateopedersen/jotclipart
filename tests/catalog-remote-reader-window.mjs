import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { remoteCatalogBucket } from '../scripts/catalog-snapshot/remote-reader.mjs';
const sha = (b) => createHash('sha256').update(b).digest('hex'),
  secret = 'a'.repeat(64),
  root = 'b'.repeat(64),
  account = 'c'.repeat(32);
function fixture({ hinted = false, reversed = false, latency = 4 } = {}) {
  const rows = Array.from({ length: 128 }, (_, n) => {
      const body = Buffer.from(JSON.stringify({ n, visible: 'source ' + n }));
      return { body, key: 'catalog/objects/artworks/' + sha(body) + '.json' };
    }),
    byKey = new Map(rows.map((r) => [r.key, r]));
  let active = 0,
    peak = 0;
  const requested = [];
  const bucket = remoteCatalogBucket({
    secret,
    parentSnapshotSHA256: root,
    accountId: account,
    bucket: 'private-window-fixture',
    fetcher: async (_, options) => {
      const { command, signature } = JSON.parse(options.body);
      assert.equal(command.parentSnapshotSHA256, root);
      assert.equal(command.accountId, account);
      assert.equal(
        signature,
        createHmac('sha256', Buffer.from(secret, 'hex'))
          .update(JSON.stringify(command))
          .digest('hex'),
      );
      assert(Date.now() - command.at < 45000);
      assert(command.keys.length <= 16);
      active++;
      peak = Math.max(peak, active);
      assert(active <= 4);
      requested.push(...command.keys);
      await new Promise((done) =>
        setTimeout(done, latency + (Number(command.keys[0].charCodeAt(20)) % 3)),
      );
      active--;
      const objects = command.keys.map((key) => {
        const r = byKey.get(key);
        assert(r);
        return {
          key,
          body: r.body.toString('base64'),
          bytes: r.body.length,
          sha256: sha(r.body),
          etag: 'verified',
        };
      });
      return Response.json({
        parentSnapshotSHA256: root,
        objects: reversed ? objects.reverse() : objects,
      });
    },
  });
  if (hinted)
    for (const r of rows) bucket.hint({ key: r.key, sha256: sha(r.body), bytes: r.body.length });
  return { rows, bucket, peak: () => peak, requested };
}
for (const hinted of [false, true])
  test(
    'initial bounded pending batches fill four slots with exact bytes; hints=' + hinted,
    async () => {
      const f = fixture({ hinted, reversed: true });
      const result = await Promise.all(
        [...f.rows, ...f.rows.slice(0, 10)].map(async (r) =>
          Buffer.from(await (await f.bucket.get(r.key)).arrayBuffer()),
        ),
      );
      for (let i = 0; i < result.length; i++)
        assert.deepEqual(result[i], (i < 128 ? f.rows[i] : f.rows[i - 128]).body);
      assert.equal(f.peak(), 4);
      assert.equal(f.requested.length, 128);
      assert.equal(new Set(f.requested).size, 128);
    },
  );
test('a second wave while all slots are busy drains without exceeding the same bound', async () => {
  const f = fixture({ reversed: true, latency: 12 });
  const first = Promise.all(f.rows.slice(0, 64).map((r) => f.bucket.get(r.key)));
  await new Promise((done) => setTimeout(done, 2));
  const second = Promise.all(f.rows.slice(64).map((r) => f.bucket.get(r.key)));
  const outputs = (await Promise.all([first, second])).flat();
  assert.equal(outputs.length, 128);
  assert.equal(f.peak(), 4);
  assert.equal(f.requested.length, 128);
  for (let i = 0; i < 128; i++)
    assert.deepEqual(Buffer.from(await outputs[i].arrayBuffer()), f.rows[i].body);
});
test('corrupt successful bytes still fail closed with more than one active batch', async () => {
  let active = 0,
    peak = 0;
  const keys = Array.from(
    { length: 16 },
    (_, n) => 'catalog/objects/artworks/' + sha(Buffer.from('x' + n)) + '.json',
  );
  const b = remoteCatalogBucket({
    secret,
    parentSnapshotSHA256: root,
    accountId: account,
    bucket: 'private-window-fixture',
    fetcher: async (_, options) => {
      const { command } = JSON.parse(options.body);
      active++;
      peak = Math.max(peak, active);
      await new Promise((done) => setTimeout(done, 2));
      active--;
      return Response.json({
        parentSnapshotSHA256: root,
        objects: command.keys.map((key) => ({
          key,
          body: Buffer.from('corrupt').toString('base64'),
          bytes: 7,
          sha256: '0'.repeat(64),
          etag: 'invalid',
        })),
      });
    },
  });
  const result = await Promise.allSettled(keys.map((k) => b.get(k)));
  assert(result.every((x) => x.status === 'rejected'));
  assert.equal(peak, 4);
});
