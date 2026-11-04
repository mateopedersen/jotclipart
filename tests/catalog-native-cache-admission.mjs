import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { metadataDiskCache } from '../scripts/catalog-snapshot/metadata-disk-cache.mjs';
import { remoteCatalogBucket } from '../scripts/catalog-snapshot/remote-reader.mjs';
const sha = (b) => createHash('sha256').update(b).digest('hex');
function source(n) {
  const b = Buffer.from(JSON.stringify({ n }));
  return { b, key: 'catalog/objects/collections/' + sha(b) + '.json' };
}
function fixture() {
  const directory = resolve(
    'work/imports/owner-brands-8-20261104/cache-native-admission-fix/test-' +
      randomBytes(6).toString('hex'),
  );
  const options = {
    directory,
    accountId: 'a'.repeat(32),
    bucketName: 'private-native-cache',
    maxBytes: 1024,
    maxObjects: 2,
  };
  const disk = metadataDiskCache(options),
    data = new Map();
  let requests = 0,
    gate = null,
    corrupt = false;
  const bucket = remoteCatalogBucket({
    secret: 'b'.repeat(64),
    parentSnapshotSHA256: 'c'.repeat(64),
    accountId: options.accountId,
    bucket: options.bucketName,
    diskCache: disk,
    fetcher: async (_, init) => {
      requests++;
      const command = JSON.parse(init.body).command;
      if (gate) await gate;
      return Response.json({
        parentSnapshotSHA256: 'c'.repeat(64),
        objects: command.keys.map((key) => {
          const b = data.get(key);
          return {
            key,
            body: (corrupt ? Buffer.from('corrupt') : b).toString('base64'),
            bytes: b.length,
            sha256: sha(b),
            etag: 'exact',
          };
        }),
      });
    },
  });
  return {
    directory,
    options,
    disk,
    bucket,
    data,
    requests: () => requests,
    setGate: (p) => (gate = p),
    setCorrupt: (v) => (corrupt = v),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
test('native reads preserve the warm composition disk set across restart without raising limits', async () => {
  const f = fixture();
  try {
    const warm = [source(1), source(2)];
    for (const r of warm) f.disk.put(r.key, r.b);
    const native = Array.from({ length: 12 }, (_, i) => source(i + 10));
    for (const r of native) f.data.set(r.key, r.b);
    await f.bucket.withoutDiskCacheAdmissions(async () => {
      assert.deepEqual(
        Buffer.from(await (await f.bucket.get(warm[0].key)).arrayBuffer()),
        warm[0].b,
      );
      for (const r of native)
        assert.deepEqual(Buffer.from(await (await f.bucket.get(r.key)).arrayBuffer()), r.b);
    });
    assert.equal(f.requests(), 12);
    assert.equal(f.disk.metrics().objects, 2);
    for (const r of warm) assert.deepEqual(f.disk.get(r.key), r.b);
    for (const r of native) assert.equal(f.disk.get(r.key), null);
    f.disk.close();
    const reopened = metadataDiskCache(f.options);
    for (const r of warm) assert.deepEqual(reopened.get(r.key), r.b);
    assert.equal(reopened.metrics().maxObjects, 2);
    assert.equal(reopened.metrics().maxBytes, 1024);
    reopened.close();
  } finally {
    f.cleanup();
  }
});
test('failed and nested scopes restore normal admissions while corrupt remote bytes still fail', async () => {
  const f = fixture();
  try {
    const a = source(20),
      b = source(21),
      c = source(22);
    for (const r of [a, b, c]) f.data.set(r.key, r.b);
    await assert.rejects(
      () =>
        f.bucket.withoutDiskCacheAdmissions(async () => {
          await f.bucket.withoutDiskCacheAdmissions(() => f.bucket.get(a.key));
          throw Error('native failed');
        }),
      /native failed/,
    );
    assert.equal(f.disk.get(a.key), null);
    await f.bucket.get(b.key);
    assert.deepEqual(f.disk.get(b.key), b.b);
    f.setCorrupt(true);
    await assert.rejects(
      () => f.bucket.withoutDiskCacheAdmissions(() => f.bucket.get(c.key)),
      /bytes differ/,
    );
    assert.equal(f.disk.get(c.key), null);
  } finally {
    f.cleanup();
  }
});
test('late responses from native requests cannot be admitted after the scope exits', async () => {
  const f = fixture();
  try {
    const r = source(30);
    f.data.set(r.key, r.b);
    let release;
    f.setGate(new Promise((done) => (release = done)));
    let pending;
    await f.bucket.withoutDiskCacheAdmissions(() => {
      pending = f.bucket.get(r.key);
    });
    release();
    assert.deepEqual(Buffer.from(await (await pending).arrayBuffer()), r.b);
    assert.equal(f.disk.get(r.key), null);
  } finally {
    f.cleanup();
  }
});
test('paused admissions retain cache hit hash checks and always refetch mutable pointers', async () => {
  const f = fixture();
  try {
    const r = source(40);
    f.disk.put(r.key, r.b);
    f.data.set(r.key, r.b);
    f.data.set('catalog/active.json', Buffer.from('{"active":true}'));
    writeFileSync(join(f.directory, r.key.replaceAll('/', '_')), 'broken');
    await f.bucket.withoutDiskCacheAdmissions(async () => {
      assert.deepEqual(Buffer.from(await (await f.bucket.get(r.key)).arrayBuffer()), r.b);
      await f.bucket.get('catalog/active.json');
      await f.bucket.get('catalog/active.json');
    });
    assert.equal(f.requests(), 3);
    assert.equal(f.disk.get(r.key), null);
    assert.equal(f.disk.get('catalog/active.json'), null);
  } finally {
    f.cleanup();
  }
});
