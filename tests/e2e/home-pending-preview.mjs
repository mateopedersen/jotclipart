// Real home frame CSS and loader, with explicit held originals and synthetic media.
import { build } from 'esbuild';
import sharp from 'sharp';
import { chromium, webkit, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { originalImageSchedulingScript } from '../../src/lib/original-image-scheduling-inline.mjs';
const out = process.env.EVIDENCE_DIR || 'reports/home-pending-preview';
mkdirSync(out, { recursive: true });
const media = await sharp({
  create: { width: 100, height: 100, channels: 4, background: '#e2b344' },
})
  .webp()
  .toBuffer();
const js = (
  await build({
    stdin: {
      contents:
        "import{initOriginalImageLoading}from'./src/scripts/original-image-loading.ts';initOriginalImageLoading();",
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: 'esm',
    write: false,
  })
).outputFiles[0].contents;
const css = ['global', 'home-showcase', 'original-image-loading']
  .map((n) => readFileSync('src/styles/' + n + '.css', 'utf8'))
  .join('\n');
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><script>${originalImageSchedulingScript}</script><style>${css}.fixture{display:grid;grid-template-columns:repeat(3,100px);gap:8px}.fixture .home-sample-picture{width:100px;height:100px;flex:none}</style></head><body><div class=fixture>${Array.from({ length: 7 }, (_, i) => `<span class="home-sample-picture"><img width=100 height=100 loading=lazy data-original-deferred=pending alt="Controlled home fixture ${i}" src="https://assets.jotclipart.com/fixture/original-${i}.webp" data-original-placeholder="https://assets.jotclipart.com/fixture/preview-${i}.webp" data-original-placeholder-for="https://assets.jotclipart.com/fixture/original-${i}.webp"></span>`).join('')}</div><script type=module src=/module.js></script></body></html>`;
const server = createServer((req, res) =>
  res
    .writeHead(200, { 'content-type': req.url === '/module.js' ? 'text/javascript' : 'text/html' })
    .end(req.url === '/module.js' ? js : html),
);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const rows = [];
try {
  for (const [engine, type] of Object.entries({ chromium, webkit })) {
    const browser = await type.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 700 } });
      let release;
      const held = new Promise((r) => (release = r)),
        requests = [],
        errors = [];
      await context.route('https://assets.jotclipart.com/fixture/**', async (route) => {
        const url = route.request().url();
        requests.push(url);
        if (url.includes('/original-')) await held;
        await route.fulfill({ contentType: 'image/webp', body: media }).catch(() => {});
      });
      try {
        const page = await context.newPage();
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto('http://127.0.0.1:' + server.address().port, {
          waitUntil: 'domcontentloaded',
        });
        await expect(
          page.locator('.home-sample-picture > .original-image-loading-backdrop'),
        ).toHaveCount(7);
        await expect.poll(() => requests.filter((x) => x.includes('/preview-')).length).toBe(7);
        const pending = await page.locator('img[data-original-deferred=pending]').count();
        assert(pending > 0, 'Queued home originals must already have visible previews');
        assert(
          requests.filter((x) => x.includes('/original-')).length <= 4,
          'Original admission cap remains intact',
        );
        const before = await page
          .locator('.home-sample-picture')
          .evaluateAll((ns) => ns.map((n) => n.getBoundingClientRect().toJSON()));
        const sources = await page.locator('img').evaluateAll((ns) => ns.map((n) => n.src));
        await page.screenshot({ path: out + '/' + engine + '-pending.png' });
        release();
        await expect
          .poll(() =>
            page
              .locator('img')
              .evaluateAll((ns) => ns.every((n) => n.complete && n.naturalWidth === 100)),
          )
          .toBe(true);
        await expect(page.locator('.original-image-loading-backdrop')).toHaveCount(0);
        assert.deepEqual(
          await page.locator('img').evaluateAll((ns) => ns.map((n) => n.src)),
          sources,
        );
        assert.deepEqual(
          await page
            .locator('.home-sample-picture')
            .evaluateAll((ns) => ns.map((n) => n.getBoundingClientRect().toJSON())),
          before,
        );
        assert.deepEqual(errors, []);
        rows.push({
          engine,
          previewsBeforeOriginalRelease: 7,
          pendingOriginals: pending,
          originalURLsPreserved: true,
          geometryPreserved: true,
          errors,
        });
      } finally {
        release();
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((r) => server.close(r));
  writeFileSync(out + '/report.json', JSON.stringify(rows, null, 2));
}
console.log(JSON.stringify({ status: 'PASS', cases: rows.length, rows }));
