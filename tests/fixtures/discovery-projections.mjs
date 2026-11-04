import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const temporary = mkdtempSync(join(tmpdir(), 'uc-discovery-tests-'));
const names = {
  facts: 'server/catalog-projections/facts.mjs',
  pages: 'server/catalog-projections/pages.mjs',
  views: 'server/catalog-projections/views.mjs',
  refresh: 'server/catalog-projections/refresh.mjs',
  shell: 'server/catalog-projections/shell.mjs',
  stage: 'server/catalog-projections/stage-directory.mjs',
  collections: 'server/catalog-collections/store.mjs',
  writer: 'server/catalog-collections/writer.mjs',
  search: 'server/catalog-search/store.mjs',
  ui: 'server/catalog-search/ui-metadata.mjs',
  recent: 'server/catalog-snapshot/recent-ledger.mjs',
  directory: 'server/catalog-snapshot/hashed-record-directory-build.mjs',
  lookup: 'server/catalog-snapshot/hashed-record-directory.mjs',
};
await build({
  stdin: {
    contents: Object.entries(names)
      .map(([name, file]) => `export * as ${name} from ${JSON.stringify(resolve(file))};`)
      .join('\n'),
    resolveDir: process.cwd(),
  },
  outfile: join(temporary, 'api.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
});
const m = await import(pathToFileURL(join(temporary, 'api.mjs')));
process.on('exit', () => rmSync(temporary, { recursive: true, force: true }));
const same = (a, b) => assert.deepEqual(m.search.canonical(a), m.search.canonical(b));
function memory() {
  const objects = new Map(),
    calls = { put: [], get: [] };
  return {
    objects,
    calls,
    async get(key) {
      calls.get.push(key);
      const b = objects.get(key);
      return b ? { size: b.length, arrayBuffer: async () => new Uint8Array(b).buffer } : null;
    },
    async put(key, b, opts) {
      assert.equal(opts.onlyIf.etagDoesNotMatch, '*');
      assert(!objects.has(key), 'immutable overwrite');
      calls.put.push(key);
      objects.set(key, new Uint8Array(b));
      return { etag: 'private-fixture' };
    },
  };
}
async function read(bucket, facet, d) {
  assert(d.key.startsWith(`catalog/objects/${facet}/`));
  const o = await bucket.get(d.key);
  assert(o);
  assert.equal(o.size, d.bytes);
  const b = await o.arrayBuffer();
  assert.equal(await m.search.digest(b), d.sha256);
  return JSON.parse(new TextDecoder().decode(b));
}
async function put(bucket, facet, value) {
  const b = m.collections.bytesOf({ schema: 1, ...value }),
    sha256 = await m.search.digest(b),
    key = `catalog/objects/${facet}/${sha256}.json`;
  if (!bucket.objects.has(key)) await bucket.put(key, b, { onlyIf: { etagDoesNotMatch: '*' } });
  return { key, sha256, bytes: b.length };
}
function artwork(id, topic, extra = {}) {
  return {
    id,
    topic,
    title: `Private fixture ${id}`,
    alt: `Private source fixture ${id}`,
    description: 'Private protocol fixture; no artwork approval.',
    published: true,
    indexable: true,
    style: 'Color',
    color: 'Blue',
    monochrome: false,
    monochromeKind: null,
    sourceType: 'raster',
    createdAt: '2026-10-01',
    thumb: `https://assets.ultraclipart.com/private-fixture/${id}.webp`,
    originalThumb: `https://assets.ultraclipart.com/private-fixture/${id}.thumbnail.webp`,
    ...extra,
  };
}
function topic(slug, ids, group = 'Fixture') {
  const summary = `Private ${slug} source fixture.`,
    paragraphs = [
      `Private ${slug} with {{artworkCount}}.`,
      `Separate source-specific ${slug} fixture.`,
    ];
  return {
    schema: 1,
    type: 'collection-topic-references',
    slug,
    path: `/clipart/${slug}/`,
    canonical: `https://ultraclipart.com/clipart/${slug}/`,
    title: slug + ' Clipart',
    keyword: slug + ' clipart',
    summary,
    metaDescription: summary,
    primaryCluster: group,
    sourceCluster: group,
    clusters: [{ name: group, path: `/collection/${m.views.slugify(group)}/` }],
    paragraphs,
    editorial: { intro: summary, paragraphs, status: 'PRIVATE_TEST_FIXTURE_NOT_APPROVAL' },
    artworkCount: ids.length,
    coverArtworkId: ids[0],
    related: [],
    membership: [],
    pageBlocks: [],
  };
}
async function context(bucket, indexes) {
  const rootSHA256 = await m.pages.projectionDigest(indexes);
  return {
    snapshot: { fixture: true, status: 'PRIVATE_UNPUBLISHABLE', revision: 'a'.repeat(40), indexes },
    rootSHA256,
    read: (f, d) => read(bucket, f, d),
    getFacet: (f) => read(bucket, f, indexes[f]),
  };
}
async function sourceTopic(ctx, slug) {
  const store = m.collections.facetStore({ get: (key) => ctx._bucket.get(key) });
  const c = await ctx.getFacet('collections'),
    d = await m.collections.lookupTopic(store, c.directory, 'collection', slug);
  return d ? store.read('collections', d) : null;
}
async function bindContext(bucket, indexes) {
  const c = await context(bucket, indexes);
  c._bucket = bucket;
  return c;
}
async function fixture() {
  const bucket = memory(),
    cs = m.collections.facetStore(bucket, { writable: true }),
    ss = m.search.makeStore(bucket, { writable: true }),
    rs = { get: (d) => read(bucket, 'recent', d), put: (v) => put(bucket, 'recent', v) },
    records = new Map(
      [
        artwork('a-one', 'subject-a'),
        artwork('a-two', 'subject-a', {
          monochrome: true,
          monochromeKind: 'outline',
          style: 'Outline',
        }),
        artwork('b-one', 'subject-b'),
        artwork('b-two', 'subject-b'),
      ].map((a) => [a.id, a]),
    );
  const empty = {
    collections: await cs.put('collections', {
      type: 'collection-directory',
      viewProtocol: 'collection-references-v2',
      topicCount: 0,
      artworkCount: 0,
      directory: await m.collections.emitDirectory(cs, [], 'collection'),
    }),
    counts: await cs.put('counts', {
      type: 'catalog-count-directory',
      topicCount: 0,
      artworkCount: 0,
      topics: await m.collections.emitDirectory(cs, [], 'count'),
      global: await cs.put('counts', {
        type: 'catalog-counts',
        totals: { artworks: 0, subjects: 0, collections: 0, printable: 0 },
        collections: {},
      }),
    }),
  };
  const changes = ['subject-a', 'subject-b'].map((slug) => {
    const ids = [...records.values()].filter((a) => a.topic === slug).map((a) => a.id);
    return { slug, expectedRecordSha256: null, record: topic(slug, ids), artworkIds: ids };
  });
  const cc = await m.writer.applyCollectionBatch(cs, empty, changes, {
    expectedCollectionsSha256: empty.collections.sha256,
    expectedCountsSha256: empty.counts.sha256,
    validateSourceTopic: async ({ change }) => ({
      oldRecordSha256: null,
      newRecordSha256: await m.pages.projectionDigest(change.record),
    }),
    resolveBeforeArtwork: async () => null,
    resolveAfterArtwork: async (id) => records.get(id),
  });
  const indexes = {
    ...cc,
    artworks: await cs.put('artworks', {
      type: 'private-source-artwork',
      records: Object.fromEntries(records),
    }),
    recent: await rs.put({
      type: 'recent-directory',
      ledger: await m.recent.bootstrapRecent(rs, [...records.values()]),
    }),
  };
  delete indexes.metrics;
  delete indexes.changed;
  delete indexes.publicationVerified;
  const rawTopics = changes.map(({ record: r }, i) => ({
      id: i ? null : 1,
      slug: r.slug,
      keyword: r.keyword,
      cluster: r.primaryCluster,
      sourceCluster: r.sourceCluster,
      clusterNames: r.clusters.map((c) => c.name),
    })),
    projection = await m.facts.bootstrapProjectionFacts(
      m.facts.collectionStore(cs),
      [...records.values()],
      rawTopics,
      {
        artworkRootSHA256: indexes.artworks.sha256,
        recentLedgerSHA256: (await rs.get(indexes.recent)).ledger.sha256,
      },
    ),
    facts = await m.facts.readFacts(m.facts.collectionStore(cs), projection),
    global = await cs.read('counts', (await cs.read('counts', indexes.counts)).global),
    fields = {
      topics: rawTopics.map(({ clusterNames, ...t }) => t),
      staticIds: ['a-one'],
      directoryIds: [],
      subjects: [],
      clusters: [],
      clustersData: [],
      clusterPicks: [],
      colors: [],
      styles: [],
      studioCompositionPreviews: [],
    },
    view = m.views.deriveViews(
      fields,
      new Map([...facts.topics].map(([k, v]) => [k, v.facts])),
      global,
    ),
    pages = {};
  for (const [name, rows] of Object.entries(view.fields))
    pages[name] = rows.length
      ? [
          {
            count: rows.length,
            ...(await cs.put('collections', {
              type: 'discovery-shell-rows',
              field: name,
              offset: 0,
              entries: rows,
            })),
          },
        ]
      : [];
  const preview = m.directory.buildHashedRecordDirectory(
    'collections',
    [...facts.topics].map(([name, v]) => ({ name, value: v.facts.catalogPreview })),
  );
  for (const [k, b] of preview.created) await m.stage.stageDirectoryBytes(bucket, k, b);
  indexes.collections = await cs.put('collections', {
    ...(await cs.read('collections', indexes.collections)),
    shells: await cs.put('collections', {
      type: 'discovery-shell-directory',
      sourceCatalogRevision: 'a'.repeat(40),
      fields: pages,
    }),
    discoveryProjection: projection,
    catalogPreviewDirectory: preview.root,
    studioFeatured: await cs.put('collections', {
      type: 'studio-featured',
      ids: view.ui.featuredIds,
    }),
  });
  const site = m.views.replaceSiteEntries(
      [
        { kind: 'page', id: 'page:home', title: 'Home' },
        { kind: 'topic', id: 'topic:subject-a' },
        { kind: 'collection', id: 'collection:fixture' },
        { kind: 'tool', id: 'tool:end' },
      ],
      view.topics.map((t) => ({ ...t, count: facts.topics.get(t.slug).facts.count })),
      view.fields.clusters,
    ),
    base = await ss.put({
      type: 'catalog-search-v1',
      status: 'PRIVATE_UNPUBLISHABLE',
      topics: [],
      total: 4,
    }),
    bound = await m.ui.attachUiMetadata(ss, base, { site, ...view.ui });
  indexes.search = bound.descriptor;
  return { bucket, cs, ss, rs, records, indexes, context: await bindContext(bucket, indexes) };
}
async function batch(f, artworkChanges, slugs, { groups = {}, rename = {} } = {}) {
  const records = new Map(f.records);
  for (const c of artworkChanges) c.record ? records.set(c.id, c.record) : records.delete(c.id);
  const cs = m.collections.facetStore(f.bucket, { writable: true }),
    topicChanges = [];
  for (const slug of slugs) {
    const before = await sourceTopic(f.context, slug),
      ids = [...records.values()].filter((a) => a.topic === slug).map((a) => a.id),
      r = ids.length ? topic(slug, ids, groups[slug] ?? before?.primaryCluster) : null;
    if (rename[slug] && r) {
      r.keyword = rename[slug];
      r.title = rename[slug];
    }
    const oldEntry = await m.collections.lookupTopic(
      cs,
      (await f.context.getFacet('collections')).directory,
      'collection',
      slug,
    );
    topicChanges.push({
      slug,
      record: r,
      artworkIds: ids,
      expectedRecordSha256: oldEntry?.sha256 ?? null,
    });
  }
  const cc = await m.writer.applyCollectionBatch(cs, f.indexes, topicChanges, {
      expectedCollectionsSha256: f.indexes.collections.sha256,
      expectedCountsSha256: f.indexes.counts.sha256,
      validateSourceTopic: async ({ change, oldRecord }) => ({
        oldRecordSha256: oldRecord ? await m.pages.projectionDigest(oldRecord) : null,
        newRecordSha256: change.record ? await m.pages.projectionDigest(change.record) : null,
      }),
      resolveBeforeArtwork: async (id) => f.records.get(id),
      resolveAfterArtwork: async (id) => records.get(id),
    }),
    indexes = {
      ...f.indexes,
      collections: cc.collections,
      counts: cc.counts,
      artworks: await cs.put('artworks', {
        type: 'private-source-artwork',
        records: Object.fromEntries(records),
      }),
    };
  const recent = await f.context.getFacet('recent');
  indexes.recent = await f.rs.put({
    ...recent,
    ledger: await m.recent.applyRecentBatch(
      f.rs,
      recent.ledger,
      await Promise.all(
        artworkChanges.map(async (c) => ({
          ...c,
          expectedSourceSHA256: f.records.has(c.id)
            ? await m.pages.projectionDigest(f.records.get(c.id))
            : null,
        })),
      ),
    ),
  });
  const after = await bindContext(f.bucket, indexes),
    beforeTopic = (slug) => sourceTopic(f.context, slug),
    afterTopic = (slug) => sourceTopic(after, slug),
    calls = [];
  const args = {
    bucket: f.bucket,
    parentContext: f.context,
    context: after,
    changes: artworkChanges.map((c) => ({ ...c, oldRecord: f.records.get(c.id) ?? null })),
    topicChanges,
    searchStore: f.ss,
    searchDataDescriptor: await f.ss.put({
      type: 'catalog-search-v1',
      status: 'PRIVATE_UNPUBLISHABLE',
      topics: [],
      total: records.size,
    }),
    beforeTopic,
    afterTopic,
    readArtwork: async (id) => {
      calls.push(id);
      return { rootSHA256: after.rootSHA256, artwork: records.get(id) };
    },
    sourceReceiptSHA256: 'b'.repeat(64),
  };
  return { args, records, indexes, after, calls };
}
async function inspect(f, result, indexes) {
  const c = await bindContext(f.bucket, {
      ...indexes,
      collections: result.collections,
      search: result.search,
    }),
    root = await c.getFacet('collections'),
    shell = await c.read('collections', root.shells),
    fields = {};
  for (const name of Object.keys(shell.fields))
    fields[name] = await m.shell.readShellField(c, shell, name);
  const manifest = await f.ss.get(result.search),
    ui = await m.ui.readUi({}, { manifest, store: f.ss });
  return {
    context: c,
    root,
    fields,
    ui,
    site: await m.ui.readUiEntries(f.ss, ui, 'site', 'public-site-search-entries'),
    categories: await m.ui.readUiEntries(f.ss, ui, 'categories', 'studio-category-entries'),
    mono: await m.ui.readUiEntries(f.ss, ui, 'mono', 'monochrome-topic-entries'),
  };
}

export {
  m,
  same,
  memory,
  read,
  put,
  artwork,
  topic,
  context,
  sourceTopic,
  bindContext,
  fixture,
  batch,
  inspect,
};
