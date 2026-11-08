import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  bootstrapSitemaps,
  applySitemapBatch,
  sitemapEnvelope,
} from '../../server/catalog-snapshot/sitemap-ledger.mjs';
import { readSitemap } from '../../server/catalog-snapshot/sitemap-reader.mjs';
import { canonical, digest } from '../../server/catalog-search/store.mjs';
function memory() {
  const objects = new Map();
  let puts = 0;
  return {
    objects,
    puts: () => puts,
    get: async (d) => {
      const bytes = objects.get(d.key);
      assert(bytes);
      assert.equal(
        d.key,
        `catalog/objects/sitemaps/${createHash('sha256').update(bytes).digest('hex')}.json`,
      );
      assert.equal(bytes.length, d.bytes);
      return JSON.parse(bytes);
    },
    put: async (value) => {
      const bytes = Buffer.from(JSON.stringify(canonical({ schema: 1, ...value }))),
        sha256 = createHash('sha256').update(bytes).digest('hex'),
        d = { key: `catalog/objects/sitemaps/${sha256}.json`, sha256, bytes: bytes.length };
      if (!objects.has(d.key)) puts++;
      objects.set(d.key, bytes);
      return d;
    },
  };
}
const entry = (id, image = '') =>
    `<url><loc>https://ultraclipart.com/art/${id}/</loc>${image ? `<image:image><image:loc>https://assets.ultraclipart.com/${image}.webp</image:loc></image:image>` : ''}</url>`,
  xml = (kind, entries) => sitemapEnvelope(kind) + entries.join('') + '</urlset>',
  context = (store, root) => ({
    getFacet: async (f) => {
      assert.equal(f, 'sitemaps');
      return store.get(root);
    },
    read: async (f, d) => {
      assert.equal(f, 'sitemaps');
      return store.get(d);
    },
  });
test('changed-part sitemaps preserve canonical XML through updates, withdrawal and restore', async () => {
  const store = memory(),
    pages = Array.from({ length: 1200 }, (_, i) => entry(`item-${i}`)),
    images = Array.from({ length: 1200 }, (_, i) => entry(`item-${i}`, `source-${i}`)),
    root = await bootstrapSitemaps(store, [
      { kind: 'pages', xml: xml('pages', pages) },
      { kind: 'images', xml: xml('images', images) },
    ]);
  assert.equal(await readSitemap(context(store, root), '/sitemap-pages.xml'), xml('pages', pages));
  assert.equal(
    await readSitemap(context(store, root), '/sitemap-images.xml'),
    xml('images', images),
  );
  const next = await applySitemapBatch(store, root, [
    {
      kind: 'images',
      loc: 'https://ultraclipart.com/art/item-0/',
      expectedEntrySHA256: await digest(images[0]),
      entry: entry('item-0', 'replacement'),
    },
    {
      kind: 'pages',
      loc: 'https://ultraclipart.com/art/item-1/',
      expectedEntrySHA256: await digest(pages[1]),
      entry: null,
    },
    {
      kind: 'pages',
      loc: 'https://ultraclipart.com/art/new-item/',
      expectedEntrySHA256: null,
      entry: entry('new-item'),
    },
  ]);
  assert.equal(
    await readSitemap(context(store, next), '/sitemap-images.xml'),
    xml('images', [entry('item-0', 'replacement'), ...images.slice(1)]),
  );
  assert.equal(
    await readSitemap(context(store, next), '/sitemap-pages.xml'),
    xml('pages', [...pages.filter((_, i) => i !== 1), entry('new-item')]),
  );
  assert.equal(await readSitemap(context(store, root), '/sitemap-pages.xml'), xml('pages', pages));
  const restored = await applySitemapBatch(store, next, [
    {
      kind: 'pages',
      loc: 'https://ultraclipart.com/art/item-1/',
      expectedEntrySHA256: null,
      entry: pages[1],
    },
  ]);
  assert.equal(
    await readSitemap(context(store, restored), '/sitemap-pages.xml'),
    xml('pages', [...pages, entry('new-item')]),
  );
  const before = store.puts();
  await assert.rejects(
    applySitemapBatch(store, restored, [
      {
        kind: 'pages',
        loc: 'https://ultraclipart.com/art/item-1/',
        expectedEntrySHA256: '0'.repeat(64),
        entry: null,
      },
    ]),
  );
  assert.equal(store.puts(), before);
});
test('a fully withdrawn document disappears and returns to the index on restore', async () => {
  const store = memory(),
    a = entry('single'),
    root = await bootstrapSitemaps(store, [{ kind: 'pages', xml: xml('pages', [a]) }]),
    gone = await applySitemapBatch(store, root, [
      {
        kind: 'pages',
        loc: 'https://ultraclipart.com/art/single/',
        entry: null,
        expectedEntrySHA256: await digest(a),
      },
    ]);
  assert.equal(await readSitemap(context(store, gone), '/sitemap-pages.xml'), undefined);
  assert(!(await readSitemap(context(store, gone), '/sitemap.xml')).includes('sitemap-pages.xml'));
  const restored = await applySitemapBatch(store, gone, [
    {
      kind: 'pages',
      loc: 'https://ultraclipart.com/art/single/',
      entry: a,
      expectedEntrySHA256: null,
    },
  ]);
  assert(
    (await readSitemap(context(store, restored), '/sitemap.xml')).includes('sitemap-pages.xml'),
  );
  assert.equal(
    await readSitemap(context(store, restored), '/sitemap-pages.xml'),
    xml('pages', [a]),
  );
});

test('separated sitemap ledger appends part two at 10,000 and keeps families disjoint', async () => {
  const store = memory(),
    entries = Array.from({ length: 10000 }, (_, i) => entry(`bounded-${i}`));
  const root = await bootstrapSitemaps(store, [
    { kind: 'pages', xml: xml('pages', ['<url><loc>https://ultraclipart.com/</loc></url>']) },
    { kind: 'art-1', xml: xml('art-1', entries) },
    { kind: 'images-1', xml: xml('images-1', [entry('bounded-0', 'original')]) },
  ]);
  assert.equal((await store.get(root)).protocol, 'ledger-separated-v3');
  const next = await applySitemapBatch(store, root, [
    {
      kind: 'pages',
      loc: 'https://ultraclipart.com/art/new/',
      expectedEntrySHA256: null,
      entry: entry('new'),
    },
  ]);
  const index = await readSitemap(context(store, next), '/sitemap.xml');
  assert(index.includes('sitemap-art-2.xml'));
  assert.equal(
    await readSitemap(context(store, next), '/sitemap-art-2.xml'),
    xml('art-2', [entry('new')]),
  );
  assert.equal(
    (await readSitemap(context(store, next), '/sitemap-art-1.xml')).match(/<url>/g).length,
    10000,
  );
  assert(!(await readSitemap(context(store, next), '/sitemap-pages.xml')).includes('/art/'));
});
