import { chromium, webkit, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import { originalImageSchedulingScript } from '../../src/lib/original-image-scheduling-inline.mjs';
const out = process.env.EVIDENCE_DIR ?? 'reports/original-image-clipped-frame';
mkdirSync(out, { recursive: true });
const bytes = await sharp({ create: { width: 20, height: 20, channels: 4, background: '#2564d3' } })
  .webp()
  .toBuffer();
const img = (i) =>
  '<img width="100" height="100" loading="lazy" data-original-deferred="pending" alt="Explicit clipped fixture ' +
  i +
  '" src="https://assets.ultraclipart.com/fixture/clipped-' +
  i +
  '.webp">';
const css = readFileSync('src/styles/original-image-loading.css', 'utf8');
const html =
  '<!doctype html><html><head><script>' +
  originalImageSchedulingScript +
  '</script><style>' +
  css +
  '.art-picture{display:block;width:100px;height:100px}img{width:100%;height:100%}.mask{width:100px;height:100px;overflow:hidden;margin-top:10px}.horizontal{position:relative;left:220px}.vertical{position:relative;top:130px}</style></head><body><a class="art-picture">' +
  img(0) +
  '</a><div class="mask"><a class="art-picture horizontal">' +
  img(1) +
  '</a></div><div class="mask"><a class="art-picture vertical">' +
  img(2) +
  '</a></div></body></html>';
const server = createServer((q, r) => r.writeHead(200, { 'content-type': 'text/html' }).end(html));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const rows = [];
try {
  for (const [engine, type] of Object.entries({ chromium, webkit })) {
    const browser = await type.launch(
        engine === 'chromium' && process.env.UC_CHROMIUM_EXECUTABLE_PATH
          ? { executablePath: process.env.UC_CHROMIUM_EXECUTABLE_PATH }
          : {},
      ),
      context = await browser.newContext({ viewport: { width: 440, height: 700 } }),
      page = await context.newPage(),
      requests = [0, 0, 0];
    let row;
    try {
      await context.route('https://assets.ultraclipart.com/**', async (route) => {
        requests[Number(/clipped-(\d)/.exec(route.request().url())[1])]++;
        await route.fulfill({ status: 200, contentType: 'image/webp', body: bytes });
      });
      await page.goto('http://127.0.0.1:' + server.address().port, {
        waitUntil: 'domcontentloaded',
      });
      await expect.poll(() => requests[0]).toBe(1);
      await page.evaluate(() => dispatchEvent(new Event('scroll')));
      await page.waitForTimeout(3000);
      assert.equal(
        await page.locator('html').getAttribute('data-original-scheduling'),
        'active',
        'Clipped pending frames must not trigger watchdog fallback',
      );
      assert.equal(
        requests[1],
        0,
        'Horizontally clipped frame must not become visible or speculative',
      );
      assert.equal(
        requests[2],
        0,
        'Vertically clipped frame must not become visible or speculative',
      );
      row = { passed: true, engine, requests: [...requests] };
    } catch (e) {
      row = { passed: false, engine, error: e.message, requests: [...requests] };
    } finally {
      rows.push(row);
      console.log(JSON.stringify(row));
      await context.close();
      await browser.close();
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
          'Actual native observer and ancestor-overflow-clipping fixture; synthetic media, not CDN timing',
        cases: rows,
      },
      null,
      2,
    ),
  );
}
assert(rows.every((x) => x.passed));
