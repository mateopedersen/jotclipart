import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  compileCollectionSnapshots,
  readCollectionSnapshotSource,
} from '../scripts/collection-snapshots.mjs';
import { clustersForTopic, primaryClusterForTopic } from '../src/lib/topic-clusters.ts';
import { collectionMetaDescription } from '../src/lib/collection-meta.mjs';
import {
  collectionParagraphSignature,
  collectionParagraphReviewSignature,
  collectionSourceSignature,
} from '../scripts/collection-editorial.mjs';

const source = readCollectionSnapshotSource(process.cwd());
const result = compileCollectionSnapshots(source);
const objects = new Map(result.objects.map((object) => [object.key, object]));
const read = (descriptor) => {
  const object = objects.get(descriptor.key);
  assert.ok(object, descriptor.key);
  assert.equal(object.body.length, descriptor.bytes);
  assert.equal(createHash('sha256').update(object.body).digest('hex'), descriptor.sha256);
  return JSON.parse(object.body);
};
const clone = (x) => JSON.parse(JSON.stringify(x));
const fixtureSlug = 'qatar-flag';
function fixture() {
  return {
    ...source,
    catalog: source.catalog.filter((item) => item.topic === fixtureSlug),
    resolvedCatalog: source.resolvedCatalog.filter((item) => item.topic === fixtureSlug),
    topics: source.topics.filter((item) => item.slug === fixtureSlug),
    registry: { schema: 1, topics: { [fixtureSlug]: clone(source.registry.topics[fixtureSlug]) } },
  };
}

test('every public topic preserves reviewed copy, exact gallery order and original identity', () => {
  const publicArt = source.resolvedCatalog.filter((item) => item.published && item.indexable);
  const definitions = new Map(source.topics.map((topic) => [topic.slug, topic]));
  assert.equal(result.index.topicCount, new Set(publicArt.map((item) => item.topic)).size);
  assert.equal(result.index.artworkCount, publicArt.length);
  const allIds = new Set();
  for (const entry of result.index.topics) {
    const record = read(entry),
      topic = definitions.get(entry.slug);
    const review = source.registry.topics[entry.slug];
    assert.deepEqual(record.editorial, review);
    assert.deepEqual(record.paragraphs, review.paragraphs);
    assert.equal(record.summary, review.intro);
    assert.equal(record.metaDescription, collectionMetaDescription(review.intro).text);
    assert.equal(record.canonical, `https://ultraclipart.com/clipart/${entry.slug}/`);
    assert.equal(record.title, topic.keyword.replace('clipart', 'Clipart'));
    assert.equal(record.primaryCluster, primaryClusterForTopic(topic));
    assert.deepEqual(
      record.clusters.map((cluster) => cluster.name),
      clustersForTopic(topic),
    );
    const rank = new Map((source.copy[entry.slug]?.featured ?? []).map((id, i) => [id, i]));
    const expectedIds = publicArt
      .filter((item) => item.topic === entry.slug)
      .sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999))
      .map((item) => item.id);
    const ids = record.membership.flatMap((part) => read(part).artworkIds);
    assert.deepEqual(ids, expectedIds);
    assert.equal(record.artworkCount, ids.length);
    assert.equal(record.coverArtworkId, ids[0]);
    for (const id of ids) {
      assert.ok(!allIds.has(id));
      allIds.add(id);
    }
    for (const related of record.related) {
      assert.notEqual(related.slug, entry.slug);
      const relatedArt = publicArt.filter((item) => item.topic === related.slug);
      assert.equal(related.artworkCount, relatedArt.length);
      const cover =
        (source.copy[related.slug]?.featured ?? []).find((id) =>
          relatedArt.some((item) => item.id === id),
        ) ?? relatedArt[0].id;
      assert.equal(related.coverArtworkId, cover);
    }
  }
  assert.equal(allIds.size, publicArt.length);
});

test('serialization is deterministic and every object is content-addressed and bounded', () => {
  const again = compileCollectionSnapshots(source);
  assert.equal(again.indexSha256, result.indexSha256);
  assert.deepEqual(again.indexBytes, result.indexBytes);
  assert.equal(again.objects.length, result.objects.length);
  for (let i = 0; i < result.objects.length; i++) {
    const object = result.objects[i];
    assert.deepEqual(again.objects[i].body, object.body);
    assert.ok(object.key.endsWith(`/${object.sha256}.json`));
    assert.ok(object.bytes <= 256 * 1024);
  }
});

test('bounded membership partitions retain complete ordered membership', () => {
  const compiled = compileCollectionSnapshots(fixture(), { membershipLimit: 8 });
  const localObjects = new Map(
    compiled.objects.map((object) => [object.key, JSON.parse(object.body)]),
  );
  const topic = localObjects.get(compiled.index.topics[0].key);
  let count = 0;
  for (const descriptor of topic.membership) {
    assert.equal(descriptor.offset, count);
    const part = localObjects.get(descriptor.key);
    assert.equal(part.offset, count);
    assert.equal(part.artworkIds.length, descriptor.count);
    assert.ok(descriptor.count <= 8);
    count += descriptor.count;
  }
  assert.equal(count, compiled.index.artworkCount);
  assert.ok(topic.membership.length > 1);
  assert.throws(
    () => compileCollectionSnapshots(fixture(), { membershipLimit: 257 }),
    /membershipLimit/,
  );
});

test('new reviewed topic appears automatically; source and wording changes invalidate approval', () => {
  const next = fixture();
  const oldSlug = fixtureSlug,
    newSlug = 'snapshot-test-topic';
  next.catalog = next.catalog.map((item) => ({ ...item, topic: newSlug }));
  next.resolvedCatalog = next.resolvedCatalog.map((item) => ({ ...item, topic: newSlug }));
  next.topics = [{ ...next.topics[0], slug: newSlug }];
  const review = next.registry.topics[oldSlug];
  next.registry = { schema: 1, topics: { [newSlug]: review } };
  review.sourceSha256 = collectionSourceSignature(next.catalog);
  review.paragraphSourceSha256 = collectionParagraphSignature(next.resolvedCatalog, review.intro);
  review.paragraphReviewSha256 = collectionParagraphReviewSignature(review);
  assert.equal(compileCollectionSnapshots(next).index.topics[0].slug, newSlug);
  // This is a structural fixture, not a claim of approving or writing a real new topic.
  next.registry.topics[newSlug].paragraphs[1] += ' Changed wording.';
  assert.throws(() => compileCollectionSnapshots(next), /renewed catalog check/);
  const stale = fixture();
  stale.resolvedCatalog = stale.resolvedCatalog.map((item, i) =>
    i ? item : { ...item, title: 'Changed accepted title' },
  );
  assert.throws(() => compileCollectionSnapshots(stale), /stale expanded introduction/);
});

test('unsafe paths, missing records, duplicate identity and unregistered public topics fail closed', () => {
  const duplicate = fixture();
  duplicate.catalog = [...duplicate.catalog, duplicate.catalog[0]];
  assert.throws(() => compileCollectionSnapshots(duplicate), /Duplicate source artwork/);
  const incomplete = fixture();
  incomplete.resolvedCatalog = incomplete.resolvedCatalog.slice(1);
  assert.throws(() => compileCollectionSnapshots(incomplete), /incomplete/);
  const identity = fixture();
  identity.resolvedCatalog = identity.resolvedCatalog.map((item, i) =>
    i ? item : { ...item, topic: 'changed-topic' },
  );
  assert.throws(() => compileCollectionSnapshots(identity), /identity changed/);
  const unregistered = fixture();
  unregistered.topics = [];
  assert.throws(() => compileCollectionSnapshots(unregistered), /Unregistered public topic/);
  const unsafe = fixture();
  unsafe.topics = [{ ...unsafe.topics[0], slug: '../outside' }];
  assert.throws(() => compileCollectionSnapshots(unsafe), /Invalid topic slug/);
  const definitions = fixture();
  definitions.topics = [...definitions.topics, definitions.topics[0]];
  assert.throws(() => compileCollectionSnapshots(definitions), /Duplicate topic definition/);
});
