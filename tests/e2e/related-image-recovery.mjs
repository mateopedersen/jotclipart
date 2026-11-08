// Controlled pixels and HTTP failures verify UI recovery, not public CDN speed.
import { chromium, firefox, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { siteNavigationScript } from '../../src/lib/site-navigation-inline.mjs';
const out = process.env.EVIDENCE_DIR ?? 'reports/related-image-recovery';
mkdirSync(out, { recursive: true });
const pixels = await sharp({
  create: { width: 64, height: 64, channels: 4, background: '#347ac1' },
})
  .webp()
  .toBuffer();
const source = 'https://assets.ultraclipart.com/fixture/related-original.webp';
const item = {
  id: 'related-fixture',
  title: 'Explicit Related Fixture',
  alt: 'Explicit blue fixture',
  href: '/art/related-fixture/',
  webp: source,
  pdf: 'https://assets.ultraclipart.com/fixture/related-original.pdf',
  reason: 'Explicit network fixture',
  reasonCode: 'fixture',
  group: 'alternatives',
  monochrome: false,
};
const snapshot = {
  sourceId: 'fixture-source',
  version: 'fixture-v1',
  algorithm: 'fixture',
  alternatives: [item],
  companions: [],
  collection: [],
};
const client = new Map();
for (const scenario of ['transient', 'permanent', 'late-controller', 'no-controller']) {
  const init = 'initOriginalImageLoading(document,{retryDelays:[20,60],stallMs:500});';
  const code =
    "import{initOriginalImageLoading}from'./src/scripts/original-image-loading.ts';import{initRelatedArtwork}from'./src/scripts/related-artwork.ts';" +
    (scenario === 'no-controller'
      ? 'initRelatedArtwork();'
      : scenario === 'late-controller'
        ? 'initRelatedArtwork();setTimeout(()=>{' + init + '},250);'
        : init + 'initRelatedArtwork();');
  client.set(
    '/' + scenario + '.js',
    (
      await build({
        stdin: { contents: code, resolveDir: process.cwd() },
        write: false,
        bundle: true,
        format: 'esm',
      })
    ).outputFiles[0].contents,
  );
}
const originalCSS = readFileSync('src/styles/original-image-loading.css', 'utf8');
const token = "'sha256-" + createHash('sha256').update(siteNavigationScript).digest('base64') + "'";
const html = (scenario) =>
  '<!doctype html><html><head><meta name="viewport" content="width=device-width"><script>' +
  siteNavigationScript +
  '</script><style>' +
  originalCSS +
  '[hidden]{display:none!important}.related-picture{position:relative;display:block;width:120px;height:120px}.related-picture img{width:100%;height:100%;object-fit:contain}.related-card{width:250px;padding:10px;border:1px solid #abd}</style></head><body><section data-related-root><script type="application/json" data-related-snapshot>' +
  JSON.stringify({
    ...snapshot,
    alternatives: [{ ...item, pdf: scenario === 'late-controller' ? undefined : item.pdf }],
  }) +
  '</script><p data-related-status></p><div data-related-controls><button data-related-mode="subject">Subject</button><button data-related-mode="best">Best</button></div><a href="/" data-related-refresh hidden>Refresh</a><div data-related-results><div data-related-alternatives><div class="related-grid"><article class="related-card" data-related-id="' +
  item.id +
  '"><a class="related-picture" href="' +
  item.href +
  '" aria-label="' +
  item.alt +
  '" data-related-detail><img src="' +
  source +
  '" alt="' +
  item.alt +
  '" width="120" height="120" loading="lazy" data-original-deferred="pending"><span class="related-image-error" hidden>Preview unavailable · View artwork</span></a><a class="related-card-title" href="' +
  item.href +
  '" data-related-detail>Explicit Related Fixture</a><p class="related-reason">Fixture</p><a href="' +
  source +
  '" data-related-download="webp">Image</a><a href="' +
  item.pdf +
  '" data-related-download="pdf">PDF</a></article></div></div><div data-related-companions><div class="related-grid"></div></div><div data-related-collection><div class="related-grid"></div></div></div><button data-related-more>More</button><span data-related-scroll-hint></span><span data-related-sentinel></span></section><script type="module" src="/' +
  scenario +
  '.js"></script></body></html>';
const server = createServer((req, res) => {
  if (req.url === '/related-release.json') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ version: snapshot.version }));
    return;
  }
  res.setHeader('Content-Type', client.has(req.url) ? 'text/javascript' : 'text/html');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self';img-src https://assets.ultraclipart.com;style-src 'unsafe-inline';script-src 'self' " +
      token,
  );
  res.end(client.get(req.url) ?? html(new URL(req.url, 'http://fixture').pathname.slice(1)));
}).listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const report = {
  scope:
    'Explicit controlled network/pixel fixture. Real related UI, original scheduling and bounded retry modules; no public CDN speed claim.',
  cases: [],
  passed: false,
};
try {
  for (const [engine, type] of Object.entries(
    process.env.UC_BROWSER
      ? { [process.env.UC_BROWSER]: { chromium, firefox, webkit }[process.env.UC_BROWSER] }
      : { chromium, webkit },
  )) {
    const browser = await type.launch(
      engine === 'chromium' && process.env.UC_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.UC_CHROMIUM_EXECUTABLE_PATH }
        : {},
    );
    try {
      for (const scenario of ['transient', 'permanent', 'late-controller', 'no-controller']) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
        try {
          let attempts = 0,
            healthy = false;
          const errors = [];
          await context.addInitScript(() => {
            Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
            window.relatedEvents = [];
            addEventListener('ultraclipart:related', (e) => window.relatedEvents.push(e.detail));
          });
          await context.route(source, async (route) => {
            attempts++;
            await new Promise((resolve) => setTimeout(resolve, 30));
            const failure =
              !healthy &&
              (scenario === 'permanent' || scenario === 'no-controller' || attempts === 1);
            await route.fulfill(
              failure
                ? {
                    status: 503,
                    headers: { 'cache-control': 'no-store' },
                    body: 'Explicit temporary failure',
                  }
                : { status: 200, contentType: 'image/webp', body: pixels },
            );
          });
          const page = await context.newPage();
          page.on('pageerror', (e) => errors.push(e.message));
          await page.goto('http://127.0.0.1:' + server.address().port + '/' + scenario, {
            waitUntil: 'domcontentloaded',
          });
          const root = page.locator('[data-related-root]');
          await expect(root).toHaveAttribute('data-ready', 'true');
          const card = page.locator('.related-card'),
            image = card.locator('img');
          await expect(image).toHaveAttribute('data-original-deferred', 'pending');
          await page.evaluate(() => {
            Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
            dispatchEvent(new Event('online'));
          });
          if (scenario === 'permanent' || scenario === 'no-controller') {
            await expect(card.locator('.related-image-error')).toBeVisible({ timeout: 9000 });
            await expect(card.locator('[data-related-download]:visible')).toHaveCount(0);
            assert.equal(attempts, scenario === 'permanent' ? 3 : 1);
            await image.evaluate((img) => {
              for (let i = 0; i < 3; i++)
                img.dispatchEvent(new Event('uc:original-image-terminal-error'));
            });
            assert.equal(
              await page.evaluate(
                () => window.relatedEvents.filter((e) => e.event === 'thumbnail_error').length,
              ),
              1,
            );
            await page.waitForTimeout(150);
            assert.equal(
              attempts,
              scenario === 'permanent' ? 3 : 1,
              'Failures stop at the existing retry budget',
            );
            healthy = true;
            await page.locator('[data-related-mode="subject"]').click();
          }
          await expect
            .poll(() => image.evaluate((img) => img.complete && img.naturalWidth === 64), {
              timeout: 5000,
            })
            .toBe(true);
          await expect(image).toBeVisible();
          await expect(card.locator('.related-image-error')).toBeHidden();
          await expect(card.locator('[data-related-download]:visible')).toHaveCount(
            scenario === 'late-controller' ? 1 : 2,
          );
          assert.equal(await image.evaluate((img) => img.currentSrc), source);
          assert.equal(
            await card.locator('[data-related-download="webp"]').getAttribute('href'),
            source,
          );
          assert.equal(
            await card.locator('[data-related-download="pdf"]').getAttribute('href'),
            scenario === 'late-controller' ? null : item.pdf,
          );
          const finished = attempts;
          await image.evaluate((img) => {
            img.dispatchEvent(new Event('load'));
            img.dispatchEvent(new Event('load'));
          });
          await expect(card.locator('[data-related-download]:visible')).toHaveCount(
            scenario === 'late-controller' ? 1 : 2,
          );
          assert.equal(attempts, finished);
          if (scenario === 'transient' || scenario === 'late-controller') assert.equal(attempts, 2);
          assert.deepEqual(errors, []);
          await page.screenshot({ path: out + '/' + engine + '-' + scenario + '.png' });
          report.cases.push({
            engine,
            scenario,
            passed: true,
            attempts,
            originalSource: source,
            downloadURLsPreserved: true,
            errors,
          });
          console.log(JSON.stringify(report.cases.at(-1)));
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
  report.passed = true;
} finally {
  server.close();
  writeFileSync(out + '/report.json', JSON.stringify(report, null, 2));
}
