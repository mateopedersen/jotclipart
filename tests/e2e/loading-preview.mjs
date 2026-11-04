// Explicitly synthetic media and fault injection; real cover/CDN proof is separate.
import { build } from 'esbuild';
import sharp from 'sharp';
import { createServer } from 'node:http';
import { chromium, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
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
    pending = req.url === '/nojs';
  res.setHeader('Content-Type', 'text/html');
  res.end(
    `<!doctype html><html><head><style>${css}</style><noscript><style>img[data-original-preview]{background-image:none!important}</style></noscript></head><body><div style="height:${offscreen ? 5000 : 0}px"></div><a class="art-picture" href="/art/fixture/"><img width="180" height="180" alt="Explicit synthetic fixture" src="${originalURL}" loading="lazy" data-original-placeholder="${thumbURL}" data-original-placeholder-for="${originalURL}" ${pending ? `data-original-preview="pending" style='--original-loading-preview:url("${thumbURL}")'` : ''}></a><script type="module" src="/loader.js"></script></body></html>`,
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
  executablePath:
    process.env.UC_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const report = {
  scope:
    'Synthetic network gates verify progressive CSS display, original-source invariants, stale binding, offscreen behavior and JavaScript-disabled fallback; not a live CDN measurement.',
  status: 'RUNNING',
  cases: [],
};
try {
  for (const scenario of [
    'gated-original',
    'failed-placeholder',
    'changed-source',
    'offscreen',
    'nojs',
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
            contentType: 'image/webp',
            body: blue,
          });
        }
        if (scenario !== 'nojs')
          await (route.request().url().includes('replacement') ? replacement : gate);
        try {
          await route.fulfill({ status: 200, contentType: 'image/webp', body: red });
        } catch {
          /* A source change may cancel the deliberately held old request. */
        }
      });
      await page.goto(
        'http://127.0.0.1:' +
          server.address().port +
          '/' +
          (scenario === 'offscreen' ? 'offscreen' : scenario === 'nojs' ? 'nojs' : ''),
        { waitUntil: 'domcontentloaded' },
      );
      const image = page.locator('.art-picture img');
      if (scenario === 'nojs') {
        await expect.poll(() => image.evaluate((i) => i.complete && i.naturalWidth > 0)).toBe(true);
        assert.equal(await image.evaluate((i) => getComputedStyle(i).backgroundImage), 'none');
        assert.equal(thumbnails, 0);
      } else {
        await expect(page.locator('html')).toHaveAttribute('data-original-image-loading', 'ready');
        if (scenario === 'offscreen') {
          await page.waitForTimeout(150);
          assert.equal(thumbnails, 0);
          await image.scrollIntoViewIfNeeded();
        }
        await expect(image).toHaveAttribute('data-original-preview', 'pending');
        await expect.poll(() => thumbnails).toBe(1);
        assert(
          (await image.evaluate((i) => getComputedStyle(i).backgroundImage)).includes(thumbURL),
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
