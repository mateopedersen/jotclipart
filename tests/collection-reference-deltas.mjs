import test from 'node:test';
import assert from 'node:assert/strict';
import {
  facetStore,
  bytesOf,
  digest,
  lookupTopic,
  emitDirectory,
  patchTopic,
} from '../server/catalog-collections/store.mjs';
import { applyCollectionBatch } from '../server/catalog-collections/writer.mjs';
import {
  readCollectionReferences,
  referenceCountValues,
} from '../server/catalog-collections/reader.mjs';
// These are deliberately fictional private protocol records, never content/image approvals.
const artwork = (id, topic) => ({
  id,
  topic,
  title: 'Private fixture ' + id,
  alt: 'Private protocol fixture',
  description: 'Private metadata fixture only.',
  published: true,
  indexable: true,
  width: 100,
  height: 100,
  monochrome: id === 'fixture-a1',
  webp: `https://assets.ultraclipart.com/private-fixture/${id}.webp`,
  pdf: `https://assets.ultraclipart.com/private-fixture/${id}.pdf`,
  thumb: `https://assets.ultraclipart.com/private-fixture/${id}.webp`,
  files: {
    webp: { bytes: 100, sha256: 'a'.repeat(64) },
    pdf: { bytes: 100, sha256: 'b'.repeat(64) },
  },
});
function metadata(slug, ids, related = []) {
  const summary = 'Private ' + slug + ' metadata fixture.',
    paragraphs = [
      `Private ${slug} fixture with {{artworkCount}}.`,
      `A second private paragraph for ${slug}.`,
    ];
  return {
    schema: 1,
    type: 'collection-topic',
    slug,
    path: `/clipart/${slug}/`,
    canonical: `https://ultraclipart.com/clipart/${slug}/`,
    title: slug + ' Clipart',
    keyword: slug + ' clipart',
    summary,
    metaDescription: summary,
    primaryCluster: 'Fixture',
    sourceCluster: 'Fixture',
    clusters: [{ name: 'Fixture', path: '/collection/fixture/' }],
    paragraphs,
    editorial: { status: 'PRIVATE_TEST_FIXTURE_NOT_REVIEW_APPROVAL', intro: summary, paragraphs },
    artworkCount: ids.length,
    coverArtworkId: ids[0],
    related: related.map((slug) => ({
      slug,
      artworkCount: 999,
      coverArtworkId: 'deliberately-stale-copy',
    })),
    membership: [],
    pageBlocks: [],
    relatedContext: [{ deliberately: 'ignored in v2' }],
  };
}
async function fixture() {
  const objects = new Map(),
    calls = { gets: 0, puts: [] },
    bucket = {
      async get(key) {
        calls.gets++;
        const b = objects.get(key);
        return b ? { size: b.length, arrayBuffer: async () => b.slice().buffer } : null;
      },
      async put(key, b) {
        calls.puts.push(key);
        objects.set(key, new Uint8Array(b));
        return { etag: 'private-unit' };
      },
    },
    store = facetStore(bucket, { writable: true }),
    records = new Map(
      ['fixture-a1', 'fixture-a2', 'fixture-b1', 'fixture-b2'].map((id) => [
        id,
        artwork(id, id.includes('-a') ? 'subject-a' : 'subject-b'),
      ]),
    ),
    entries = [];
  for (const [slug, ids, related] of [
    ['subject-a', ['fixture-a1', 'fixture-a2'], ['subject-b']],
    ['subject-b', ['fixture-b1', 'fixture-b2'], []],
  ]) {
    const r = metadata(slug, ids, related);
    r.membership = [
      {
        offset: 0,
        count: ids.length,
        ...(await store.put('collections', {
          type: 'collection-members',
          slug,
          offset: 0,
          artworkIds: ids,
        })),
      },
    ];
    r.pageBlocks = [
      {
        offset: 0,
        count: ids.length,
        ...(await store.put('collections', {
          type: 'collection-page-artworks',
          slug,
          offset: 0,
          artworks: ids.map((id) => ({ ...records.get(id), title: 'STALE DUPLICATED TITLE' })),
        })),
      },
    ];
    entries.push({
      slug,
      path: r.path,
      artworkCount: ids.length,
      ...(await store.put('collections', r)),
    });
  }
  const directory = await emitDirectory(store, entries, 'collection'),
    topics = await emitDirectory(
      store,
      [
        { slug: 'subject-a', count: 2 },
        { slug: 'subject-b', count: 2 },
      ],
      'count',
    ),
    global = await store.put('counts', {
      type: 'catalog-counts',
      version: 'a'.repeat(16),
      totals: { artworks: 4, subjects: 2, collections: 1, printable: 1 },
      collections: { fixture: { artworks: 4, subjects: 2 } },
    }),
    sharedContext = await store.put('collections', {
      ids: ['fixture-a1'],
      artworks: [{ ...records.get('fixture-a1'), title: 'STALE SHARED TITLE' }],
      surprise: [],
    }),
    roots = {
      collections: await store.put('collections', {
        type: 'collection-directory',
        viewProtocol: 'collection-references-v2',
        topicCount: 2,
        artworkCount: 4,
        directory,
        sharedContext,
      }),
      counts: await store.put('counts', {
        type: 'catalog-count-directory',
        topicCount: 2,
        artworkCount: 4,
        topics,
        global,
      }),
      artworks: await store.put('artworks', {
        type: 'private-unit-canonical-artworks',
        records: Object.fromEntries(records),
      }),
    };
  const context = async (roots) => {
    const scoped = facetStore(bucket),
      rootSHA256 = await digest(bytesOf(roots));
    return {
      snapshot: { revision: 'a'.repeat(40), fixture: true },
      rootSHA256,
      read: scoped.read,
      getFacet: (name) => scoped.read(name, roots[name]),
      objectsRead: () => scoped.metrics().reads,
    };
  };
  const resolve = async (id, ctx) => ({
    rootSHA256: ctx.rootSHA256,
    artwork: (await ctx.getFacet('artworks')).records[id],
  });
  const options = async (before, after) => {
    const b = await context(before),
      a = await context(after);
    return {
      expectedCollectionsSha256: before.collections.sha256,
      expectedCountsSha256: before.counts.sha256,
      validateSourceTopic: async ({ change }) => ({
        oldRecordSha256: change.expectedRecordSha256,
        newRecordSha256: change.record ? await digest(bytesOf(change.record)) : null,
      }),
      resolveBeforeArtwork: async (id) => (await resolve(id, b)).artwork,
      resolveAfterArtwork: async (id) => (await resolve(id, a)).artwork,
    };
  };
  const record = async (roots, slug) => {
    const root = await store.read('collections', roots.collections),
      entry = await lookupTopic(store, root.directory, 'collection', slug);
    return { entry, record: await store.read('collections', entry) };
  };
  return { objects, calls, bucket, store, records, roots, context, resolve, options, record };
}

test('v2 uses captured canonical gallery, related counts and shared facts instead of stale DTO copies', async () => {
  const f = await fixture(),
    ctx = await f.context(f.roots),
    r = await readCollectionReferences(ctx, 'subject-a', { resolveArtwork: f.resolve });
  assert.equal(r.state.counts.topics['subject-b'], 2);
  assert.equal(r.state.art.find((a) => a.id === 'fixture-a1').title, 'Private fixture fixture-a1');
  assert(!r.state.art.some((a) => a.title.includes('STALE')));
  assert.equal(r.rootSHA256, ctx.rootSHA256);
});
test('append changes only target record while inbound counts and old snapshot remain correct', async () => {
  const f = await fixture(),
    before = f.roots,
    target = await f.record(before, 'subject-b'),
    aEntry = (await f.record(before, 'subject-a')).entry,
    added = artwork('fixture-b3', 'subject-b'),
    records = new Map(f.records).set(added.id, added),
    afterArt = {
      ...before,
      artworks: await f.store.put('artworks', {
        type: 'private-unit-canonical-artworks',
        records: Object.fromEntries(records),
      }),
    },
    changed = { ...target.record, artworkCount: 3 };
  const out = await applyCollectionBatch(
      f.store,
      before,
      [
        {
          slug: 'subject-b',
          expectedRecordSha256: target.entry.sha256,
          record: changed,
          artworkIds: ['fixture-b1', 'fixture-b2', 'fixture-b3'],
        },
      ],
      await f.options(before, afterArt),
    ),
    after = { ...afterArt, collections: out.collections, counts: out.counts };
  assert.deepEqual((await f.record(after, 'subject-a')).entry, aEntry);
  const current = await readCollectionReferences(await f.context(after), 'subject-a', {
      resolveArtwork: f.resolve,
    }),
    old = await readCollectionReferences(await f.context(before), 'subject-a', {
      resolveArtwork: f.resolve,
    });
  assert.equal(current.state.counts.topics['subject-b'], 3);
  assert.equal(old.state.counts.topics['subject-b'], 2);
  assert.equal(current.state.counts.totals.artworks, 5);
  assert(f.calls.puts.every((key) => key.startsWith('catalog/objects/')));
});
test('same-ID media/title replacement comes from the new artwork root without rewriting collection copies', async () => {
  const f = await fixture(),
    records = new Map(f.records),
    changed = {
      ...records.get('fixture-a1'),
      title: 'NEW PRIVATE CANONICAL TITLE',
      webp: 'https://assets.ultraclipart.com/private-fixture/replaced.webp',
      thumb: 'https://assets.ultraclipart.com/private-fixture/replaced.webp',
      files: { ...records.get('fixture-a1').files, webp: { bytes: 200, sha256: 'c'.repeat(64) } },
    };
  records.set(changed.id, changed);
  const roots = {
      ...f.roots,
      artworks: await f.store.put('artworks', {
        type: 'private-unit-canonical-artworks',
        records: Object.fromEntries(records),
      }),
    },
    current = await readCollectionReferences(await f.context(roots), 'subject-a', {
      resolveArtwork: f.resolve,
    }),
    old = await readCollectionReferences(await f.context(f.roots), 'subject-a', {
      resolveArtwork: f.resolve,
    });
  assert.deepEqual(
    current.state.art.find((a) => a.id === changed.id),
    changed,
  );
  assert.equal(old.state.art.find((a) => a.id === changed.id).title, 'Private fixture fixture-a1');
  assert.equal(roots.collections.sha256, f.roots.collections.sha256);
});
test('stale or absent exact source validation rejects before any collection/count put', async () => {
  for (const mode of ['stale', 'unbound']) {
    const f = await fixture(),
      r = await f.record(f.roots, 'subject-a'),
      store = facetStore(f.bucket, { writable: true }),
      opts = await f.options(f.roots, f.roots);
    if (mode === 'unbound') opts.validateSourceTopic = async () => undefined;
    await assert.rejects(async () =>
      applyCollectionBatch(
        store,
        f.roots,
        [
          {
            slug: 'subject-a',
            expectedRecordSha256: mode === 'stale' ? '0'.repeat(64) : r.entry.sha256,
            record: r.record,
            artworkIds: ['fixture-a1', 'fixture-a2'],
          },
        ],
        opts,
      ),
    );
    assert.equal(store.metrics().puts, 0);
  }
});
test('wrong parent descriptors and bad introduction tokens fail before staging', async () => {
  const f = await fixture(),
    r = await f.record(f.roots, 'subject-a'),
    store = facetStore(f.bucket, { writable: true });
  await assert.rejects(
    async () =>
      applyCollectionBatch(store, f.roots, [], {
        ...(await f.options(f.roots, f.roots)),
        expectedCountsSha256: '0'.repeat(64),
      }),
    /parent/,
  );
  const invalid = {
    ...r.record,
    paragraphs: ['Missing count token.', 'Private second paragraph.'],
  };
  invalid.editorial = { ...invalid.editorial, paragraphs: invalid.paragraphs };
  await assert.rejects(
    async () =>
      applyCollectionBatch(
        store,
        f.roots,
        [
          {
            slug: 'subject-a',
            expectedRecordSha256: r.entry.sha256,
            record: invalid,
            artworkIds: ['fixture-a1', 'fixture-a2'],
          },
        ],
        await f.options(f.roots, f.roots),
      ),
    /topic identity/,
  );
  assert.equal(store.metrics().puts, 0);
});
test('new topic, removal and inbound filtering need no referring-page fanout', async () => {
  const f = await fixture(),
    before = f.roots,
    a = await f.record(before, 'subject-a'),
    art = artwork('fixture-c1', 'subject-c'),
    records = new Map(f.records).set(art.id, art),
    afterArt = {
      ...before,
      artworks: await f.store.put('artworks', {
        type: 'private-unit-canonical-artworks',
        records: Object.fromEntries(records),
      }),
    },
    newTopic = metadata('subject-c', [art.id]),
    aRecord = { ...a.record, related: [{ slug: 'subject-b' }, { slug: 'subject-c' }] },
    changes = [
      { slug: 'subject-c', expectedRecordSha256: null, record: newTopic, artworkIds: [art.id] },
      {
        slug: 'subject-a',
        expectedRecordSha256: a.entry.sha256,
        record: aRecord,
        artworkIds: ['fixture-a1', 'fixture-a2'],
      },
    ],
    out = await applyCollectionBatch(f.store, before, changes, await f.options(before, afterArt)),
    created = { ...afterArt, collections: out.collections, counts: out.counts };
  assert.equal(
    (
      await readCollectionReferences(await f.context(created), 'subject-a', {
        resolveArtwork: f.resolve,
      })
    ).state.counts.topics['subject-c'],
    1,
  );
  const c = await f.record(created, 'subject-c'),
    aBefore = (await f.record(created, 'subject-a')).entry;
  records.delete(art.id);
  const afterRemovalArt = {
      ...created,
      artworks: await f.store.put('artworks', {
        type: 'private-unit-canonical-artworks',
        records: Object.fromEntries(records),
      }),
    },
    removed = await applyCollectionBatch(
      f.store,
      created,
      [{ slug: 'subject-c', expectedRecordSha256: c.entry.sha256, record: null }],
      await f.options(created, afterRemovalArt),
    ),
    after = { ...afterRemovalArt, collections: removed.collections, counts: removed.counts };
  assert.deepEqual((await f.record(after, 'subject-a')).entry, aBefore);
  const result = await readCollectionReferences(await f.context(after), 'subject-a', {
    resolveArtwork: f.resolve,
  });
  assert(!result.state.relations['subject-a'].includes('subject-c'));
  assert.equal(result.state.counts.totals.subjects, 2);
  await assert.rejects(
    async () =>
      readCollectionReferences(await f.context(after), 'subject-c', { resolveArtwork: f.resolve }),
    (e) => e.status === 404,
  );
});
test('a different-root canonical resolver and corrupted objects fail closed', async () => {
  const f = await fixture();
  await assert.rejects(
    async () =>
      readCollectionReferences(await f.context(f.roots), 'subject-a', {
        resolveArtwork: async (id, c) => ({
          ...(await f.resolve(id, c)),
          rootSHA256: '0'.repeat(64),
        }),
      }),
    /root differs/,
  );
  const target = await f.record(f.roots, 'subject-b');
  f.objects.set(target.entry.key, new Uint8Array(target.entry.bytes));
  await assert.rejects(
    async () =>
      readCollectionReferences(await f.context(f.roots), 'subject-a', {
        resolveArtwork: f.resolve,
      }),
    /Corrupt/,
  );
});
test('visible count reads stay bounded and report only requested topic keys', async () => {
  const f = await fixture(),
    ctx = await f.context(f.roots),
    r = await referenceCountValues(ctx, ['subject-a', 'unknown-subject']);
  assert.deepEqual(r.topics, { 'subject-a': 2, 'unknown-subject': 0 });
  await assert.rejects(
    async () => referenceCountValues(ctx, Array(65).fill('subject-a')),
    /Invalid visible/,
  );
});
test('adding a previously absent hash branch preserves siblings; removal restores the root', async () => {
  const f = await fixture(),
    entries = [];
  let n = 0;
  while (entries.length < 180) {
    const slug = 'partition-' + n++;
    if ((await digest(slug)).startsWith('a')) entries.push({ slug, count: 1 });
  }
  let slug;
  for (let i = 0; !slug; i++) {
    const candidate = 'new-partition-' + i;
    if ((await digest(candidate)).startsWith('b')) slug = candidate;
  }
  const root = await emitDirectory(f.store, entries, 'count'),
    before = await f.store.read('counts', root),
    next = await patchTopic(f.store, root, 'count', slug, { slug, count: 2 }),
    after = await f.store.read('counts', next);
  assert.deepEqual(after.children.a, before.children.a);
  assert.equal((await lookupTopic(f.store, next, 'count', slug)).count, 2);
  const restored = await patchTopic(f.store, next, 'count', slug, null);
  assert.deepEqual(restored, root);
});
