import { build } from 'esbuild';
import { chromium, webkit, expect } from '@playwright/test';
import sharp from 'sharp';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const out = process.env.EVIDENCE_DIR ?? 'reports/original-image-delayed-recovery';
mkdirSync(out, { recursive: true });
const bytes = await sharp({ create: { width: 20, height: 20, channels: 4, background: '#2464d4' } })
  .webp()
  .toBuffer();
const built = await build({
  stdin: {
    contents:
      "import{initOriginalImageLoading}from'./src/scripts/original-image-loading.ts';initOriginalImageLoading(document,{retryDelays:[20,40],stallMs:45000});",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  write: false,
});
const html =
  '<!doctype html><html><head><style>.art-picture{display:inline-block;width:80px;height:80px}img{width:100%;height:100%}</style></head><body>' +
  [0, 1, 2]
    .map(
      (i) =>
        '<a class="art-picture"><img width="80" height="80" alt="Explicit pressure fixture ' +
        i +
        '" fetchpriority="' +
        (i < 2 ? 'high' : 'low') +
        '" src="https://assets.ultraclipart.com/fixture/pressure-' +
        i +
        '.webp"></a>',
    )
    .join('') +
  '<script type="module" src="/module.js"></script></body></html>';
const server = createServer((q, r) =>
  r
    .writeHead(200, { 'content-type': q.url === '/module.js' ? 'text/javascript' : 'text/html' })
    .end(q.url === '/module.js' ? built.outputFiles[0].text : html),
);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const rows = [];
try {
  for (const [engine, type] of Object.entries({ chromium, webkit })) {
    const browser = await type.launch(
        engine === 'chromium' && process.env.UC_CHROMIUM_EXECUTABLE_PATH
          ? { executablePath: process.env.UC_CHROMIUM_EXECUTABLE_PATH }
          : {},
      ),
      context = await browser.newContext({ viewport: { width: 390, height: 500 } }),
      page = await context.newPage();
    let release, failTarget;
    const held = new Promise((r) => (release = r)),
      faultReady = new Promise((r) => (failTarget = r)),
      requests = [0, 0, 0],
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    let row;
    try {
      await context.addInitScript(() => {
        window.IntersectionObserver = class {
          constructor() {}
          observe() {}
          unobserve() {}
          disconnect() {}
        };
      });
      await context.route('https://assets.ultraclipart.com/**', async (route) => {
        const i = Number(/pressure-(\d)/.exec(route.request().url())[1]);
        requests[i]++;
        if (i < 2) await held;
        else if (requests[i] === 1) {
          await faultReady;
          await route.fulfill({ status: 503, body: 'Explicit first request failure' });
          return;
        }
        await route.fulfill({ status: 200, contentType: 'image/webp', body: bytes });
      });
      await page.goto('http://127.0.0.1:' + server.address().port, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.locator('html')).toHaveAttribute('data-original-image-loading', 'ready');
      await expect.poll(() => requests.reduce((a, b) => a + b, 0)).toBe(3);
      await page.waitForTimeout(150);
      failTarget();
      const start = Date.now();
      try {
        await expect
          .poll(
            () =>
              page
                .locator('img')
                .nth(2)
                .evaluate((i) => i.complete && i.naturalWidth > 0),
            { timeout: 1500 },
          )
          .toBe(true);
        row = { passed: true, engine, recoveredMs: Date.now() - start, requests: [...requests] };
      } catch (e) {
        row = {
          passed: false,
          engine,
          error: e.message,
          requests: [...requests],
          images: await page
            .locator('img')
            .evaluateAll((xs) =>
              xs.map((i) => ({
                complete: i.complete,
                width: i.naturalWidth,
                priority: i.fetchPriority,
                state: i.dataset.originalImageState,
                rect: i.getBoundingClientRect().toJSON(),
              })),
            ),
        };
      }
      assert.deepEqual(errors, []);
      row.errors = errors;
      row.document = await page.evaluate(() => ({
        hidden: document.hidden,
        visibilityState: document.visibilityState,
        focus: document.hasFocus(),
      }));
    } finally {
      release();
      failTarget();
      await page.waitForTimeout(100);
      await context.close();
      await browser.close();
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
} finally {
  await new Promise((r) => server.close(r));
  writeFileSync(
    out + '/report.json',
    JSON.stringify(
      {
        passed: rows.length === 2 && rows.every((r) => r.passed),
        scope:
          'Explicit delayed IntersectionObserver callback model and synthetic503; not a native browser defect claim or CDN speed',
        cases: rows,
      },
      null,
      2,
    ),
  );
}
assert(rows.every((r) => r.passed));
