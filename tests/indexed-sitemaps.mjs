import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readIndexedSitemaps } from '../scripts/seo/indexed-sitemaps.mjs';
import { auditImageSeo } from '../scripts/seo/audit-image-seo.mjs';
import { imageObject } from '../src/lib/image-schema.ts';

const site = 'https://ultraclipart.com/';
function fixture(names, indexNames = names) {
  const dir = mkdtempSync(join(tmpdir(), 'uc-sitemaps-'));
  writeFileSync(
    join(dir, 'sitemap.xml'),
    `<sitemapindex>${indexNames.map((name) => `<sitemap><loc>${name.startsWith('http') ? name : site + name}</loc></sitemap>`).join('')}</sitemapindex>`,
  );
  for (const name of names) writeFileSync(join(dir, name), `<urlset>${name}</urlset>`);
  return dir;
}
test('reads every advertised page and image partition, including double-digit parts', () => {
  const names = [
    'sitemap-pages.xml',
    'sitemap-pages-2.xml',
    'sitemap-images.xml',
    'sitemap-images-10.xml',
  ];
  const dir = fixture(names);
  try {
    const result = readIndexedSitemaps(dir, site);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(
      result.pages.map((x) => x.path),
      ['/sitemap-pages.xml', '/sitemap-pages-2.xml'],
    );
    assert.deepEqual(
      result.images.map((x) => x.path),
      ['/sitemap-images.xml', '/sitemap-images-10.xml'],
    );
    assert.match(result.images[1].xml, /sitemap-images-10/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('reports missing, duplicated and foreign parts without reading outside the build', () => {
  const dir = fixture(
    ['sitemap-pages.xml'],
    [
      'sitemap-pages.xml',
      'sitemap-pages.xml',
      'sitemap-images-2.xml',
      'https://elsewhere.example/sitemap-images.xml',
    ],
  );
  try {
    const result = readIndexedSitemaps(dir, site);
    assert.equal(result.pages.length, 1);
    assert.equal(result.images.length, 0);
    assert.equal(result.errors.length, 3);
    assert.ok(result.errors.some((x) => x.startsWith('Duplicate')));
    assert.ok(result.errors.some((x) => x.startsWith('Missing')));
    assert.ok(result.errors.some((x) => x.startsWith('Unexpected')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('requires the index and at least one page sitemap', () => {
  const dir = fixture(['sitemap-images.xml']);
  try {
    assert.ok(readIndexedSitemaps(dir, site).errors.includes('No indexed page sitemap'));
    rmSync(join(dir, 'sitemap.xml'));
    assert.deepEqual(readIndexedSitemaps(dir, site).errors, ['Missing sitemap index']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('image SEO audit covers all parts and rejects a duplicate in a later part', () => {
  const root = mkdtempSync(join(tmpdir(), 'uc-sitemap-audit-'));
  const directory = join(root, 'dist');
  mkdirSync(directory);
  mkdirSync(join(root, '.astro'));
  writeFileSync(join(root, '.astro/preview-assets.json'), '{}');
  const catalog = ['one', 'two'].map((id) => ({
    id,
    title: `Title ${id}`,
    alt: `Picture ${id}`,
    description: `Description ${id}`,
    webp: `/images/${id}.webp`,
    thumb: `/images/${id}-thumb.webp`,
    width: 20,
    height: 30,
    published: true,
    indexable: true,
    files: { webp: { sha256: 'a'.repeat(64) }, thumb: { sha256: 'b'.repeat(64) } },
  }));
  const publishedAssets = Object.fromEntries(
    catalog.map((a) => [
      a.id,
      {
        webp: `https://assets.ultraclipart.com/${a.id}.webp`,
        thumb: `https://assets.ultraclipart.com/${a.id}-thumb.webp`,
      },
    ]),
  );
  const parts = [
    'sitemap-pages.xml',
    'sitemap-pages-2.xml',
    'sitemap-images.xml',
    'sitemap-images-2.xml',
  ];
  writeFileSync(
    join(directory, 'sitemap.xml'),
    `<sitemapindex>${parts.map((part) => `<sitemap><loc>${site}${part}</loc></sitemap>`).join('')}</sitemapindex>`,
  );
  for (let i = 0; i < catalog.length; i++) {
    const a = catalog[i];
    const url = `${site}art/${a.id}/`;
    const original = publishedAssets[a.id].webp;
    const folder = join(directory, 'art', a.id);
    mkdirSync(folder, { recursive: true });
    const image = { ...a, ...publishedAssets[a.id] };
    writeFileSync(
      join(folder, 'index.html'),
      `<link rel="canonical" href="${url}"><meta name="robots" content="index,max-image-preview:large"><img src="${original}" alt="${a.alt}" title="${a.title}" width="20" height="30"><script type="application/ld+json">${JSON.stringify(imageObject(image))}</script>`,
    );
    const suffix = i ? '-2' : '';
    writeFileSync(
      join(directory, `sitemap-pages${suffix}.xml`),
      `<urlset><url><loc>${url}</loc></url></urlset>`,
    );
    writeFileSync(
      join(directory, `sitemap-images${suffix}.xml`),
      `<urlset><url><loc>${url}</loc><image:image><image:loc>${original}</image:loc></image:image></url></urlset>`,
    );
  }
  try {
    const report = auditImageSeo({ root, directory, catalog, publishedAssets });
    assert.equal(report.imageSitemapOriginals, 2);
    assert.equal(report.pageSitemapEntries, 2);
    assert.deepEqual(report.errors, []);
    writeFileSync(
      join(directory, 'sitemap-images-2.xml'),
      `<urlset><image:loc>${publishedAssets.one.webp}</image:loc></urlset>`,
    );
    assert.throws(
      () => auditImageSeo({ root, directory, catalog, publishedAssets }),
      /Image SEO audit failed/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
