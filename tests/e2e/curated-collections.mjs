import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { curatedRegistry } from '../../src/lib/curated-collection-policy.mjs';
import { readReviewedImportCatalog } from '../../scripts/reviewed-imports.mjs';
import { htmlElements, imageSchemas } from '../../scripts/seo/image-seo.mjs';
import { imageObject } from '../../src/lib/image-schema.ts';
import { displayTitle } from '../../src/lib/display-title.ts';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:4387';
if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(base)) throw Error('Local preview only');
const out = resolve(process.env.UC_COLLECTION_REPORT ?? 'reports/curated-collections');
mkdirSync(out, { recursive: true });
const publicRoot = resolve('public'),
  publication = JSON.parse(readFileSync('data/publication.json', 'utf8'));
const media = new Map(
  publication.files.map((f) => [f.url, { ...f, path: join(publicRoot, f.path) }]),
);
const canonical = new Map(readReviewedImportCatalog(process.cwd()).map((a) => [a.id, a]));
const expectedImages = new Map(
  publication.files
    .filter((f) => f.kind === 'webp')
    .map((f) => [f.url, { ...canonical.get(f.assetId), webp: f.url }]),
);
const expectedThumbnails = new Map(
  publication.files.filter((f) => f.kind === 'thumb').map((f) => [f.assetId, f.url]),
);
const raw = JSON.parse(readFileSync('data/art.json', 'utf8')),
  topicById = new Map(raw.map((a) => [a.id, a.topic]));
const definitions = [...curatedRegistry.collections, ...curatedRegistry.primaryCovers],
  totalCollections = definitions.length;
for (const name of ['owner-lesotho-20261104', 'lesotho-additional-20-20261104']) {
  const path = 'data/catalog-batches/' + name + '.json';
  if (!existsSync(path)) continue;
  const d = JSON.parse(readFileSync(path, 'utf8')),
    files = new Map(d.sourceFiles.map((f) => [f.path, f]));
  for (const change of d.changes) {
    topicById.set(change.id, change.record.topic);
    expectedImages.set(change.record.webp, change.record);
    expectedThumbnails.set(change.id, change.record.originalThumb);
  }
  for (const [url, path] of Object.entries(d.sourceMediaByURL))
    media.set(url, {
      ...files.get(path),
      path,
      contentType: url.endsWith('.webp') ? 'image/webp' : 'application/pdf',
    });
}
const report = {
  status: 'LOCAL_BROWSER_QA_NOT_PUBLICATION',
  routes: [],
  viewports: [],
  noJavaScript: false,
  errors: [],
  sourceImages: 0,
  metadataImageInstances: 0,
  metadataScope:
    'All new collection main content: covers, gallery previews and the latest-subject cards. Existing shared navigation and footer artwork are outside this change.',
  sourceMedia:
    'Original immutable image URLs fulfilled with their checksum-matched local source bytes for deterministic UI testing. This is not a new CDN verification.',
};
function verifyImageMetadata(html, label) {
  const allElements = htmlElements(html),
    start = html.indexOf('<main'),
    end = html.indexOf('</main>', start),
    elements = htmlElements(html.slice(start, end + 7)),
    schemas = allElements
      .filter((e) => e.name === 'script' && e.attributes.type === 'application/ld+json')
      .flatMap((e) => imageSchemas(JSON.parse(e.text)));
  assert(start >= 0 && end > start, label + ' main content');
  for (const e of elements.filter((e) => e.name === 'img' && e.attributes.alt?.trim())) {
    const image = e.attributes,
      source = expectedImages.get(image.src);
    if (!source) continue;
    if (image['data-original-placeholder']) {
      assert.equal(
        image['data-original-placeholder-for'],
        image.src,
        label + ' loading preview binds the exact original',
      );
      assert.equal(
        image['data-original-placeholder'],
        expectedThumbnails.get(source.id),
        label + ' approved loading thumbnail',
      );
      assert.notEqual(
        image.src,
        image['data-original-placeholder'],
        label + ' original source stays distinct',
      );
    }
    if (image['data-cover-artwork'])
      assert.equal(source.id, image['data-cover-artwork'], label + ' exact cover source');
    assert.equal(image.alt, source.alt, label + ' source alt');
    assert.equal(image.title, displayTitle(source.title), label + ' shared display title');
    const expected = imageObject(source),
      schema = schemas.find((s) => s.contentUrl === image.src);
    assert(schema, label + ' source image schema: ' + source.id);
    for (const key of [
      '@id',
      'name',
      'caption',
      'description',
      'contentUrl',
      'license',
      'copyrightNotice',
      'encodingFormat',
      'width',
      'height',
    ])
      assert.deepEqual(schema[key], expected[key], label + ' ' + source.id + ' ' + key);
    report.metadataImageInstances++;
  }
}
const browser = await chromium.launch({
  ...(process.env.UC_CHROME_PATH ? { executablePath: process.env.UC_CHROME_PATH } : {}),
  headless: true,
});
try {
  const context = await browser.newContext();
  const verifiedImages = new Set();
  await context.route('https://assets.ultraclipart.com/**', async (route) => {
    const f = media.get(route.request().url());
    if (!f || !existsSync(f.path)) {
      report.errors.push('Unresolved source image ' + route.request().url());
      return route.abort();
    }
    const bytes = readFileSync(f.path);
    if (bytes.length !== f.bytes || createHash('sha256').update(bytes).digest('hex') !== f.sha256) {
      report.errors.push('Changed source image ' + route.request().url());
      return route.abort();
    }
    verifiedImages.add(f.sha256);
    return route.fulfill({ status: 200, contentType: f.contentType ?? 'image/webp', body: bytes });
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => report.errors.push(e.message));
  const response = await page.goto(base + '/collections/', { waitUntil: 'domcontentloaded' });
  assert.equal(response.status(), 200);
  verifyImageMetadata(await response.text(), '/collections/');
  const necessary = page.locator('[data-cookie-choice="necessary"]:visible').first();
  if (await necessary.count()) await necessary.click();
  const paint = async (selector) =>
    page.locator(selector).evaluateAll(async (images) => {
      await Promise.all(images.map((i) => i.decode()));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
  const paintVisible = async () =>
    page.locator('[data-collection-card] img').evaluateAll(async (images) => {
      const visible = images.filter((i) => {
        const r = i.getBoundingClientRect();
        return r.top < innerHeight && r.bottom > 0;
      });
      await Promise.all(visible.map((i) => i.decode()));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
  await expect(page.locator('[data-collection-card]')).toHaveCount(totalCollections);
  for (const definition of definitions) {
    const path = '/collection/' + definition.slug + '/',
      r = await page.request.get(base + path),
      html = await r.text();
    assert.equal(r.status(), 200, path);
    verifyImageMetadata(html, path);
    assert(html.includes('https://ultraclipart.com' + path), path + ' canonical');
    const cover = [...html.matchAll(/data-cover-artwork="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(
      cover,
      definition.cover.map((a) => a.id),
      path + ' cover',
    );
    const ids = [...html.matchAll(/<article\b[^>]*data-id="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, path + ' duplicate gallery');
    assert(ids.length > 0 && ids.length <= 32, path + ' bounded gallery');
    if (definition.topicSlugs) {
      assert(
        ids.every((id) => definition.topicSlugs.includes(topicById.get(id))),
        path + ' exact topic membership',
      );
      for (const slug of definition.topicSlugs)
        assert(html.includes('/clipart/' + slug + '/'), path + ' subject link');
    }
    assert(!html.includes('{{artworkCount}}'), path + ' dynamic introduction');
    assert(html.includes(definition.paragraphs[0].slice(0, 55)), path + ' reviewed introduction');
    report.routes.push({
      path,
      status: 200,
      cover: 3,
      gallery: ids.length,
      correctMembership: true,
    });
  }
  const xml = await (await page.request.get(base + '/sitemap-collections.xml')).text();
  assert.equal((xml.match(/<url>/g) ?? []).length, curatedRegistry.collections.length);
  for (const g of curatedRegistry.collections)
    assert(xml.includes('https://ultraclipart.com/collection/' + g.slug + '/'));
  await expect(page.locator('[data-catalog-count="collections"]')).toHaveText(
    String(totalCollections),
  );
  const counts = await (await page.request.get(base + '/catalog-stats.json')).json();
  report.catalogTotals = counts.totals;
  await expect(page.locator('[data-catalog-count="artworks"]').first()).toHaveText(
    counts.totals.artworks.toLocaleString('en-US'),
  );
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator('#collection-query').fill('jaguar');
    await expect(page.locator('[data-collection-card]:visible')).toHaveCount(2);
    await expect(
      page.locator('a[data-collection-card][href="/collection/wild-cats/"]'),
    ).toBeVisible();
    await expect(
      page.locator('a[data-collection-card][href="/collection/cars-vehicle-brands/"]'),
    ).toBeHidden();
    await page.locator('#collection-query').fill('');
    await page.locator('[data-collection-filter="Food"]').click();
    await expect(page.locator('[data-collection-card]:visible')).toHaveCount(
      curatedRegistry.collections.filter((g) => g.section === 'Food').length,
    );
    await page.locator('[data-collection-filter="All"], [data-collection-filter="all"]').click();
    await page.locator('#collection-query').fill('no-such-collection-zzzz');
    await expect(page.locator('#collection-no-results')).toBeVisible();
    await page.locator('#collection-query').fill('');
    await expect(page.locator('[data-collection-card]:visible')).toHaveCount(totalCollections);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    );
    assert.equal(overflow, false, 'directory overflow ' + width);
    await page.locator('[data-collection-card]').first().scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        page
          .locator('[data-collection-card]')
          .first()
          .locator('img')
          .evaluateAll((images) => images.every((i) => i.complete && i.naturalWidth > 0)),
      )
      .toBe(true);
    if (width === 390 || width === 1440) {
      await paintVisible();
      await page.screenshot({ path: join(out, 'collections-' + width + '.png') });
      const axe = await new AxeBuilder({ page })
        .include('.collection-directory')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      assert.deepEqual(
        axe.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
        [],
      );
    }
    await page.goto(base + '/collection/farm-animals/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1')).toHaveText('Farm Animals');
    await expect(
      page
        .locator('[data-catalog-key="farm-animals"][data-catalog-count="collection-artworks"]')
        .first(),
    ).toHaveText(counts.collections['farm-animals'].artworks.toLocaleString('en-US'));
    await expect(page.locator('.collection-subject-picker')).toBeVisible();
    await expect(page.locator('.collection-subject-picker')).not.toHaveAttribute('open');
    await page.locator('.collection-subject-picker summary').click();
    await expect(page.locator('.mobile-subject-options a')).toHaveCount(13);
    await page.locator('.collection-subject-picker summary').click();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
      false,
      'collection overflow ' + width,
    );
    if (width === 390 || width === 1440) {
      await expect
        .poll(() =>
          page
            .locator('.collection-cover img')
            .evaluateAll((images) => images.every((i) => i.complete && i.naturalWidth > 0)),
        )
        .toBe(true);
      await paint('.collection-cover img');
      await page.screenshot({ path: join(out, 'farm-animals-' + width + '.png') });
    }
    report.viewports.push({
      width,
      directory: true,
      search: true,
      filters: true,
      emptyState: true,
      collection: true,
      noHorizontalOverflow: true,
    });
    await page.goto(base + '/collections/', { waitUntil: 'domcontentloaded' });
  }
  // Capture every real card for a second visual pass using the actual component and CSS.
  // This changes only the private browser DOM, never site files or catalog membership.
  await page.setViewportSize({ width: 1440, height: 1100 });
  report.coverSheets = [];
  const cards = page.locator('[data-collection-card]');
  for (let offset = 0; offset < totalCollections; offset += 6) {
    await cards.evaluateAll(
      (nodes, { offset }) =>
        nodes.forEach((node, i) => (node.hidden = i < offset || i >= offset + 6)),
      { offset },
    );
    await page.locator('#themed-collections').scrollIntoViewIfNeeded();
    await paint('[data-collection-card]:visible img');
    assert(
      await page
        .locator('[data-collection-card]:visible img')
        .evaluateAll((images) => images.every((i) => i.complete && i.naturalWidth > 0)),
    );
    const file = 'cover-review-' + String(offset / 6 + 1).padStart(2, '0') + '.png';
    await page.locator('#themed-collections').screenshot({ path: join(out, file) });
    const members = await page.locator('[data-collection-card]:visible').evaluateAll((nodes) =>
      nodes.map((n) => ({
        title: n.querySelector('h3').textContent,
        href: n.getAttribute('href'),
        artworkIDs: [...n.querySelectorAll('[data-cover-artwork]')].map(
          (i) => i.dataset.coverArtwork,
        ),
      })),
    );
    report.coverSheets.push({ file, members });
  }
  await page.locator('[data-collection-filter="all"]').click();
  for (const section of ['Food', 'Characters', 'Flags']) {
    await page.locator('[data-collection-filter="' + section + '"]').click();
    await page.locator('[data-collection-card]:visible').first().scrollIntoViewIfNeeded();
    await paint('[data-collection-card]:visible img');
    await page.screenshot({ path: join(out, 'collections-' + section.toLowerCase() + '.png') });
  }
  const nojs = await browser.newContext({ javaScriptEnabled: false });
  const crawler = await nojs.newPage();
  await crawler.route('https://assets.ultraclipart.com/**', (route) => route.abort());
  await crawler.goto(base + '/collections/', { waitUntil: 'domcontentloaded' });
  assert.equal(await crawler.locator('[data-collection-card]:visible').count(), totalCollections);
  await crawler.goto(base + '/collection/primates/', { waitUntil: 'domcontentloaded' });
  await crawler.locator('.collection-subject-picker summary').click();
  assert.equal(await crawler.locator('.mobile-subject-options a:visible').count(), 3);
  await expect(crawler.locator('h1')).toHaveText('Primates');
  report.noJavaScript = true;
  await nojs.close();
  report.sourceImages = verifiedImages.size;
  assert.deepEqual(report.errors, []);
  report.status = 'LOCAL_BROWSER_QA_PASSED_NOT_PUBLISHED';
} finally {
  await browser.close();
  writeFileSync(join(out, 'browser-report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(
  JSON.stringify({
    status: report.status,
    routes: report.routes.length,
    viewports: report.viewports.length,
    sourceImages: report.sourceImages,
    noJavaScript: report.noJavaScript,
    errors: report.errors,
  }),
);
