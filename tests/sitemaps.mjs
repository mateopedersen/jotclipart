import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approvedArt,
  imageSitemap,
  pageSitemap,
  sitemapIndex,
  xmlEscape,
  indexableTopics,
  directoryArtwork,
  sitemapDocuments,
  partitionSitemapEntries,
  SITEMAP_MAX_BYTES,
} from '../src/lib/sitemaps.ts';

const example = {
  id: 'pumpkin-01',
  topic: 'pumpkin',
  webp: 'https://assets.ultraclipart.com/test/pumpkin.webp',
  published: true,
  indexable: true,
};

test('a first approved work makes its subject discoverable without a fifty-item gate', () => {
  const complete = Array.from({ length: 50 }, (_, i) => ({ ...example, id: `full-${i}` }));
  const growing = { ...example, id: 'first-new-work', topic: 'new-subject' };
  const draft = { ...growing, id: 'draft', published: false };
  const noindex = { ...growing, id: 'private', indexable: false };
  const topics = [{ slug: 'pumpkin' }, { slug: 'new-subject' }];
  assert.deepEqual(directoryArtwork([...complete, growing, draft, noindex], topics), []);
  assert.deepEqual(indexableTopics([growing, draft, noindex], topics), [topics[1]]);
  assert.ok(pageSitemap([growing, draft, noindex], topics).includes('/clipart/new-subject/'));
  assert.deepEqual(directoryArtwork([growing, draft, noindex], [topics[0]]), [growing]);
  const completed = Array.from({ length: 50 }, (_, i) => ({ ...growing, id: `new-${i}` }));
  assert.deepEqual(directoryArtwork([...complete, ...completed], topics), []);
});

test('growing catalogs split automatically while retaining the first sitemap URLs', () => {
  const art = Array.from({ length: 50001 }, (_, index) => ({ ...example, id: `growing-${index}` }));
  const documents = sitemapDocuments(art, []);
  assert.deepEqual(
    documents.map((document) => document.kind),
    ['pages', 'pages-2', 'images', 'images-2'],
  );
  const pages = documents.filter((document) => document.kind.startsWith('pages'));
  const images = documents.filter((document) => document.kind.startsWith('images'));
  for (const document of documents) {
    assert.ok([...document.xml.matchAll(/<url>/g)].length <= 50000);
    assert.ok(Buffer.byteLength(document.xml) <= 50 * 1024 ** 2);
  }
  assert.equal(
    images.reduce(
      (count, document) => count + [...document.xml.matchAll(/<image:image>/g)].length,
      0,
    ),
    art.length,
  );
  assert.equal(
    [
      ...pages
        .map((document) => document.xml)
        .join('')
        .matchAll(/\/art\/growing-\d+\//g),
    ].length,
    art.length,
  );
  assert.ok(sitemapIndex(art).includes('/sitemap-images-2.xml'));
});
test('100,001 approved artworks produce complete bounded image sitemap partitions', () => {
  const art = Array.from({ length: 100001 }, (_, index) => ({
    ...example,
    id: `large-${index}`,
    webp: `https://assets.ultraclipart.com/large/${index}.webp`,
  }));
  const documents = sitemapDocuments(art, []);
  const images = documents.filter((document) => document.kind.startsWith('images'));
  assert.deepEqual(
    images.map((document) => document.kind),
    ['images', 'images-2', 'images-3'],
  );
  const urls = images.flatMap((document) => {
    assert.ok(Buffer.byteLength(document.xml) <= SITEMAP_MAX_BYTES);
    return [...document.xml.matchAll(/<image:loc>([^<]+)<\/image:loc>/g)].map((match) => match[1]);
  });
  assert.equal(urls.length, 100001);
  assert.equal(new Set(urls).size, 100001);
  assert.ok(urls.includes('https://assets.ultraclipart.com/large/100000.webp'));
});
test('sitemap splitting respects UTF-8 bytes as well as URL counts', () => {
  const entry = '<url><loc>https://ultraclipart.com/žiedas/</loc></url>';
  const overhead =
    Buffer.byteLength(partitionSitemapEntries([entry])[0]) - Buffer.byteLength(entry);
  const parts = partitionSitemapEntries(
    [entry, entry, entry],
    false,
    50000,
    overhead + Buffer.byteLength(entry) * 2,
  );
  assert.equal(parts.length, 2);
  assert.throws(() =>
    partitionSitemapEntries([entry], false, 50000, overhead + Buffer.byteLength(entry) - 1),
  );
});

test('default sitemap partitions fit the hosting per-file budget', () => {
  const entry = `<url><loc>https://ultraclipart.com/${'a'.repeat(13 * 1024 ** 2)}</loc></url>`;
  const parts = partitionSitemapEntries([entry, entry]);
  assert.equal(parts.length, 2);
  assert.ok(parts.every((part) => Buffer.byteLength(part) <= SITEMAP_MAX_BYTES));
  assert.ok(SITEMAP_MAX_BYTES < 25 * 1024 ** 2);
});

test('unapproved and noindex assets never enter the image or page sitemap', () => {
  const draft = { ...example, id: 'draft', published: false };
  const noindex = { ...example, id: 'noindex', indexable: false };
  assert.deepEqual(approvedArt([draft, noindex, example]), [example]);
  for (const xml of [
    pageSitemap([draft, noindex, example], []),
    imageSitemap([draft, noindex, example]),
  ]) {
    assert.ok(xml.includes('/art/pumpkin-01/'));
    assert.ok(!xml.includes('/art/draft/'));
    assert.ok(!xml.includes('/art/noindex/'));
  }
});

test('new approved subjects enter HTML/XML discovery and drafts do not hide an existing subject', () => {
  const topic = { slug: 'new-subject', keyword: 'New subject clipart' };
  const items = Array.from({ length: 50 }, (_, i) => ({
    ...example,
    id: `new-${i}`,
    topic: topic.slug,
  }));
  const draft = { ...items[0], id: 'future-draft', published: false };
  assert.deepEqual(indexableTopics([...items, draft], [topic]), [topic]);
  assert.ok(pageSitemap([...items, draft], [topic]).includes('/clipart/new-subject/'));
  assert.deepEqual(indexableTopics(items.slice(0, 1), [topic]), [topic]);
  assert.ok(pageSitemap(items.slice(0, 1), [topic]).includes('/clipart/new-subject/'));
  assert.deepEqual(indexableTopics([], [topic]), []);
  assert.deepEqual(
    indexableTopics(
      items.map((item) => ({ ...item, indexable: false })),
      [topic],
    ),
    [],
  );
});

test('the pilot index excludes an empty image sitemap; approval adds a real child', () => {
  assert.ok(sitemapIndex([]).includes('/sitemap-pages.xml'));
  assert.ok(!sitemapIndex([]).includes('/sitemap-images.xml'));
  assert.throws(() => imageSitemap([]), /empty image sitemap/);
  assert.ok(sitemapIndex([example]).includes('/sitemap-images.xml'));
  assert.ok(imageSitemap([example]).includes(`<image:loc>${example.webp}</image:loc>`));
});

test('only approved nonempty topics enter the sitemap, regardless of collection size', () => {
  const collection = Array.from({ length: 50 }, (_, index) => ({
    ...example,
    id: `pumpkin-${index + 1}`,
  }));
  const topics = [{ slug: 'pumpkin' }];
  assert.ok(pageSitemap(collection, topics).includes('/clipart/pumpkin/'));
  assert.ok(
    pageSitemap([...collection, { ...example, id: 'pumpkin-extra' }], topics).includes(
      '/clipart/pumpkin/',
    ),
  );
  assert.ok(pageSitemap(collection.slice(0, 1), topics).includes('/clipart/pumpkin/'));
  assert.ok(
    !pageSitemap([{ ...collection[0], indexable: false }], topics).includes('/clipart/pumpkin/'),
  );
});

test('public catalog entry pages and nonempty primary collections share sitemap eligibility', () => {
  const topics = [
    { slug: 'fresh-subject', cluster: 'A New Collection' },
    { slug: 'empty-subject', cluster: 'Empty Collection' },
    { slug: 'draft-subject', cluster: 'Draft Collection' },
  ];
  const approved = { ...example, topic: 'fresh-subject', monochrome: true };
  const xml = pageSitemap(
    [approved, { ...approved, id: 'draft', topic: 'draft-subject', published: false }],
    topics,
  );
  for (const route of [
    '/new/',
    '/black-and-white/',
    '/collection/a-new-collection/',
    '/clipart/fresh-subject/',
  ])
    assert.ok(xml.includes(`https://ultraclipart.com${route}`), route);
  for (const route of [
    '/collection/empty-collection/',
    '/collection/draft-collection/',
    '/favorites/',
    '/search/',
  ])
    assert.ok(!xml.includes(`https://ultraclipart.com${route}`), route);
  assert.ok(!pageSitemap([], topics).includes('/new/'));
  assert.ok(!pageSitemap([example], topics).includes('/black-and-white/'));
});

test('XML output escapes all reserved characters and real image URL queries', () => {
  assert.equal(xmlEscape(`<&>"'`), '&lt;&amp;&gt;&quot;&apos;');
  const xml = imageSitemap([
    { ...example, webp: 'https://assets.ultraclipart.com/art.webp?a=1&b=2' },
  ]);
  assert.ok(xml.includes('art.webp?a=1&amp;b=2'));
  assert.ok(!xml.includes('art.webp?a=1&b=2'));
  assert.match(xml, /xmlns:image="http:\/\/www.google.com\/schemas\/sitemap-image\/1.1"/);
  assert.ok(!xml.includes('<lastmod>'), 'Do not fabricate modification dates');
});
