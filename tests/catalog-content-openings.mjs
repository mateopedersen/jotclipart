import test from 'node:test';
import assert from 'node:assert/strict';
import { facetStore, digest, emitDirectory } from '../server/catalog-collections/store.mjs';
import {
  collectionOpening,
  collectionIntroductionTemplate,
  collectionSourceSignature,
} from '../scripts/collection-editorial.mjs';
import { refreshCollectionOpenings } from '../scripts/catalog-snapshot/refresh-openings.mjs';
async function fixture() {
  const objects = new Map(),
    bucket = {
      get: async (k) => {
        const b = objects.get(k);
        return b ? { size: b.length, arrayBuffer: async () => b } : null;
      },
      put: async (k, b) => {
        objects.set(k, b);
        return { etag: 'test' };
      },
    },
    store = facetStore(bucket, { writable: true });
  const opening = 'Round apples bring a familiar fruit shape to this collection.',
    row = {
      slug: 'apple',
      exact: await digest(opening.toLowerCase()),
      template: await digest(collectionIntroductionTemplate('apple', opening)),
      inventory: '1'.repeat(64),
    },
    old = { topicCount: 1, openingIndex: await emitDirectory(store, [row], 'collection') },
    current = { ...old, topicCount: 2 },
    art = {
      id: 'pear-one',
      title: 'Pear with a Leaf',
      alt: 'A green pear with a leaf',
      files: { webp: { sha256: '2'.repeat(64) } },
    },
    summary = 'Pears with long stems and small leaves fill these drawings.',
    record = {
      summary,
      paragraphs: [summary],
      editorial: {
        intro: summary,
        paragraphs: [summary],
        paragraphSourceSha256: await digest(
          JSON.stringify([collectionSourceSignature([art]), summary]),
        ),
      },
    },
    t = { slug: 'pear', record, artworkIds: [art.id] },
    reads = [];
  return {
    bucket,
    store,
    old,
    current,
    row,
    t,
    readArtwork: async (id) => {
      reads.push(id);
      assert.equal(id, art.id);
      return art;
    },
    reads,
  };
}
test('new content maintains unique opening and inventory fingerprints using only the changed topic artwork', async () => {
  const f = await fixture(),
    d = await refreshCollectionOpenings({
      bucket: f.bucket,
      parentContext: { getFacet: async () => f.old },
      context: { getFacet: async () => f.current },
      topicChanges: [f.t],
      readArtwork: f.readArtwork,
    });
  assert.deepEqual(f.reads, ['pear-one']);
  const c = await f.store.read('collections', d),
    index = await f.store.read('collections', c.openingIndex);
  assert.equal(index.entries.length, 2);
  assert.deepEqual(
    index.entries.find((r) => r.slug === 'apple'),
    f.row,
  );
  assert.equal(
    index.entries.find((r) => r.slug === 'pear').inventory,
    collectionSourceSignature([await f.readArtwork('pear-one')]),
  );
});
test('changed topic cannot introduce an existing opening or a stale inventory signature', async () => {
  for (const duplicate of [true, false]) {
    const f = await fixture();
    if (duplicate) {
      f.t.record.paragraphs[0] = 'Round apples bring a familiar fruit shape to this collection.';
      f.t.record.editorial.paragraphs = f.t.record.paragraphs;
      f.t.record.editorial.paragraphSourceSha256 = await digest(
        JSON.stringify([
          collectionSourceSignature([await f.readArtwork('pear-one')]),
          f.t.record.summary,
        ]),
      );
    } else f.t.record.editorial.paragraphSourceSha256 = 'f'.repeat(64);
    await assert.rejects(() =>
      refreshCollectionOpenings({
        bucket: f.bucket,
        parentContext: { getFacet: async () => f.old },
        context: { getFacet: async () => f.current },
        topicChanges: [f.t],
        readArtwork: f.readArtwork,
      }),
    );
  }
});
