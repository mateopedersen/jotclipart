// Explicit synthetic media and delayed metadata. This tests behavior, not CDN speed.
import { build } from 'esbuild';
import sharp from 'sharp';
import { chromium, webkit, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { originalImageSchedulingScript } from '../../src/lib/original-image-scheduling-inline.mjs';
const out = process.env.EVIDENCE_DIR ?? 'reports/category-preview-loading';
mkdirSync(out, { recursive: true });
const root = 'a'.repeat(64),
  rows = [],
  color = [28, 132, 209];
const media = await sharp({
  create: { width: 320, height: 160, channels: 4, background: '#1c84d1' },
})
  .webp({ lossless: true })
  .toBuffer();
const js = (
  await build({
    stdin: {
      contents:
        "import './src/scripts/category-directory.ts';import{initOriginalImageLoading}from'./src/scripts/original-image-loading.ts';initOriginalImageLoading();",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'esm',
  })
).outputFiles[0].contents;
const css = [
  'src/styles/global.css',
  'src/styles/categories.css',
  'src/styles/original-image-loading.css',
]
  .map((p) => readFileSync(p, 'utf8'))
  .join('\n');
const asset = (id) => ({
  id,
  title: 'Explicit ' + id,
  alt: 'Synthetic ' + id,
  topic: id,
  style: 'Color',
  thumb: 'https://assets.ultraclipart.com/fixture/' + id + '.thumb.webp',
  width: 320,
  height: 160,
  webp: {
    url: 'https://assets.ultraclipart.com/fixture/' + id + '.original.webp',
    bytes: media.length,
    sha256: 'b'.repeat(64),
  },
  pdf: {
    url: 'https://assets.ultraclipart.com/fixture/' + id + '.pdf',
    bytes: 200,
    sha256: 'c'.repeat(64),
  },
});
const card = (group, i) => {
  const id = group + '-' + i,
    a = asset(id);
  return `<li class="discovery-subject" data-topic="${id}" data-slug="${id}" data-sample-id="${id}" data-groups="${group}" data-name="${id}" data-count="1" data-letter-value="${group[0].toUpperCase()}"><a href="/clipart/${id}/"><div class="subject-art">${group === 'alpha' ? `<img loading="lazy" data-original-deferred="pending" src="${a.webp.url}" data-original-placeholder="${a.thumb}" data-original-placeholder-for="${a.webp.url}" width="240" height="190" alt="Explicit synthetic initial preview">` : '<span class="subject-image-pending">Open Collection</span>'}</div><div class="subject-label"><h3>${id}</h3></div></a></li>`;
};
const html = `<!doctype html><head><script>${originalImageSchedulingScript}</script><style>${css}body{padding:10px}.discovery-subject-grid{width:600px;max-width:100%}.subject-art{height:190px}</style></head><body><details id="discovery-controls" open><summary>Filters</summary><div id="category-filters"><form id="hero-topic-search"><input id="topic-filter"></form><input id="category-group" type="hidden"><select id="category-sort"><option value="name">Name</option><option value="count">Count</option></select>${['alpha', 'beta', 'gamma'].map((v) => `<label><input type="radio" name="collection-filter" value="${v}"><span class="collection-filter-title">${v}</span></label>`).join('')}<details class="discovery-alphabet"></details></div></details><section id="topic-directory"><h2 id="topic-directory-heading"></h2><div data-directory-tools><span id="topic-result-count"></span><div id="active-topic-filters"><span id="active-topic-summary"></span><button id="reset-subjects">Reset</button></div><div id="no-topics"><button id="clear-topic-filter">Clear</button></div></div><ul id="subject-grid" class="discovery-subject-grid">${['alpha', 'beta', 'gamma'].flatMap((g) => [0, 1].map((i) => card(g, i))).join('')}</ul><div id="discovery-more"><span id="subject-progress"></span><button id="show-more-subjects">More</button></div></section><script type="module" src="/module.js"></script>`;
let releaseBeta,
  betaSeen,
  oldReleased = false;
const server = createServer(async (req, res) => {
  if (req.url === '/module.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' }).end(js);
    return;
  }
  if (req.url === '/search-data/manifest.json') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        schema: 1,
        version: root,
        total: 6,
        pageChunk: 256,
        tokenBuckets: 256,
        lexiconLengths: [],
        facets: [],
        topics: [],
        transport: {
          protocol: 'snapshot-search-v1',
          endpoint: '/catalog-search.json',
          snapshot: root,
        },
      }),
    );
    return;
  }
  if (req.url === '/catalog-search.json') {
    let bytes = '';
    for await (const b of req) bytes += b;
    const body = JSON.parse(bytes);
    assert.equal(body.operation, 'studio-items');
    assert.equal(body.snapshot, root);
    if (body.ids[0].startsWith('beta')) {
      betaSeen?.();
      await new Promise((r) => (releaseBeta = r));
    }
    if (body.ids[0].startsWith('gamma')) await new Promise((r) => setTimeout(r, 500));
    if (!res.destroyed)
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ schema: 1, snapshot: root, result: body.ids.map(asset) }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' }).end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
function blueBounds(bytes) {
  return sharp(bytes)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
    .then(({ data, info }) => {
      let left = info.width,
        top = info.height,
        right = -1,
        bottom = -1;
      for (let y = 0; y < info.height; y++)
        for (let x = 0; x < info.width; x++) {
          const i = (y * info.width + x) * info.channels;
          if (color.every((c, k) => Math.abs(data[i + k] - c) < 3)) {
            left = Math.min(left, x);
            right = Math.max(right, x);
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
        }
      assert(right > left && bottom > top);
      return { left, right, top, bottom };
    });
}
try {
  for (const [engine, type] of Object.entries(
    process.env.UC_BROWSER
      ? { [process.env.UC_BROWSER]: { chromium, webkit }[process.env.UC_BROWSER] }
      : { chromium, webkit },
  )) {
    const browser = await type.launch(
      engine === 'chromium' && process.env.UC_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.UC_CHROMIUM_EXECUTABLE_PATH }
        : {},
    );
    try {
      for (const width of [390, 1440]) {
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        let releaseOriginal;
        const held = new Promise((r) => (releaseOriginal = r));
        let releaseOld;
        const oldSeen = new Promise((r) => (betaSeen = r));
        oldReleased = false;
        await context.route('https://assets.ultraclipart.com/fixture/**', async (route) => {
          if (route.request().url().endsWith('.original.webp')) await held;
          await route
            .fulfill({ status: 200, contentType: 'image/webp', body: media })
            .catch(() => {});
        });
        const page = await context.newPage(),
          errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        try {
          await page.goto('http://127.0.0.1:' + server.address().port + '/?collection=alpha', {
            waitUntil: 'domcontentloaded',
          });
          await expect(page.locator('#discovery-controls')).toHaveAttribute('data-ready', 'true');
          const initial = page.locator('[data-slug="alpha-0"] .subject-art');
          await initial.scrollIntoViewIfNeeded();
          await expect(initial.locator('.original-image-loading-backdrop')).toHaveCount(1);
          const before = await blueBounds(
            await initial.screenshot({ path: out + '/' + engine + '-' + width + '-pending.png' }),
          );
          const source = await initial.locator('img').getAttribute('src');
          if (!(await page.locator('#discovery-controls').evaluate((e) => e.open)))
            await page.locator('#discovery-controls > summary').click();
          await page.locator('[name="collection-filter"][value="beta"]').check();
          await oldSeen;
          releaseOld = releaseBeta;
          await page.locator('[name="collection-filter"][value="gamma"]').check();
          await page
            .locator('[name="collection-filter"][value="beta"]')
            .evaluate((e) => e.parentElement.dispatchEvent(new PointerEvent('pointerenter')));
          const gamma = page.locator('[data-slug="gamma-0"] .subject-art');
          await gamma.scrollIntoViewIfNeeded();
          await expect(gamma.locator('img')).toHaveCount(1, { timeout: 5000 });
          await expect(gamma.locator('.original-image-loading-backdrop')).toHaveCount(1, {
            timeout: 5000,
          });
          assert.equal(
            oldReleased,
            false,
            'Current filter must paint before obsolete metadata resolves',
          );
          assert.equal(await gamma.locator('img').getAttribute('src'), asset('gamma-0').webp.url);
          assert.equal(
            await gamma.locator('img').getAttribute('data-original-placeholder'),
            asset('gamma-0').thumb,
          );
          await page.screenshot({ path: out + '/' + engine + '-' + width + '-current-filter.png' });
          oldReleased = true;
          releaseOld();
          await page.waitForTimeout(100);
          assert.equal(
            await page.locator('[data-slug="beta-0"] img').count(),
            0,
            'Obsolete batch must not write stale images',
          );
          releaseOriginal();
          await page.locator('[name="collection-filter"][value="alpha"]').check();
          await initial.scrollIntoViewIfNeeded();
          await expect
            .poll(() => initial.locator('img').evaluate((i) => i.complete && i.naturalWidth > 0))
            .toBe(true);
          const after = await blueBounds(
            await initial.screenshot({ path: out + '/' + engine + '-' + width + '-loaded.png' }),
          );
          assert.equal(
            after.right - after.left,
            before.right - before.left,
            'Preview and original painted widths differ',
          );
          assert.equal(
            after.bottom - after.top,
            before.bottom - before.top,
            'Preview and original painted heights differ',
          );
          assert(
            Object.keys(before).every((k) => Math.abs(before[k] - after[k]) <= 1),
            'Preview moved by more than one raster rounding pixel',
          );
          assert.equal(await initial.locator('img').getAttribute('src'), source);
          assert.deepEqual(errors, []);
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
            false,
          );
          rows.push({
            passed: true,
            engine,
            width,
            originalSourceUnchanged: true,
            previewAndOriginalBounds: { before, after },
            currentFilterPaintedBeforeOldResponse: true,
            errors,
          });
        } finally {
          releaseOriginal();
          releaseOld?.();
          releaseBeta?.();
          await context.close();
          writeFileSync(
            out + '/report.json',
            JSON.stringify(
              {
                passed: rows.length === 4 && rows.every((r) => r.passed),
                scope:
                  'Explicit delayed synthetic originals and stale metadata; actual category and image-loading modules and CSS. Not a public speed measurement.',
                cases: rows,
              },
              null,
              2,
            ),
          );
        }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  releaseBeta?.();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
assert(rows.every((r) => r.passed));
console.log(JSON.stringify({ passed: true, cases: rows.length }));
