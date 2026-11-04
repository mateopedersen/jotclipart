import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, createHmac, randomBytes } from 'node:crypto';
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

test('a measured multi-phase working set above 4096 survives restart within the same byte ceiling', () => {
  const directory = resolve('work/test-cache-' + randomBytes(8).toString('hex')),
    options = { directory, accountId: 'a'.repeat(32), bucketName: 'private-working-set-test' };
  try {
    const c = metadataDiskCache(options),
      rows = Array.from({ length: 5000 }, (_, i) => record(i));
    for (const r of rows) c.put(r.key, r.b);
    assert.equal(c.metrics().objects, 5000);
    assert.equal(c.metrics().maxBytes, 64 * 1024 * 1024);
    assert(c.metrics().bytes <= c.metrics().maxBytes);
    c.close();
    const restored = metadataDiskCache(options);
    for (const r of rows) assert.deepEqual(restored.get(r.key), r.b);
    assert.equal(restored.get('catalog/active.json'), null);
    restored.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('invalid cache bounds fail before admitting files or entering eviction loops', () => {
  const options = {
    directory: resolve('work/test-cache-invalid-bound'),
    accountId: 'a'.repeat(32),
    bucketName: 'private-bound-test',
  };
  for (const key of ['maxBytes', 'maxObjects'])
    for (const value of [0, -1, 0.5, NaN, Infinity])
      assert.throws(() => metadataDiskCache({ ...options, [key]: value }));
  assert.throws(() => metadataDiskCache({ ...options, maxObjects: 8193 }));
  assert.throws(() => metadataDiskCache({ ...options, maxBytes: 64 * 1024 * 1024 + 1 }));
});

test('transient pinned reads retry only three times with fresh exact signed scope', async () => {
  const source = record(9),
    secret = 'a'.repeat(64),
    root = 'b'.repeat(64),
    commands = [];
  const bucket = remoteCatalogBucket({
    secret,
    parentSnapshotSHA256: root,
    accountId: 'c'.repeat(32),
    bucket: 'private-test',
    fetcher: async (_, options) => {
      const body = JSON.parse(options.body),
        c = body.command;
      commands.push(c);
      assert.equal(
        body.signature,
        createHmac('sha256', Buffer.from(secret, 'hex')).update(JSON.stringify(c)).digest('hex'),
      );
      assert(Date.now() - c.at < 45000);
      assert.equal(c.parentSnapshotSHA256, root);
      assert.deepEqual(c.keys, [source.key]);
      if (commands.length < 3)
        return new Response('Temporary provider failure', {
          status: commands.length === 1 ? 500 : 503,
        });
      return Response.json({
        parentSnapshotSHA256: root,
        objects: [
          {
            key: source.key,
            body: source.b.toString('base64'),
            bytes: source.b.length,
            sha256: sha(source.b),
            etag: 'exact',
          },
        ],
      });
    },
  });
  assert.deepEqual(Buffer.from(await (await bucket.get(source.key)).arrayBuffer()), source.b);
  assert.equal(commands.length, 3);
  assert(commands[2].at > commands[0].at);
});

test('parent conflicts and corrupt successful responses never retry', async () => {
  for (const status of [409, 200]) {
    let calls = 0;
    const source = record(11),
      bucket = remoteCatalogBucket({
        secret: 'a'.repeat(64),
        parentSnapshotSHA256: 'b'.repeat(64),
        accountId: 'c'.repeat(32),
        bucket: 'private-test',
        fetcher: async () => {
          calls++;
          return status === 409
            ? new Response('Parent changed', { status })
            : Response.json({ parentSnapshotSHA256: 'f'.repeat(64), objects: [] });
        },
      });
    await assert.rejects(() => bucket.get(source.key));
    assert.equal(calls, 1);
  }
});
