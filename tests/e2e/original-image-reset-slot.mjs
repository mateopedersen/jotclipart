import { build } from 'esbuild';
import { chromium, webkit, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import { originalImageSchedulingScript } from '../../src/lib/original-image-scheduling-inline.mjs';
const out = process.env.EVIDENCE_DIR ?? 'reports/original-image-reset-slot';
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
let critical = originalImageSchedulingScript;
const css = readFileSync('src/styles/original-image-loading.css', 'utf8');
const html =
  '<!doctype html><html><head><script>' +
  critical +
  '</script><style>' +
  css +
  '.grid{display:grid;grid-template-columns:repeat(4,100px);gap:10px}.art-picture{display:block;width:100px;height:100px}img{width:100%;height:100%}</style></head><body><div class="grid">' +
  Array.from(
    { length: 40 },
    (_, i) =>
      '<a class="art-picture"><img width="100" height="100" loading="lazy" data-original-deferred="pending" alt="Explicit reset fixture ' +
      i +
      '" src="https://assets.ultraclipart.com/fixture/reset-' +
      i +
      '.webp"></a>',
  ).join('') +
  '</div><script type="module" src="/module.js"></script></body></html>';
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
      context = await browser.newContext({ viewport: { width: 440, height: 350 } }),
      page = await context.newPage(),
      requests = new Map(),
      errors = [];
    let release,
      failTarget,
      active = 0,
      peak = 0,
      row;
    const held = new Promise((r) => (release = r)),
      faultReady = new Promise((r) => (failTarget = r));
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await context.addInitScript(() => {
        window.__resetRefreshRaces = 0;
        const remove = Element.prototype.removeAttribute;
        Element.prototype.removeAttribute = function (name) {
          const r = remove.call(this, name);
          if (
            this instanceof HTMLImageElement &&
            name === 'src' &&
            this.dataset.originalRetryReset === 'true'
          ) {
            window.__resetRefreshRaces++;
            dispatchEvent(new Event('scroll'));
          }
          return r;
        };
      });
      await context.route('https://assets.ultraclipart.com/**', async (route) => {
        const index = Number(/reset-(\d+)/.exec(route.request().url())[1]),
          n = (requests.get(index) ?? 0) + 1;
        requests.set(index, n);
        active++;
        peak = Math.max(peak, active);
        try {
          if (index === 0 && n === 1) {
            await faultReady;
            await route.fulfill({ status: 503, body: 'Explicit controlled failure' });
          } else {
            await held;
            await route.fulfill({ status: 200, contentType: 'image/webp', body: bytes });
          }
        } finally {
          active--;
        }
      });
      await page.goto('http://127.0.0.1:' + server.address().port, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.locator('html')).toHaveAttribute('data-original-image-loading', 'ready');
      await expect.poll(() => requests.size).toBe(6);
      failTarget();
      await expect.poll(() => requests.get(0)).toBe(2);
      await page.waitForTimeout(180);
      assert.equal(
        requests.size,
        6,
        'Retry reset must retain its original critical admission slot',
      );
      assert(peak <= 6, 'The temporary src reset must not start a seventh transfer');
      assert.equal(await page.evaluate(() => window.__resetRefreshRaces), 1);
      assert.deepEqual(errors, []);
      row = {
        passed: true,
        engine,
        peak,
        requests: Object.fromEntries(requests),
        resetRefreshRaces: 1,
        errors,
      };
    } catch (e) {
      row = {
        passed: false,
        engine,
        error: e.message,
        peak,
        requests: Object.fromEntries(requests),
        errors,
      };
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
        passed: rows.length === 2 && rows.every((x) => x.passed),
        scope:
          'Exact critical script plus recovery module; forced rAF ordering during retry reset; synthetic media, no live speed claim',
        cases: rows,
      },
      null,
      2,
    ),
  );
}
assert(rows.every((x) => x.passed));
