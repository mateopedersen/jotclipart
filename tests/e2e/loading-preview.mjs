// Explicitly synthetic media and fault injection; real cover/CDN proof is separate.
import { build } from 'esbuild';
import sharp from 'sharp';
import { createServer } from 'node:http';
import { chromium, webkit, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { galleryImageStartupScript } from '../../src/lib/gallery-image-startup.mjs';
const out = resolve(process.env.UC_COLLECTION_REPORT ?? 'reports/loading-preview');
mkdirSync(out, { recursive: true });
const compiled = await build({
  stdin: {
    contents:
      "import{initOriginalImageLoading}from'./src/scripts/original-image-loading.ts';initOriginalImageLoading();",
    resolveDir: resolve('.'),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  write: false,
});
const css = readFileSync('src/styles/original-image-loading.css', 'utf8');
const originalURL = 'https://assets.ultraclipart.com/explicit-fixture/original.webp',
  thumbURL = 'https://assets.ultraclipart.com/explicit-fixture/thumbnail.webp';
const red = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#e34040' } })
  .webp()
  .toBuffer();
const blue = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#2470dd' } })
  .webp()
  .toBuffer();
const server = createServer((req, res) => {
  if (req.url === '/loader.js') {
    res.setHeader('Content-Type', 'text/javascript');
    return res.end(compiled.outputFiles[0].text);
  }
  const offscreen = req.url === '/offscreen',
    near = req.url === '/near',
    missingModule = req.url === '/missing-module',
    pending = req.url === '/nojs';
  res.setHeader('Content-Type', 'text/html');
  res.end(
    `<!doctype html><html><head><script>${galleryImageStartupScript}</script><style>${css}.art-picture{display:block;content-visibility:auto;width:180px;height:180px}</style><noscript><style>img[data-original-preview]{background-image:none!important}</style></noscript></head><body><div style="height:${offscreen ? 5000 : near ? 1050 : 0}px"></div><article class="art-card"><a class="art-picture" href="/art/fixture/" aria-label="Explicit synthetic fixture"><img width="180" height="180" alt="Explicit synthetic fixture" src="${originalURL}" loading="lazy" data-original-placeholder="${thumbURL}" data-original-placeholder-for="${originalURL}" ${pending ? `data-original-preview="pending" style='--original-loading-preview:url("${thumbURL}")'` : ''}></a></article>${missingModule ? '' : '<script type="module" src="/loader.js"></script>'}</body></html>`,
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const engine = process.env.UC_TEST_ENGINE === 'webkit' ? 'webkit' : 'chromium';
const browser =
  engine === 'webkit'
    ? await webkit.launch()
    : await chromium.launch({
        executablePath:
          process.env.UC_CHROME_PATH ??
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true,
      });
const report = {
  scope:
    'Synthetic network gates verify progressive CSS display, original-source invariants, stale binding, offscreen behavior and JavaScript-disabled fallback; not a live CDN measurement.',
  status: 'RUNNING',
  engine,
  cases: [],
};
try {
  for (const scenario of [
    'gated-original',
    'failed-placeholder',
    'changed-source',
    'near',
    'offscreen',
    'nojs',
    'missing-module',
  ]) {
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        javaScriptEnabled: scenario !== 'nojs',
      }),
      page = await context.newPage();
    let release,
      replacementRelease,
      thumbnails = 0;
    const gate = new Promise((r) => (release = r)),
      replacement = new Promise((r) => (replacementRelease = r));
    try {
      await context.route('https://assets.ultraclipart.com/**', async (route) => {
        if (route.request().url() === thumbURL) {
          thumbnails++;
          return route.fulfill({
            status: scenario === 'failed-placeholder' ? 503 : 200,
            headers: { 'access-control-allow-origin': '*' },
            contentType: scenario === 'failed-placeholder' ? 'text/plain' : 'image/webp',
            body: scenario === 'failed-placeholder' ? 'Unavailable' : blue,
          });
        }
        if (scenario !== 'nojs' && scenario !== 'missing-module')
          await (route.request().url().includes('replacement') ? replacement : gate);
        try {
          await route.fulfill({ status: 200, contentType: 'image/webp', body: red });
        } catch {
          /* A source change may cancel the deliberately held old request. */
        }
      });
      await page.goto('http://127.0.0.1:' + server.address().port + '/' + scenario, {
        waitUntil: 'domcontentloaded',
      });
      const image = page.locator('.art-picture img');
      const frame = page.locator('.art-picture');
      if (scenario === 'nojs' || scenario === 'missing-module') {
        await expect
          .poll(() => image.evaluate((i) => i.complete && i.naturalWidth > 0), {
            timeout: 8000,
          })
          .toBe(true);
        assert.equal(await image.evaluate((i) => getComputedStyle(i).backgroundImage), 'none');
        assert.equal(thumbnails, 0);
      } else {
        await expect(page.locator('html')).toHaveAttribute('data-original-image-loading', 'ready');
        if (scenario === 'offscreen') {
          await page.waitForTimeout(150);
          assert.equal(thumbnails, 0);
          await frame.scrollIntoViewIfNeeded();
        }
        if (scenario === 'near') {
          await expect.poll(() => thumbnails).toBe(1);
          assert(await frame.evaluate((i) => i.getBoundingClientRect().top > innerHeight));
          assert.equal(await image.getAttribute('loading'), 'lazy');
          await frame.scrollIntoViewIfNeeded();
        }
        if (scenario === 'failed-placeholder') {
          await expect(image).not.toHaveAttribute('data-original-preview');
        } else {
          await expect(image).toHaveAttribute('data-original-preview', 'pending');
        }
        await expect.poll(() => thumbnails).toBe(1);
        assert(
          (await frame.evaluate((i) => getComputedStyle(i).backgroundImage)).includes('blob:') ===
            (scenario !== 'failed-placeholder'),
        );
        assert.equal(await image.getAttribute('src'), originalURL);
        assert.equal(await image.getAttribute('srcset'), null);
        assert.equal(
          await image.evaluate((i) => i.naturalWidth),
          0,
          'Original is genuinely still held',
        );
        release();
        await expect(image).toHaveAttribute('data-original-image-state', 'loaded');
        await expect(image).not.toHaveAttribute('data-original-preview');
        assert.equal(await image.evaluate((i) => getComputedStyle(i).backgroundImage), 'none');
        assert.equal(await frame.evaluate((i) => getComputedStyle(i).backgroundImage), 'none');
        if (scenario === 'changed-source') {
          await image.evaluate(
            (i) => (i.src = 'https://assets.ultraclipart.com/explicit-fixture/replacement.webp'),
          );
          await expect(image).toHaveAttribute('data-original-image-state', 'loading');
          await expect(image).not.toHaveAttribute('data-original-preview');
          assert.equal(
            await image.evaluate((i) => getComputedStyle(i).backgroundImage),
            'none',
            'Old thumbnail cannot represent a replacement source',
          );
          replacementRelease();
          await expect(image).toHaveAttribute('data-original-image-state', 'loaded');
        }
      }
      report.cases.push({ scenario, thumbnails, originalSourcePreserved: true, passed: true });
    } finally {
      release();
      replacementRelease();
      await context.close();
    }
  }
  report.status = 'PROGRESSIVE_LOADING_SOURCE_INVARIANTS_PASSED';
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  writeFileSync(
    resolve(out, 'loading-preview-report.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
}
console.log(JSON.stringify(report));
