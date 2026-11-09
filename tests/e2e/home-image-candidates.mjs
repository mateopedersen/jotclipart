// Explicit synthetic R2 failures, never represented as a real media/readback proof.
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const sharp = createRequire(import.meta.resolve('astro/package.json'))('sharp'),
  small = await sharp({ create: { width: 40, height: 40, channels: 4, background: '#0099ff' } })
    .webp()
    .toBuffer(),
  large = await sharp({ create: { width: 80, height: 80, channels: 4, background: '#0099ff' } })
    .webp()
    .toBuffer();
const code = (
  await build({
    stdin: {
      resolveDir: resolve('.'),
      contents:
        "import{initOriginalImageLoading}from'./src/scripts/original-image-loading.ts';initOriginalImageLoading(document,{retryDelays:[20,40],stallMs:800});",
    },
    bundle: true,
    format: 'esm',
    write: false,
  })
).outputFiles[0].text;
const html =
  '<!doctype html><html><body><div style="width:100px;height:100px"><img data-home-responsive="true" src="https://assets.ultraclipart.com/fixture/full.webp" srcset="https://assets.ultraclipart.com/fixture/small.webp 1x, https://assets.ultraclipart.com/fixture/full.webp 2x" width="100" height="100" alt="Test fixture"></div><script type="module" src="/test.js"></script></body></html>';
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/test.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/test.js' ? code : html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const output = resolve(process.env.EVIDENCE_DIR || 'reports/home-image-candidates');
mkdirSync(output, { recursive: true });
const report = {
  passed: false,
  scope: 'Synthetic source-component density and error regression; not public R2',
  cases: [],
};
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
try {
  for (const scale of [1, 2])
    for (const failure of [false, true]) {
      const c = await browser.newContext({
          viewport: { width: 1440, height: 900 },
          deviceScaleFactor: scale,
        }),
        p = await c.newPage(),
        requests = [],
        errors = [];
      p.on('pageerror', (e) => errors.push(e.message));
      await c.route('https://assets.ultraclipart.com/**', async (route) => {
        const url = route.request().url();
        requests.push(url);
        const thumb = url.endsWith('small.webp');
        await route.fulfill({
          status: failure && thumb ? 503 : 200,
          contentType: failure && thumb ? 'text/plain' : 'image/webp',
          body: failure && thumb ? 'Explicit missing image fixture' : thumb ? small : large,
        });
      });
      await p.goto('http://127.0.0.1:' + server.address().port);
      await expect
        .poll(() => p.locator('img').evaluate((i) => i.complete && i.naturalWidth > 0))
        .toBe(true);
      const state = await p
        .locator('img')
        .evaluate((i) => ({
          src: i.src,
          currentSrc: i.currentSrc,
          srcset: i.getAttribute('srcset'),
          width: i.width,
          height: i.height,
          natural: i.naturalWidth,
          mode: i.dataset.homeResponsive,
        }));
      assert.equal(state.src, 'https://assets.ultraclipart.com/fixture/full.webp');
      assert.equal(state.width, 100);
      assert.equal(state.height, 100);
      console.log(JSON.stringify({ scale, failure, state, requests }));
      assert(state.currentSrc.endsWith(scale === 1 && !failure ? 'small.webp' : 'full.webp'));
      if (scale === 1 && failure) {
        assert.equal(state.mode, 'fallback');
        assert.equal(state.srcset, null);
      }
      assert.deepEqual(errors, []);
      report.cases.push({ scale, failure, state, requests, errors, passed: true });
      await c.close();
    }
  report.passed = true;
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  writeFileSync(output + '/report.json', JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
