// Controlled real-browser pixels: originals are held, never replaced or resized.
import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { build } from 'esbuild';
import sharp from 'sharp';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { originalImageSchedulingScript } from '../../src/lib/original-image-scheduling-inline.mjs';
const out = process.env.EVIDENCE_DIR ?? 'reports/related-loading-preview';
mkdirSync(out, { recursive: true });
const origin = 'https://assets.jotclipart.com/fixture/';
const pixels = {};
for (const [name, color] of Object.entries({
  original: '#cf392f',
  preview: '#29a352',
  collection: '#2475ce',
}))
  pixels[name] = await sharp({ create: { width: 160, height: 96, channels: 4, background: color } })
    .webp({ lossless: true })
    .toBuffer();
const module = (
  await build({
    stdin: {
      contents:
        "import{initOriginalImageLoading}from'./src/scripts/original-image-loading.ts';import{initRelatedArtwork}from'./src/scripts/related-artwork.ts';initOriginalImageLoading();initRelatedArtwork();",
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: 'esm',
    write: false,
  })
).outputFiles[0].contents;
const css = [
  'global',
  'card-media',
  'original-image-loading',
  'related',
  'artwork-detail',
  'site-header',
]
  .map((n) => readFileSync('src/styles/' + n + '.css', 'utf8').replace(/@import[^;]+;/g, ''))
  .join('\n');
function record(i, group, scenario) {
  const webp = origin + 'original-' + i + '.webp';
  return {
    id: 'fixture-' + i,
    title: 'Explicit fixture ' + i,
    alt: 'Controlled image fixture ' + i,
    webp,
    pdf: origin + 'document-' + i + '.pdf',
    href: '/art/fixture-' + i + '/',
    reason: 'Controlled browser fixture',
    reasonCode: 'fixture',
    group,
    monochrome: false,
    editable: i !== 5,
    ...(scenario === 'bound'
      ? {
          loadingPreview: {
            source: webp,
            url: origin + (group === 'collection' ? 'collection' : 'preview') + '-' + i + '.webp',
          },
        }
      : scenario === 'mismatched'
        ? {
            loadingPreview: {
              source: origin + 'different.webp',
              url: origin + 'preview-' + i + '.webp',
            },
          }
        : {}),
  };
}
function html(scenario) {
  const alternatives = Array.from({ length: 16 }, (_, i) => record(i, 'alternatives', scenario)),
    collection = Array.from({ length: 4 }, (_, i) => record(i + 20, 'collection', scenario));
  const snapshot = {
    sourceId: 'fixture-source',
    version: 'fixture-v1',
    algorithm: 'fixture',
    alternatives,
    companions: [],
    collection,
  };
  const sample = (r) =>
    `<article class="related-card" data-related-id="${r.id}" data-related-group="${r.group}"><a class="related-picture" href="${r.href}" data-related-detail><img width="400" height="400" loading="lazy" data-original-deferred="pending" src="${r.webp}" ${r.loadingPreview ? `data-original-placeholder="${r.loadingPreview.url}" data-original-placeholder-for="${r.loadingPreview.source}"` : ''} alt="${r.alt}"><span class="related-image-error" hidden>Preview unavailable</span></a><div class="related-card-copy"><a class="related-card-title" data-related-detail href="${r.href}">${r.title}</a><p class="related-reason">${r.reason}</p><div class="formats related-card-actions"><a href="${r.webp}" data-related-download="webp">Image</a><a href="${r.pdf}" data-related-download="pdf">PDF</a></div></div></article>`;
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width"><script>${originalImageSchedulingScript}</script><style>${css}.related-discovery{margin:0;padding:16px}.related-grid{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important}.related-grid>.related-card{width:auto!important}.related-card{min-width:0}@media(max-width:900px){.related-grid{grid-template-columns:1fr!important}}.art-detail{display:block}.site-header{position:static}</style></head><body><header class="site-header"><button class="site-nav-trigger" data-current="true">Browse</button></header><section class="art-detail"><h1>Black artwork title</h1><p class="art-detail-description">Black normal description</p></section><section class="related-discovery" data-related-root><script type="application/json" data-related-snapshot>${JSON.stringify(snapshot)}</script><div data-related-controls><button data-related-mode="best">Best</button><button data-related-mode="collection">Collection</button></div><p data-related-status></p><a data-related-refresh hidden>Refresh</a><div data-related-results><div data-related-alternatives><div class="related-grid">${alternatives.slice(0, 2).map(sample).join('')}</div></div><div data-related-companions hidden><div class="related-grid"></div></div><div data-related-collection hidden><div class="related-grid"></div></div></div><div data-related-sentinel></div><button data-related-more>Show more</button><p data-related-scroll-hint hidden>More</p></section><script>window.initialRelatedImage=document.querySelector('.related-card img')</script><script type="module" src="/client.js"></script></body></html>`;
}
const server = createServer((req, res) => {
  if (req.url === '/client.js')
    return res.writeHead(200, { 'content-type': 'text/javascript' }).end(module);
  if (req.url === '/related-release.json')
    return res
      .writeHead(200, { 'content-type': 'application/json' })
      .end('{"version":"fixture-v1"}');
  if (req.url?.startsWith('/illustrations/')) {
    const p = resolve('public' + req.url);
    if (p.startsWith(resolve('public') + '/') && existsSync(p))
      return res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(readFileSync(p));
  }
  return res
    .writeHead(200, { 'content-type': 'text/html' })
    .end(html(new URL(req.url, 'http://localhost').searchParams.get('scenario') ?? 'bound'));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
const report = [];
try {
  for (const [engine, type] of Object.entries({ chromium, webkit })) {
    const browser = await type.launch();
    try {
      for (const width of [390, 1440])
        for (const scenario of ['bound', 'missing', 'mismatched']) {
          const context = await browser.newContext({ viewport: { width, height: 1000 } });
          let release;
          const gate = new Promise((r) => (release = r));
          const errors = [];
          await context.route(origin + '**', async (route) => {
            const u = route.request().url();
            if (u.includes('/original-')) await gate;
            await route
              .fulfill({
                status: 200,
                contentType: 'image/webp',
                body: pixels[
                  u.includes('/original-')
                    ? 'original'
                    : u.includes('/collection-')
                      ? 'collection'
                      : 'preview'
                ],
              })
              .catch(() => {});
          });
          const page = await context.newPage();
          page.on('pageerror', (e) => errors.push(e.message));
          try {
            await page.goto(base + '/?scenario=' + scenario, { waitUntil: 'domcontentloaded' });
            await expect(page.locator('[data-related-root][data-ready=true]')).toHaveCount(1);
            const first = page.locator('.related-card').first();
            await first.scrollIntoViewIfNeeded();
            assert(
              await page.evaluate(
                () => window.initialRelatedImage === document.querySelector('.related-card img'),
              ),
              'Visible SSR original node was unnecessarily recreated',
            );
            for (const selector of [
              '.art-detail h1',
              '.art-detail-description',
              '.site-nav-trigger',
            ])
              assert.equal(
                await page.locator(selector).evaluate((e) => getComputedStyle(e).color),
                'rgb(0, 0, 0)',
              );
            if (scenario === 'bound') {
              await expect(first.locator('.original-image-loading-backdrop')).toHaveCount(1);
              await page.screenshot({ path: out + '/' + engine + '-' + width + '-pending.png' });
              const shot = await sharp(await first.locator('.related-picture').screenshot())
                .raw()
                .toBuffer({ resolveWithObject: true });
              const offset =
                (Math.floor(shot.info.height / 2) * shot.info.width +
                  Math.floor(shot.info.width / 2)) *
                shot.info.channels;
              assert(
                shot.data[offset + 1] > shot.data[offset] + 40,
                'Preview pixels are absent while original is held',
              );
            } else await expect(first.locator('.original-image-loading-backdrop')).toHaveCount(0);
            const more = page.locator('[data-related-more]');
            await more.focus();
            const before = await page.locator('.related-card').count();
            await more.click();
            await expect.poll(() => page.locator('.related-card').count()).toBeGreaterThan(before);
            for (const card of await page.locator('.related-card').all()) {
              const id = await card.getAttribute('data-related-id');
              const link = card.locator('[data-related-edit]');
              await expect(link).toHaveAttribute(
                'href',
                id === 'fixture-5' ? '/art/' + id + '/' : '/edit/' + id + '/',
              );
              await expect(link.locator('[data-related-edit-label]')).toHaveText(
                id === 'fixture-5' ? 'View' : 'Edit',
              );
            }
            release();
            await first.scrollIntoViewIfNeeded();
            await expect
              .poll(() =>
                first.locator('.related-picture img').evaluate((e) => e.complete && e.naturalWidth),
              )
              .toBe(160);
            await expect(first.locator('.original-image-loading-backdrop')).toHaveCount(0);
            assert.equal(
              await first.locator('.related-picture img').getAttribute('src'),
              origin + 'original-0.webp',
            );
            await page.locator('[data-related-mode=collection]').click();
            await expect(page.locator('[data-related-root]')).not.toHaveAttribute(
              'aria-busy',
              'true',
            );
            for (const card of await page.locator('.related-card').all()) {
              const image = card.locator('.related-picture img');
              if (scenario === 'bound')
                assert.equal(
                  await image.getAttribute('data-original-placeholder-for'),
                  await image.getAttribute('src'),
                );
              await expect(card.locator('[data-related-edit]')).toHaveAttribute(
                'href',
                '/edit/' + (await card.getAttribute('data-related-id')) + '/',
              );
            }
            assert.deepEqual(errors, []);
            report.push({
              engine,
              width,
              scenario,
              SSRRequestRetained: true,
              blackText: true,
              editTargetsCorrect: true,
              originalSourceUnchanged: true,
              status: 'passed',
            });
          } finally {
            release();
            await context.close();
          }
        }
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((r) => server.close(r));
  writeFileSync(
    out + '/report.json',
    JSON.stringify(
      {
        scope:
          'Controlled original transfers, real browser pixels and actual production client modules; not a public CDN speed claim',
        cases: report,
      },
      null,
      2,
    ) + '\n',
  );
}
assert.equal(report.length, 12);
console.log(
  JSON.stringify({
    passed: report.length,
    scope:
      'Related first paint, SSR request continuity, full originals, Edit targets and black type',
  }),
);
