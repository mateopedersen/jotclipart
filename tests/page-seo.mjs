import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pageGraph, ORGANIZATION_ID, WEBSITE_ID } from '../src/lib/page-seo.ts';
import { buildSiteIcons, siteIconSource } from '../scripts/build-site-icons.mjs';
import { createHash } from 'node:crypto';

test('website, publisher and page use one stable organization identity', () => {
  const data = pageGraph({
    canonical: 'https://jotclipart.com/clipart/baby/',
    title: 'Baby Clipart',
    description: 'Baby artwork.',
    primaryImage: '/catalog/baby.webp',
  });
  assert.deepEqual(
    data['@graph'].map((node) => node['@type']),
    ['Organization', 'WebSite', 'WebPage'],
  );
  assert.equal(data['@graph'][0]['@id'], ORGANIZATION_ID);
  assert.equal(data['@graph'][1]['@id'], WEBSITE_ID);
  assert.equal(data['@graph'][2].publisher['@id'], ORGANIZATION_ID);
  assert.equal(data['@graph'][2].primaryImageOfPage, 'https://jotclipart.com/catalog/baby.webp');
  assert.equal(data['@graph'][0].name, 'JotClipart');
  assert.ok(!JSON.stringify(data).includes('Person'));
});
test('private pages do not claim a public WebPage or expose a project', () => {
  const data = pageGraph({
    canonical: 'https://jotclipart.com/favorites/',
    title: 'Favorites',
    description: 'Saved artwork.',
    noindex: true,
  });
  assert.deepEqual(
    data['@graph'].map((node) => node['@type']),
    ['Organization', 'WebSite'],
  );
  for (const canonical of [
    'https://other.test/',
    'https://ultraclipart.com/',
    'http://jotclipart.com/',
    'https://jotclipart.com/?q=private',
    'https://jotclipart.com/#project',
  ])
    assert.throws(() => pageGraph({ canonical, title: 'Example', description: 'Example' }));
});
test('square favicon files decode correctly, preserve the source and rebuild identically', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jotclipart-icons-'));
  try {
    mkdirSync(join(root, 'public/brand'), { recursive: true });
    const logo = readFileSync(new URL('../' + siteIconSource, import.meta.url));
    const legacy = 'Legacy flat SVG is deliberately not an icon input.';
    writeFileSync(join(root, siteIconSource), logo);
    writeFileSync(join(root, 'public/logo.svg'), legacy);
    const first = await buildSiteIcons(root),
      second = await buildSiteIcons(root);
    assert.deepEqual(first, second);
    assert.equal(first.source, siteIconSource);
    assert.equal(first.sourceSha256, createHash('sha256').update(logo).digest('hex'));
    assert.deepEqual(readFileSync(join(root, siteIconSource)), logo);
    assert.equal(readFileSync(join(root, 'public/logo.svg'), 'utf8'), legacy);
    const svg = readFileSync(join(root, 'public/favicon.svg'), 'utf8');
    assert.match(svg, /<title>JotClipart<\/title>/);
    assert.doesNotMatch(
      svg,
      /<(?:script|foreignObject)\b|href=["'](?:https?:|\/\/)|xlink:|\bon\w+=/i,
    );
    const embedded = svg.match(/href="data:image\/png;base64,([A-Za-z0-9+/=]+)"/);
    assert.ok(embedded, 'SVG contains only a self-contained raster image');
    assert.equal((svg.match(/\bhref=/g) ?? []).length, 1);
    const embeddedInfo = await sharp(Buffer.from(embedded[1], 'base64')).metadata();
    assert.equal(embeddedInfo.width, 512);
    assert.equal(embeddedInfo.height, 512);
    assert.equal(embeddedInfo.hasAlpha, true);
    for (const [file, size] of [
      ['favicon-96.png', 96],
      ['favicon-192.png', 192],
      ['apple-touch-icon.png', 180],
    ]) {
      const info = await sharp(join(root, 'public', file)).metadata();
      assert.equal(info.format, 'png');
      assert.equal(info.width, size);
      assert.equal(info.height, size);
      assert.equal(info.hasAlpha, true);
      const alpha = (await sharp(join(root, 'public', file)).stats()).channels[3];
      assert.equal(alpha.min, 0);
      assert.ok(alpha.max > 0);
    }
    const ico = readFileSync(join(root, 'public/favicon.ico'));
    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), 3);
    for (let index = 0; index < 3; index++) {
      const entry = 6 + index * 16,
        length = ico.readUInt32LE(entry + 8),
        offset = ico.readUInt32LE(entry + 12);
      const info = await sharp(ico.subarray(offset, offset + length)).metadata();
      assert.equal(info.width, [16, 32, 48][index]);
      assert.equal(info.height, info.width);
      assert.equal(info.hasAlpha, true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('icon source validation rejects opaque, empty, undersized and non-PNG replacements', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jotclipart-icon-invalid-'));
  try {
    mkdirSync(join(root, 'public/brand'), { recursive: true });
    const fixtures = [
      await sharp({ create: { width: 256, height: 256, channels: 3, background: '#52B788' } })
        .png()
        .toBuffer(),
      await sharp({ create: { width: 256, height: 256, channels: 4, background: '#00000000' } })
        .png()
        .toBuffer(),
      await sharp({ create: { width: 32, height: 32, channels: 4, background: '#52B78888' } })
        .png()
        .toBuffer(),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>bad()</script></svg>'),
    ];
    for (const fixture of fixtures) {
      writeFileSync(join(root, siteIconSource), fixture);
      await assert.rejects(buildSiteIcons(root), /(?:PNG|raster mark|visible artwork)/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
