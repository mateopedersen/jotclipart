import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadTypescript } from './helpers/typescript.mjs';
import { buildHashedRecordDirectory } from '../server/catalog-snapshot/hashed-record-directory-build.mjs';
import { lookupHashedRecord } from '../server/catalog-snapshot/hashed-record-directory.mjs';
import { serializeRemotePosting } from '../server/catalog-snapshot/related-posting-remote.mjs';
import { makePostingTree } from '../server/catalog-snapshot/related-posting-tree.mjs';
const { applyRelatedBatch } = await loadTypescript('server/catalog-snapshot/related-delta.mjs'),
  { RelatedIndex } = await loadTypescript('src/lib/related/engine.ts');
const canonical = (x) =>
    Array.isArray(x)
      ? x.map(canonical)
      : x && typeof x === 'object'
        ? Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((k) => [k, canonical(x[k])]),
          )
        : x,
  sha = (b) => createHash('sha256').update(b).digest('hex'),
  recordHash = (a) => sha(JSON.stringify(canonical(a)));
async function fixture(provided) {
  const items =
      provided ??
      JSON.parse(readFileSync('data/art.json'))
        .filter((a) => a.published && a.indexable)
        .slice(0, 200),
    index = new RelatedIndex(items),
    objects = new Map(),
    pack = (facet, value) => {
      const b = Buffer.from(JSON.stringify(value)),
        hash = sha(b),
        d = { key: `catalog/objects/${facet}/${hash}.json`, sha256: hash, bytes: b.length };
      objects.set(d.key, b);
      return d;
    },
    shards = new Map(),
    dirs = {};
  for (const a of items) {
    const part = sha(a.id).slice(0, 3);
    if (!shards.has(part)) shards.set(part, []);
    shards.get(part).push(a);
  }
  for (const [part, records] of shards) {
    const prefix = part.slice(0, 2);
    dirs[prefix] ??= { type: 'artwork-directory', prefix, shards: {} };
    dirs[prefix].shards[part] = pack('artworks', { schema: 1, shard: part, records });
  }
  const artworks = pack('artworks', {
      type: 'artwork-root',
      revision: 'a'.repeat(40),
      directories: Object.fromEntries(
        Object.entries(dirs).map(([p, d]) => [p, pack('artworks', d)]),
      ),
    }),
    entries = [];
  const fullBuckets = new Map();
  for (const p of index.profiles.values()) {
    const subject = p.subject?.id,
      keys =
        p.eligible && subject
          ? [
              subject,
              `${subject}:color:${p.colorMode}`,
              ...(p.technique ? [`${subject}:tech:${p.technique}`] : []),
              ...(p.styleFamily ? [`${subject}:family:${p.styleFamily}`] : []),
              ...p.composition.map((c) => `${subject}:comp:${c}`),
            ]
          : [];
    if (p.publicationEligible && index.registeredTopics.has(p.item.topic))
      keys.push('collection:' + p.item.topic);
    for (const key of keys) {
      if (!fullBuckets.has(key)) fullBuckets.set(key, []);
      fullBuckets.get(key).push(p.item);
    }
  }
  for (const [name, rows] of fullBuckets) {
    const built = serializeRemotePosting(
      makePostingTree(rows.map((a) => ({ id: a.id, createdAt: a.createdAt }))),
    );
    for (const [k, b] of built.created) objects.set(k, b);
    entries.push({ name, value: built.root });
  }
  const directory = buildHashedRecordDirectory('related', entries);
  for (const [k, b] of directory.created) objects.set(k, b);
  const related = pack('related', {
    schema: 2,
    type: 'related-posting-index',
    digest: index.digest.toString(),
    version: index.version,
    directory: directory.root,
  });
  let reads = 0;
  const artLeaves = new Set(),
    context = {
      snapshot: { revision: 'a'.repeat(40) },
      getFacet: async (f) => JSON.parse(objects.get(f === 'artworks' ? artworks.key : related.key)),
      read: async (f, d) => {
        reads++;
        const b = objects.get(d.key);
        assert(b && sha(b) === d.sha256 && b.length === d.bytes);
        const value = JSON.parse(Buffer.from(b));
        if (f === 'artworks' && value.shard) artLeaves.add(value.shard);
        return value;
      },
    },
    topicFor = async (slug) => ({ slug, keyword: slug + ' clipart' });
  return { items, index, objects, context, topicFor, artLeaves, reads: () => reads };
}
test('related delta refills exact ranked postings and changes only affected artwork paths', async () => {
  const f = await fixture(),
    edit = {
      ...f.items[0],
      title: f.items[0].title + ' detail',
      createdAt: '2026-11-04T00:00:00Z',
    },
    remove = f.items[1],
    changes = [
      { id: edit.id, expectedPublicSHA256: recordHash(f.items[0]), record: edit },
      { id: remove.id, expectedPublicSHA256: recordHash(remove), record: null },
    ],
    out = await applyRelatedBatch(f.context, changes, {
      beforeTopic: f.topicFor,
      afterTopic: f.topicFor,
    });
  for (const [k, b] of out.created) f.objects.set(k, b);
  const root = JSON.parse(Buffer.from(f.objects.get(out.root.key))),
    expected = new RelatedIndex(
      f.items.filter((a) => a.id !== remove.id).map((a) => (a.id === edit.id ? edit : a)),
    );
  assert.equal(root.digest, expected.digest.toString());
  assert.equal(root.version, expected.version);
  for (const [name, ids] of expected.buckets) {
    const d = await lookupHashedRecord(f.context, 'related', root.directory, name),
      p = JSON.parse(Buffer.from(f.objects.get(d.key)));
    assert.deepEqual(
      p.top.map((a) => a.id),
      ids,
      name,
    );
  }
  assert.equal(f.artLeaves.size, 2);
  assert(f.reads() > 0);
  assert(out.created.size > 0);
  assert(f.context.getFacet);
  const original = f.index.snapshot(f.items[0].id);
  assert.equal(original.version, f.index.version);
});
test('related source mismatch rejects before a candidate can replace the parent', async () => {
  const f = await fixture();
  await assert.rejects(
    () =>
      applyRelatedBatch(
        f.context,
        [{ id: f.items[0].id, expectedPublicSHA256: 'f'.repeat(64), record: null }],
        { beforeTopic: f.topicFor, afterTopic: f.topicFor },
      ),
    /Stale/,
  );
});

test('a saturated related bucket refills from its retained older tail after withdrawals', async () => {
  const sample = JSON.parse(readFileSync('data/art.json')).find((a) => a.published && a.indexable),
    items = Array.from({ length: 350 }, (_, i) => ({
      ...sample,
      id: 'test-related-' + String(i).padStart(4, '0'),
      createdAt: '2026-01-01',
    })),
    f = await fixture(items),
    removed = items.slice(-5),
    changes = removed.map((a) => ({ id: a.id, expectedPublicSHA256: recordHash(a), record: null })),
    out = await applyRelatedBatch(f.context, changes, {
      beforeTopic: f.topicFor,
      afterTopic: f.topicFor,
    });
  for (const [k, b] of out.created) f.objects.set(k, b);
  const root = JSON.parse(Buffer.from(f.objects.get(out.root.key))),
    expected = new RelatedIndex(items.slice(0, -5));
  assert.equal(root.version, expected.version);
  let saturated = 0;
  for (const [name, ids] of expected.buckets) {
    const d = await lookupHashedRecord(f.context, 'related', root.directory, name),
      p = JSON.parse(Buffer.from(f.objects.get(d.key)));
    assert.deepEqual(
      p.top.map((a) => a.id),
      ids,
      name,
    );
    if (ids.length === 96) saturated++;
  }
  assert(saturated > 0);
  assert(f.artLeaves.size <= 5);
  assert(f.reads() < 1000);
});
