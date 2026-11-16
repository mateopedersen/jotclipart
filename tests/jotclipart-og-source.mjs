import test from 'node:test';
import assert from 'node:assert/strict';
import {
  originalOgThumbnail,
  catalogOgSource,
  catalogOgRoute,
  resolveOgCollectionCluster,
  applyCatalogOgMetadata,
} from '../server/jotclipart/og-catalog-source.mjs';
import { prepareOgDescriptor } from '../server/jotclipart/og-image.mjs';
import { inspectDocument } from '../scripts/jotclipart/audit-http.mjs';

// Private protocol fixtures, not editorial approvals or production records.
const root = 'a'.repeat(64),
  sha = 'b'.repeat(64);
const identity = { rendererSHA256: sha, logoSHA256: root, fontSHA256: [root, sha] };
const item = {
  id: 'fixture-art',
  topic: 'fixture-topic',
  published: true,
  indexable: true,
  title: 'Private Fixture Art',
  thumb: 'https://assets.ultraclipart.com/fixture/full.webp',
  originalThumb: 'https://assets.ultraclipart.com/fixture/small.webp',
  files: {
    webp: { bytes: 2000000, sha256: root },
    thumb: { bytes: 20000, sha256: sha },
  },
};
function clusterFixture(names = ['Fixture Cluster']) {
  const shell = { key: 'catalog/objects/collections/fixture-shell.json' };
  const page = {
    key: 'catalog/objects/collections/fixture-clusters.json',
    count: names.length,
    offset: 0,
  };
  const directory = { schema: 1, type: 'discovery-shell-directory', fields: { clusters: [page] } };
  const rows = {
    schema: 1,
    type: 'discovery-shell-rows',
    field: 'clusters',
    offset: 0,
    entries: names,
  };
  const calls = [];
  const context = {
    async read(facet, descriptor, budget) {
      calls.push([facet, descriptor.key]);
      assert.equal(facet, 'collections');
      assert.equal(budget.maxBytes, 65536);
      if (descriptor === shell) return directory;
      assert.equal(descriptor, page);
      return rows;
    },
  };
  const collectionContext = {
    collections: { shells: shell },
    global: { collections: { 'fixture-cluster': { artworks: 2, subjects: 1 } } },
  };
  return { context, collectionContext, calls, directory };
}
test('OG source selects originalThumb URL with files.thumb identity, never the full thumb alias', () => {
  assert.deepEqual(originalOgThumbnail(item), {
    objectKey: 'fixture/small.webp',
    mime: 'image/webp',
    bytes: 20000,
    sha256: sha,
  });
  assert.throws(
    () => originalOgThumbnail({ ...item, files: { webp: item.files.webp } }),
    /Source-bound/,
  );
  assert.throws(
    () => originalOgThumbnail({ ...item, originalThumb: 'https://foreign.invalid/fixture.webp' }),
    /Source-bound/,
  );
  assert.throws(() => originalOgThumbnail({ ...item, indexable: false }), /not public/);
});
test('curated collection lookup preserves slug rather than passing its display title to shell selection', async () => {
  const { context, collectionContext, calls } = clusterFixture();
  assert.equal(
    await resolveOgCollectionCluster(context, collectionContext, 'spiders-scorpions'),
    'spiders-scorpions',
  );
  assert.deepEqual(calls, []);
});
test('primary collection names come from signed shell rows when global counts contain no name', async () => {
  const { context, collectionContext, calls } = clusterFixture();
  assert.equal(collectionContext.global.collections['fixture-cluster'].name, undefined);
  assert.equal(
    await resolveOgCollectionCluster(context, collectionContext, 'fixture-cluster'),
    'Fixture Cluster',
  );
  assert.equal(calls.length, 2);
});
test('unknown, ambiguous and invalid signed collection paths do not guess a title or cover', async () => {
  const a = clusterFixture();
  assert.equal(
    await resolveOgCollectionCluster(a.context, a.collectionContext, 'unknown-fixture'),
    undefined,
  );
  assert.equal(a.calls.length, 0);
  const b = clusterFixture(['Fixture Cluster', 'Fixture-Cluster']);
  await assert.rejects(
    resolveOgCollectionCluster(b.context, b.collectionContext, 'fixture-cluster'),
    /Ambiguous/,
  );
  const c = clusterFixture();
  c.directory.type = 'wrong-protocol';
  await assert.rejects(
    resolveOgCollectionCluster(c.context, c.collectionContext, 'fixture-cluster'),
    /protocol/,
  );
});
test('derived publicSlug decoration does not change art/editor source identity and canonical resolution', async () => {
  const context = { rootSHA256: root },
    state = { item: { ...item, publicSlug: 'accepted-readable-path' } };
  for (const kind of ['art', 'editor']) {
    const html = await catalogOgSource({ kind, id: item.id, state, context });
    const endpoint = await catalogOgSource({
      kind,
      id: item.id,
      state: structuredClone(state),
      context,
    });
    assert.deepEqual(
      await prepareOgDescriptor(html, identity),
      await prepareOgDescriptor(endpoint, identity),
    );
    assert.equal(html.images[0].bytes, item.files.thumb.bytes);
    assert.equal(
      html.canonicalPath,
      kind === 'art' ? '/art/accepted-readable-path/' : '/edit/fixture-art/',
    );
  }
});
const html = `<!doctype html><html><head>
<meta property="og:image" content="https://assets.ultraclipart.com/old.webp">
<meta content='https://assets.ultraclipart.com/old.webp' property='og:image:secure_url'>
<meta property="og:image:type" content="image/webp"><meta property="og:image:width" content="500"><meta property="og:image:height" content="500">
<meta property="og:image:alt" content="Old source alt"><meta name="twitter:image" content="https://assets.ultraclipart.com/old.webp"><meta name="twitter:image:alt" content="Old source alt">
</head><body><h1>Keep this heading</h1><img src="https://assets.ultraclipart.com/original.webp" alt="Keep original alt"></body></html>`;
const descriptor = {
  url: 'https://jotclipart.com/og/catalog/art/fixture-art/' + sha + '.png',
  type: 'image/png',
  width: 1200,
  height: 630,
  title: 'Free Fixture & Source',
};
test('all OG and Twitter image metadata point to one new PNG, including secure_url, with no stale value', () => {
  const patched = applyCatalogOgMetadata(html, descriptor),
    doc = inspectDocument(patched);
  const expected = {
    'og:image': descriptor.url,
    'og:image:secure_url': descriptor.url,
    'og:image:type': 'image/png',
    'og:image:width': '1200',
    'og:image:height': '630',
    'og:image:alt': descriptor.title + ' — JotClipart',
    'twitter:image': descriptor.url,
    'twitter:image:alt': descriptor.title + ' — JotClipart',
  };
  for (const [key, value] of Object.entries(expected)) {
    const tags = doc.meta.filter((m) => (m.property ?? m.name) === key);
    assert.equal(tags.length, 1, key + ' duplicated or missing');
    assert.equal(tags[0].content, value, key);
  }
  assert(
    !doc.meta
      .filter((m) => /^(?:og|twitter):image/.test(m.property ?? m.name ?? ''))
      .some((m) => /ultraclipart|old\.webp|Old source alt|image\/webp/.test(m.content)),
  );
  assert(patched.includes('<h1>Keep this heading</h1>'));
  assert(patched.includes('alt="Keep original alt"'));
  assert(patched.includes('src="https://assets.ultraclipart.com/original.webp"'));
});
test('missing optional image metadata is inserted once, while duplicate image metadata fails closed', () => {
  const minimal =
    '<head><meta property="og:image" content="old"><meta name="twitter:image" content="old"></head>';
  const first = applyCatalogOgMetadata(minimal, descriptor);
  assert.equal(applyCatalogOgMetadata(first, descriptor), first);
  for (const key of [
    'og:image',
    'og:image:secure_url',
    'og:image:type',
    'og:image:alt',
    'twitter:image',
    'twitter:image:alt',
  ]) {
    const attribute = key.startsWith('twitter:') ? 'name' : 'property';
    assert.throws(
      () =>
        applyCatalogOgMetadata(
          html.replace('</head>', `<meta ${attribute}="${key}" content="duplicate"></head>`),
          descriptor,
        ),
      /Ambiguous/,
    );
  }
});
test('OG route parser accepts stable catalog identity and rejects foreign/private route families', () => {
  assert.deepEqual(catalogOgRoute('/og/catalog/art/fixture-art/' + sha + '.png'), {
    kind: 'art',
    id: 'fixture-art',
    digest: sha,
  });
  assert.equal(catalogOgRoute('/og/catalog/share/private-user/' + sha + '.png'), undefined);
  assert.equal(catalogOgRoute('/og/catalog/art/../' + sha + '.png'), undefined);
});
