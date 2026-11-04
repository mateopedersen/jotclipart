import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { metadataDiskCache } from '../scripts/catalog-snapshot/metadata-disk-cache.mjs';
import { remoteCatalogBucket } from '../scripts/catalog-snapshot/remote-reader.mjs';
const sha = (b) => createHash('sha256').update(b).digest('hex'),
  record = (n) => {
    const b = Buffer.from(JSON.stringify({ n }));
    return { b, key: 'catalog/objects/collections/' + sha(b) + '.json' };
  };
test('immutable metadata cache survives restarts, bounds space, rejects foreign scope and recovers corruption', () => {
  const directory = resolve('work/test-cache-' + randomBytes(8).toString('hex')),
    options = {
      directory,
      accountId: 'a'.repeat(32),
      bucketName: 'private-cache-test',
      maxBytes: 16,
      maxObjects: 2,
    };
  mkdirSync(directory, { recursive: true });
  try {
    const c = metadataDiskCache(options),
      a = record(1),
      b = record(2),
      d = record(3);
    c.put(a.key, a.b);
    c.put(b.key, b.b);
    assert.deepEqual(c.get(a.key), a.b);
    c.put(d.key, d.b);
    assert.equal(c.get(b.key), null);
    assert(c.metrics().bytes <= 16);
    c.close();
    const restored = metadataDiskCache(options);
    assert.deepEqual(restored.get(a.key), a.b);
    writeFileSync(join(directory, a.key.replaceAll('/', '_')), 'wrong');
    assert.equal(restored.get(a.key), null);
    assert.equal(restored.get('catalog/active.json'), null);
    assert.throws(() => restored.put('catalog/active.json', a.b));
    assert.throws(() => metadataDiskCache({ ...options, bucketName: 'another-private-test' }));
    restored.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('private remote reader never reuses mutable active pointer but coalesces immutable reads', async () => {
  let calls = 0;
  const f = record(5),
    bucket = remoteCatalogBucket({
      secret: 'a'.repeat(64),
      parentSnapshotSHA256: 'b'.repeat(64),
      accountId: 'c'.repeat(32),
      bucket: 'private-test',
      fetcher: async (_, o) => {
        calls++;
        const c = JSON.parse(o.body).command;
        return Response.json({
          parentSnapshotSHA256: 'b'.repeat(64),
          objects: c.keys.map((key) => {
            const body =
              key === 'catalog/active.json' ? Buffer.from(JSON.stringify({ version: calls })) : f.b;
            return {
              key,
              body: body.toString('base64'),
              bytes: body.length,
              sha256: sha(body),
              etag: 'exact',
            };
          }),
        });
      },
    });
  const one = await (await bucket.get('catalog/active.json')).json(),
    two = await (await bucket.get('catalog/active.json')).json();
  assert.notEqual(one.version, two.version);
  await Promise.all([bucket.get(f.key), bucket.get(f.key)]);
  await bucket.get(f.key);
  assert.equal(calls, 3);
});
