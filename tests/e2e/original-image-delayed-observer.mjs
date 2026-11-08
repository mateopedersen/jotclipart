// Explicit held-network fixture; verifies viewport admission, not public CDN speed.
import { chromium, webkit, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import { originalImageSchedulingScript } from '../../src/lib/original-image-scheduling-inline.mjs';
const out = process.env.EVIDENCE_DIR ?? 'reports/original-image-delayed-observer';
mkdirSync(out, { recursive: true });
const bytes = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#286fc1' } })
  .webp({ lossless: true })
  .toBuffer();
const css = readFileSync('src/styles/original-image-loading.css', 'utf8');
const html =
  '<!doctype html><html><head><script>' +
  originalImageSchedulingScript +
  '</script><style>' +
  css +
  '.grid{display:grid;grid-template-columns:repeat(4,100px);gap:10px}.art-picture{width:100px;height:100px;display:block;position:relative}.art-picture img{width:100%;height:100%;object-fit:contain}</style></head><body><div class="grid">' +
  Array.from(
    { length: 80 },
    (_, i) =>
      '<a class="art-picture" href="/art/fixture-' +
      i +
      '/"><img width="100" height="100" loading="lazy" data-original-deferred="pending" alt="Explicit fixture ' +
      i +
      '" src="https://assets.ultraclipart.com/fixture/viewport-' +
      i +
      '.webp"></a>',
  ).join('') +
  '</div></body></html>';
const csp =
  "default-src 'none'; img-src https://assets.ultraclipart.com; style-src 'unsafe-inline'; script-src 'sha256-" +
  createHash('sha256').update(originalImageSchedulingScript).digest('base64') +
  "'";
const server = createServer((q, r) => {
  r.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': csp }).end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const rows = [];
try {
  for (const [engine, type] of Object.entries({ chromium, webkit })) {
    const browser = await type.launch(
      engine === 'chromium' && process.env.UC_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.UC_CHROMIUM_EXECUTABLE_PATH }
        : {},
    );
    const context = await browser.newContext({ viewport: { width: 440, height: 350 } }),
      page = await context.newPage(),
      requests = new Map(),
      failures = [],
      errors = [];
    let release,
      active = 0,
      peak = 0,
      row;
    const held = new Promise((r) => {
      release = r;
    });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('requestfailed', (r) => failures.push(r.url()));
    try {
      await context.addInitScript(() => {
        window.IntersectionObserver = class {
          constructor() {}
          observe() {}
          unobserve() {}
          disconnect() {}
          takeRecords() {
            return [];
          }
        };
      });
      await context.route('https://assets.ultraclipart.com/**', async (route) => {
        const index = Number(/viewport-(\d+)\.webp/.exec(route.request().url())[1]);
        requests.set(index, (requests.get(index) ?? 0) + 1);
        active++;
        peak = Math.max(peak, active);
        try {
          if (index < 6) await held;
          await route.fulfill({ status: 200, contentType: 'image/webp', body: bytes });
        } finally {
          active--;
        }
      });
      await page.goto('http://127.0.0.1:' + server.address().port, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.locator('html')).toHaveAttribute('data-original-scheduling', 'active');
      await page.evaluate(() => scrollTo(0, 700));
      const frames = await page
        .locator('.art-picture')
        .evaluateAll((xs) => xs.map((x) => ({ w: x.offsetWidth, h: x.offsetHeight })));
      const at = Date.now();
      await page.evaluate(() => scrollTo(0, 700));
      // Old healthy transfers stay held. Fresh viewport originals must start and finish now.
      await expect
        .poll(
          () =>
            page.locator('img').evaluateAll((xs) =>
              xs.some((i) => {
                const r = i.parentElement.getBoundingClientRect();
                return r.bottom > 0 && r.top < innerHeight && i.complete && i.naturalWidth > 0;
              }),
            ),
          { timeout: 1200 },
        )
        .toBe(true);
      const visibleReadyMs = Date.now() - at;
      assert(peak <= 8, 'Six ordinary slots plus two bounded visible reserve slots');
      for (let i = 0; i < 6; i++)
        if (requests.has(i)) assert.equal(requests.get(i), 1, 'Never restart a healthy original');
      assert.deepEqual(failures, []);
      assert.deepEqual(errors, []);
      const after = await page
        .locator('.art-picture')
        .evaluateAll((xs) => xs.map((x) => ({ w: x.offsetWidth, h: x.offsetHeight })));
      assert.deepEqual(after, frames);
      row = {
        passed: true,
        engine,
        visibleReadyMs,
        peak,
        heldOriginalsUnchanged: true,
        requests: Object.fromEntries(requests),
        errors: [...errors],
        failures: [...failures],
      };
    } catch (e) {
      row = {
        passed: false,
        engine,
        error: e.message,
        peak,
        requests: Object.fromEntries(requests),
        errors: [...errors],
        failures: [...failures],
      };
    } finally {
      release();
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
          'Controlled delayed IntersectionObserver callback model with actual scrolling; original URLs untouched; not a native browser defect claim or live-CDN timing',
        cases: rows,
      },
      null,
      2,
    ),
  );
}
assert(rows.length === 2 && rows.every((r) => r.passed));
