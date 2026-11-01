import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrefixInventoryReader as createInitialInventoryReader } from '../scripts/delivery/prefix-inventory.mjs';
import { createResilientInventoryReader } from '../scripts/delivery/inventory-reader.mjs';
import { stagingWorker } from '../scripts/delivery/staging-worker.mjs';
import { createSignedInventoryFetch } from '../scripts/delivery/inventory-fetch.mjs';
import { webcrypto } from 'node:crypto';
globalThis.crypto ??= webcrypto;

function fixture(rows, limit = 2) {
  return async ({ prefix = '', grouped, cursor, startAfter }) => {
    assert.equal(startAfter, undefined);
    const direct = [],
      prefixes = new Set();
    for (const item of rows) {
      if (!item.Key.startsWith(prefix)) continue;
      const suffix = item.Key.slice(prefix.length),
        i = suffix.indexOf('/');
      if (grouped && i >= 0) prefixes.add(prefix + suffix.slice(0, i + 1));
      else direct.push(item);
    }
    const entries = [
      ...direct.map((object) => ({ object })),
      ...[...prefixes].map((prefix) => ({ prefix })),
    ].sort((a, b) => {
      const x = a.object?.Key ?? a.prefix,
        y = b.object?.Key ?? b.prefix;
      if (x === y) return 0;
      if (x.startsWith(y)) return -1;
      if (y.startsWith(x)) return 1;
      return x < y ? -1 : 1;
    });
    const start = cursor ? Number(cursor) : 0,
      part = entries.slice(start, start + limit),
      next = start + part.length;
    return {
      Contents: part.filter((x) => x.object).map((x) => x.object),
      CommonPrefixes: part.filter((x) => x.prefix).map((x) => x.prefix),
      IsTruncated: next < entries.length,
      ...(next < entries.length ? { NextContinuationToken: String(next) } : {}),
    };
  };
}
test('disjoint prefix grouping covers direct and nested keys, partial prefix families, leading slash and Unicode', async () => {
  const names = [
    'root',
    'root.long',
    'a',
    'a/',
    'a/a',
    'a/abc',
    'a/a/b',
    'a/a/b/',
    'a/a/b/z',
    'a//double',
    '/leading',
    '/',
    '😀/雪',
    '😀/雪/p',
    'd/last',
    'd/last.long',
  ];
  const rows = names.map((Key, Size) => ({ Key, Size }));
  for (const [splitThreshold, adaptive, followOnlyChild] of [
    [0, false, false],
    [2, false, false],
    [100, false, false],
    [0, true, false],
    [2, true, true],
  ]) {
    const result = await createInitialInventoryReader({
      fetchPage: fixture(rows),
      concurrency: 3,
      splitThreshold,
      adaptive,
      followOnlyChild,
    })({ bucket: 'test', jurisdiction: 'default' });
    assert.equal(result.IsTruncated, false);
    assert.equal(result.Contents.length, rows.length);
    assert.deepEqual(result.Contents.map((x) => x.Key).sort(), names.sort());
  }
});
test('adaptive partitions preserve terminal objects that are strict prefixes and split shared initial runs', async () => {
  const names = [
    'folder/long',
    'folder/long0',
    'folder/long00',
    'folder/long00/child',
    ...Array.from({ length: 200 }, (_, i) => `folder/long${String(i).padStart(4, '0')}/file`),
  ];
  const rows = names.map((Key, Size) => ({ Key, Size }));
  const result = await createInitialInventoryReader({
    fetchPage: fixture(rows, 17),
    concurrency: 8,
    adaptive: true,
  })({ bucket: 'test', jurisdiction: 'default' });
  assert.equal(result.Contents.length, rows.length);
  assert.deepEqual(result.Contents.map((x) => x.Key).sort(), names.sort());
});
test('adaptive partition union equals full inventory over many deterministic varied keyspaces', async () => {
  let seed = 712367;
  const next = () => (seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32,
    alphabet = ['a', 'b', '1', '2', '😀', '雪', '.', '/'];
  for (let round = 0; round < 25; round++) {
    const names = new Set(['top/', 'top/a', 'top/a/b', 'top/a/b/c', '😀/雪']);
    for (let i = 0; i < 180; i++) {
      let x = next() < 0.7 ? 'top/' : '';
      const n = 1 + Math.floor(next() * 15);
      for (let j = 0; j < n; j++) x += alphabet[Math.floor(next() * alphabet.length)];
      names.add(x);
    }
    const rows = [...names].map((Key, Size) => ({ Key, Size }));
    const result = await createInitialInventoryReader({
      fetchPage: fixture(rows, 1 + Math.floor(next() * 20)),
      concurrency: 8,
      splitThreshold: 2,
      adaptive: true,
      followOnlyChild: true,
    })({});
    assert.deepEqual(result.Contents.map((x) => x.Key).sort(), [...names].sort());
  }
});
test('fails closed on duplicates and objects outside the selected prefix', async () => {
  const dup = fixture([
    { Key: 'a/x', Size: 1 },
    { Key: 'a/x', Size: 1 },
  ]);
  await assert.rejects(createInitialInventoryReader({ fetchPage: dup })({}), /Invalid/);
  const bad = async ({ prefix, grouped }) =>
    prefix === ''
      ? { Contents: [], CommonPrefixes: ['a/'], IsTruncated: false }
      : grouped
        ? { Contents: [{ Key: 'a/x', Size: 1 }], CommonPrefixes: [], IsTruncated: false }
        : { Contents: [{ Key: 'b/x', Size: 1 }], CommonPrefixes: [], IsTruncated: false };
  await assert.rejects(createInitialInventoryReader({ fetchPage: bad })({}), /Invalid/);
});
test('fails closed on malformed prefixes, incomplete and looping cursor pages', async () => {
  for (const page of [
    { Contents: [], CommonPrefixes: [], IsTruncated: true },
    { Contents: [], CommonPrefixes: [], IsTruncated: true, NextContinuationToken: 'same' },
    { Contents: [], CommonPrefixes: ['a/b/'], IsTruncated: false },
    { Contents: [{ Key: 'bad/path', Size: 1 }], CommonPrefixes: [], IsTruncated: false },
    { Contents: [{ Key: 'root', Size: -1 }], CommonPrefixes: [], IsTruncated: false },
    { Contents: [], IsTruncated: false },
  ])
    await assert.rejects(createInitialInventoryReader({ fetchPage: async () => page })({}));
});
test('rechecks discovered roots and fails closed when another writer changes a prefix', async () => {
  let rootReads = 0;
  const old = fixture([{ Key: 'a/file', Size: 1 }], 1000),
    changed = fixture(
      [
        { Key: 'a/file', Size: 1 },
        { Key: 'new/file', Size: 2 },
      ],
      1000,
    );
  const fetchPage = (command) =>
    command.prefix === '' && command.grouped && ++rootReads > 1 ? changed(command) : old(command);
  await assert.rejects(createInitialInventoryReader({ fetchPage })({}), /discovery changed/);
});
test('unordered ranges retry the complete bucket and remember only a per-session read strategy', async () => {
  const rows = [
      { Key: 'a', Size: 1 },
      { Key: 'a/file', Size: 2 },
      { Key: 'a/file-long', Size: 3 },
      { Key: 'z/file', Size: 4 },
    ],
    stable = fixture(rows, 2);
  let unorderedCalls = 0,
    treeCalls = 0;
  const fallback = () => {
      throw Error('Not expected');
    },
    seen = new Set();
  const read = createResilientInventoryReader({
    buckets: [{ bucket: 'example', jurisdiction: 'default', bounds: [] }],
    unorderedBuckets: seen,
    preferPrefix: false,
    fetchPage: async (command) => {
      if (command.treeRead) {
        treeCalls++;
        return stable(command);
      }
      unorderedCalls++;
      return {
        Contents: [
          { Key: 'z', Size: 1 },
          { Key: 'a', Size: 1 },
        ],
        IsTruncated: false,
      };
    },
  });
  const first = await read({ bucket: 'example', jurisdiction: 'default' }, fallback);
  assert.deepEqual(first.Contents.map((x) => x.Key).sort(), rows.map((x) => x.Key).sort());
  assert.equal(unorderedCalls, 1);
  assert(seen.has('default/example'));
  const before = treeCalls,
    second = await read({ bucket: 'example', jurisdiction: 'default' }, fallback);
  assert.equal(unorderedCalls, 1);
  assert(treeCalls > before);
  assert.equal(second.Contents.length, rows.length);
});
test('bad data cannot trigger an order fallback and unknown buckets keep their original transport', async () => {
  let reads = 0;
  const read = createResilientInventoryReader({
    buckets: [{ bucket: 'example', jurisdiction: 'default', bounds: [] }],
    preferPrefix: false,
    fetchPage: async () => {
      reads++;
      return { Contents: [{ Key: 'bad', Size: -1 }], IsTruncated: false };
    },
  });
  await assert.rejects(
    read({ bucket: 'example', jurisdiction: 'default' }, () => {}),
    /Invalid bound/,
  );
  assert.equal(reads, 1);
  const answer = { IsTruncated: false, Contents: [] };
  assert.equal(await read({ bucket: 'new', jurisdiction: 'default' }, () => answer), answer);
});
test('the default always uses complete prefix coverage, even when ranges look ordered', async () => {
  const rows = [
      { Key: 'a', Size: 1 },
      { Key: 'a/x', Size: 2 },
    ],
    stable = fixture(rows),
    read = createResilientInventoryReader({
      buckets: [{ bucket: 'example', jurisdiction: 'default', bounds: ['a'] }],
      fetchPage: (command) => {
        assert.equal(command.treeRead, true);
        return stable(command);
      },
    });
  const out = await read({ bucket: 'example', jurisdiction: 'default' }, () => {
    throw Error('Unexpected fallback');
  });
  assert.deepEqual(out.Contents.map((x) => x.Key).sort(), rows.map((x) => x.Key).sort());
});
test('signed production worker supports prefix grouping without exposing a write or permitting startAfter', async () => {
  const secret = 'cd'.repeat(32),
    job = {
      root: 'r',
      revision: 'x',
      secret,
      inventoryPages: 4,
      inventoryBuckets: [{ bucket: 'example', jurisdiction: 'default', binding: 'BUCKET' }],
    };
  const options = [],
    worker = stagingWorker(job),
    env = {
      BUCKET: {
        list: async (o) => {
          options.push(o);
          return {
            objects: [{ key: 'a/file', size: 7 }],
            delimitedPrefixes: ['a/b/'],
            truncated: false,
          };
        },
      },
    };
  const fetchPage = createSignedInventoryFetch({
    secret,
    fetcher: (url, init) => worker.fetch(new Request(url, init), env),
  });
  const got = await fetchPage({
    bucket: 'example',
    jurisdiction: 'default',
    treeRead: true,
    prefix: 'a/',
    grouped: true,
  });
  assert.deepEqual(got.Contents, [{ Key: 'a/file', Size: 7 }]);
  assert.deepEqual(got.CommonPrefixes, ['a/b/']);
  assert.equal(options[0].prefix, 'a/');
  assert.equal(options[0].delimiter, '/');
  await assert.rejects(
    fetchPage({
      bucket: 'example',
      jurisdiction: 'default',
      treeRead: true,
      prefix: 'a/',
      grouped: true,
      startAfter: 'a/old',
    }),
    /409/,
  );
});
test('actual signed worker and resilient reader reconstruct the complete unordered bucket', async () => {
  const secret = 'ab'.repeat(32),
    job = {
      root: 'r',
      revision: 'x',
      secret,
      inventoryPages: 4,
      inventoryBuckets: [{ bucket: 'example', jurisdiction: 'default', binding: 'BUCKET' }],
    },
    rows = [
      { Key: 'a', Size: 1 },
      { Key: 'a/file', Size: 2 },
      { Key: 'a/file-long', Size: 3 },
      { Key: 'z/file', Size: 4 },
    ],
    stable = fixture(rows, 100),
    worker = stagingWorker(job);
  const env = {
    BUCKET: {
      list: async ({ prefix, delimiter, cursor }) => {
        if (prefix === undefined && delimiter === undefined && !cursor)
          return {
            objects: [
              { key: 'z', size: 1 },
              { key: 'a', size: 1 },
            ],
            delimitedPrefixes: [],
            truncated: false,
          };
        const page = await stable({ prefix: prefix ?? '', grouped: delimiter === '/', cursor });
        return {
          objects: page.Contents.map((x) => ({ key: x.Key, size: x.Size })),
          delimitedPrefixes: page.CommonPrefixes,
          truncated: page.IsTruncated,
          cursor: page.NextContinuationToken,
        };
      },
    },
  };
  const fetchPage = createSignedInventoryFetch({
    secret,
    fetcher: (url, init) => worker.fetch(new Request(url, init), env),
  });
  const read = createResilientInventoryReader({
    buckets: [{ bucket: 'example', jurisdiction: 'default', bounds: [] }],
    fetchPage,
    preferPrefix: false,
  });
  const out = await read({ bucket: 'example', jurisdiction: 'default' }, () => {
    throw Error('Unexpected fallback');
  });
  assert.deepEqual(out.Contents.map((x) => x.Key).sort(), rows.map((x) => x.Key).sort());
  assert.equal(out.IsTruncated, false);
});
