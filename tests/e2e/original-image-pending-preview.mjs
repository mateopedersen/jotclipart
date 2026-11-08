// Real browser pixels with explicit synthetic originals/thumbnails. Not a CDN speed test.
import { build } from 'esbuild';
import sharp from 'sharp';
import { chromium, webkit, firefox, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { originalImageSchedulingScript } from '../../src/lib/original-image-scheduling-inline.mjs';
const out = process.env.EVIDENCE_DIR ?? 'reports/original-image-pending-preview';
mkdirSync(out, { recursive: true });
const colors = { blue: '#1c84d1', red: '#d13b31' };
const media = {};
for (const [k, color] of Object.entries(colors))
  media[k] = await sharp({ create: { width: 320, height: 160, channels: 4, background: color } })
    .webp({ lossless: true })
    .toBuffer();
const js = (
  await build({
    stdin: {
      contents:
        "import{initOriginalImageLoading}from'./src/scripts/original-image-loading.ts';initOriginalImageLoading(document,{retryDelays:[20,40],stallMs:45000});",
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: 'esm',
    write: false,
  })
).outputFiles[0].contents;
const css = readFileSync('src/styles/original-image-loading.css', 'utf8'),
  globalCSS = readFileSync('src/styles/global.css', 'utf8');
const card = (i) =>
  `<a class="art-picture" href="/art/fixture-${i}/"><img width=320 height=160 alt="Explicit controlled media ${i}" loading=lazy data-original-deferred=pending src="https://assets.ultraclipart.com/fixture/original-${i}.webp" data-original-placeholder="https://assets.ultraclipart.com/fixture/blue-thumbnail.webp" data-original-placeholder-for="https://assets.ultraclipart.com/fixture/original-${i}.webp"></a>`;
const html = `<!doctype html><html><head><script>${originalImageSchedulingScript}</script><style>${globalCSS}${css}.grid{display:grid;grid-template-columns:repeat(4,100px);gap:10px}.grid .art-picture{width:100px;height:100px;aspect-ratio:1;background:white}</style></head><body><div class=grid>${Array.from({ length: 12 }, (_, i) => card(i)).join('')}</div><script type=module src=/module.js></script></body></html>`;
const server = createServer((req, res) => {
  if (req.url !== '/module.js' && req.url !== '/') {
    res.writeHead(404);
    res.end();
    return;
  }
  res
    .writeHead(200, { 'content-type': req.url === '/module.js' ? 'text/javascript' : 'text/html' })
    .end(req.url === '/module.js' ? js : html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const rows = [];
const engines = process.env.UC_BROWSER
  ? { [process.env.UC_BROWSER]: { chromium, webkit, firefox }[process.env.UC_BROWSER] }
  : { chromium, webkit };
try {
  for (const [engine, type] of Object.entries(engines)) {
    const browser = await type.launch(
      engine === 'chromium' && process.env.UC_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.UC_CHROMIUM_EXECUTABLE_PATH }
        : {},
    );
    try {
      for (const scenario of [
        'pending-first-paint',
        'source-invalidation',
        'invalid-thumbnail',
        'terminal-error',
        'dynamic-removal',
        'same-node-reparent',
        'frame-eligibility',
      ]) {
        const context = await browser.newContext({ viewport: { width: 440, height: 600 } });
        let release;
        const held = new Promise((r) => (release = r)),
          requests = [],
          errors = [];
        let failureURL = '';
        await context.route('https://assets.ultraclipart.com/fixture/**', async (route) => {
          const url = route.request().url();
          requests.push(url);
          if (!url.includes('thumbnail')) await held;
          if (url === failureURL) {
            await route
              .fulfill({ status: 503, body: 'Explicit terminal failure fixture' })
              .catch(() => {});
            return;
          }
          await route
            .fulfill({
              status: 200,
              contentType: 'image/webp',
              body: media[url.includes('red') ? 'red' : 'blue'],
            })
            .catch(() => {});
        });
        try {
          const page = await context.newPage();
          page.on('pageerror', (e) => errors.push(e.message));
          await page.goto('http://127.0.0.1:' + server.address().port, {
            waitUntil: 'domcontentloaded',
          });
          await page.waitForFunction(
            () => document.documentElement.dataset.originalImageLoading === 'ready',
          );
          await page.waitForTimeout(300);
          await page
            .locator('img[data-original-deferred=pending]')
            .first()
            .evaluate((i) => (i.dataset.previewTestTarget = 'target'));
          const target = page.locator('img[data-preview-test-target=target]'),
            frame = target.locator('..');
          const original = await target.getAttribute('src'),
            initial = await target.evaluate((i) => ({
              src: i.src,
              complete: i.complete,
              naturalWidth: i.naturalWidth,
              rect: i.parentElement.getBoundingClientRect().toJSON(),
              background: i.parentElement.style.background,
              link: i.parentElement.getAttribute('href'),
            }));
          await expect(frame.locator('.original-image-loading-backdrop')).toHaveCount(1);
          await page.waitForFunction(() =>
            performance
              .getEntriesByType('resource')
              .some((x) => x.name.endsWith('/blue-thumbnail.webp')),
          );
          await page.waitForTimeout(80);
          assert.equal(await target.evaluate((i) => getComputedStyle(i).display), 'none');
          assert.equal(initial.complete, false);
          assert(
            requests.filter((x) => !x.includes('thumbnail')).length <= 8,
            'Original admission budget must remain bounded',
          );
          const backdropBefore = await frame
            .locator('.original-image-loading-backdrop')
            .boundingBox();
          if (scenario === 'pending-first-paint') {
            const before = await frame.screenshot({ path: out + '/' + engine + '-pending.png' });
            const center = await sharp(before)
              .extract({ left: 50, top: 50, width: 1, height: 1 })
              .removeAlpha()
              .raw()
              .toBuffer();
            assert.deepEqual([...center], [28, 132, 209]);
            await frame.evaluate((f) => (f.style.padding = '15px'));
            await page.setViewportSize({ width: 441, height: 600 });
            await expect(frame.locator('.original-image-loading-backdrop')).toHaveCSS(
              'left',
              '15px',
            );
            await frame.evaluate((f) => (f.style.padding = '9px'));
            await page.setViewportSize({ width: 440, height: 600 });
            await expect(frame.locator('.original-image-loading-backdrop')).toHaveCSS(
              'left',
              '9px',
            );
            release();
            await page.waitForFunction(() =>
              [...document.images].every((i) => i.complete && i.naturalWidth > 0),
            );
            await expect(page.locator('.original-image-loading-backdrop')).toHaveCount(0);
            assert.equal(await target.getAttribute('src'), original);
            const after = await target.boundingBox();
            for (const k of ['x', 'y', 'width', 'height'])
              assert(
                Math.abs(after[k] - backdropBefore[k]) <= 1,
                'Preview and original content boxes must match: ' + k,
              );
            const loaded = await frame.screenshot({ path: out + '/' + engine + '-loaded.png' });
            const centerAfter = await sharp(loaded)
              .extract({ left: 50, top: 50, width: 1, height: 1 })
              .removeAlpha()
              .raw()
              .toBuffer();
            assert.deepEqual([...centerAfter], [28, 132, 209]);
          }
          if (scenario === 'source-invalidation') {
            const replacement = 'https://assets.ultraclipart.com/fixture/red-replacement.webp';
            await target.evaluate((i, url) => {
              i.src = url;
            }, replacement);
            await expect(frame.locator('.original-image-loading-backdrop')).toHaveCount(0);
            await target.evaluate((i, url) => {
              i.dataset.originalPlaceholder =
                'https://assets.ultraclipart.com/fixture/red-thumbnail.webp';
              i.dataset.originalPlaceholderFor = url;
            }, replacement);
            await expect(frame.locator('.original-image-loading-backdrop')).toHaveCount(1);
            await expect(frame.locator('.original-image-loading-backdrop')).toHaveCSS(
              'background-image',
              /red-thumbnail/,
            );
            assert.equal(await target.getAttribute('src'), replacement);
            assert.equal(await target.evaluate((i) => i.complete), false);
          }
          if (scenario === 'invalid-thumbnail') {
            await target.evaluate(
              (i) => (i.dataset.originalPlaceholder = 'https://untrusted.invalid/thumbnail.webp'),
            );
            await expect(frame.locator('.original-image-loading-backdrop')).toHaveCount(0);
            assert.equal(await target.getAttribute('src'), original);
            assert(!requests.some((x) => x.includes('untrusted.invalid')));
          }
          if (scenario === 'terminal-error') {
            failureURL = original;
            release();
            await expect(target).toHaveAttribute('data-original-image-state', 'error');
            await expect(frame.locator('.original-image-status')).toContainText(
              'Image unavailable',
              { timeout: 10000 },
            );
            await expect(frame.locator('.original-image-loading-backdrop')).toHaveCount(0);
            assert.equal(requests.filter((x) => x === original).length, 3);
            assert.equal(await target.getAttribute('src'), original);
          }
          if (scenario === 'dynamic-removal') {
            await page
              .locator('.grid')
              .evaluate((g, markup) => g.insertAdjacentHTML('beforeend', markup), card(20));
            const added = page.locator('.art-picture').last();
            await expect(added.locator('.original-image-loading-backdrop')).toHaveCount(1);
            const handle = await added.elementHandle();
            await added.evaluate((f) => f.remove());
            await page.waitForTimeout(80);
            assert.equal(await handle.evaluate((f) => f.isConnected), false);
            assert.equal(
              await handle.evaluate(
                (f) => f.querySelectorAll('.original-image-loading-backdrop').length,
              ),
              0,
            );
          }
          if (scenario === 'same-node-reparent') {
            const oldFrame = await frame.elementHandle(),
              beforeRequests = requests.filter((x) => !x.includes('thumbnail')).length;
            await target.evaluate((i) => {
              const next = document.createElement('a');
              next.className = 'art-picture';
              next.href = '/art/reparent-fixture/';
              i.parentElement.after(next);
              next.append(i);
            });
            await expect(frame.locator('.original-image-loading-backdrop')).toHaveCount(1);
            await expect
              .poll(() =>
                oldFrame.evaluate(
                  (f) => f.querySelectorAll('.original-image-loading-backdrop').length,
                ),
              )
              .toBe(0);
            assert.equal(await target.getAttribute('src'), original);
            assert.equal(
              requests.filter((x) => !x.includes('thumbnail')).length,
              beforeRequests,
              'Moving the same image must not restart healthy originals',
            );
          }
          if (scenario === 'frame-eligibility') {
            await frame.evaluate((f) => {
              const caption = document.createElement('span');
              caption.className = 'fixture-caption';
              caption.textContent = 'Keep this readable';
              f.append(caption);
            });
            await expect(frame.locator('.original-image-loading-backdrop')).toHaveCount(0);
            await expect(frame.locator('.fixture-caption')).toHaveText('Keep this readable');
            await frame.locator('.fixture-caption').evaluate((e) => e.remove());
            await expect(frame.locator('.original-image-loading-backdrop')).toHaveCount(1);
          }
          const final = await frame.evaluate((f) => ({
            rect: f.getBoundingClientRect().toJSON(),
            background: f.style.background,
            link: f.getAttribute('href'),
          }));
          if (scenario !== 'same-node-reparent') assert.deepEqual(final.rect, initial.rect);
          assert.equal(final.background, initial.background);
          assert.equal(
            final.link,
            scenario === 'same-node-reparent' ? '/art/reparent-fixture/' : initial.link,
          );
          assert.deepEqual(errors, []);
          rows.push({
            passed: true,
            engine,
            scenario,
            original,
            originalRequests: requests.filter((x) => !x.includes('thumbnail')).length,
            errors,
          });
          console.log(JSON.stringify(rows.at(-1)));
        } finally {
          release();
          await context.unrouteAll({ behavior: 'wait' });
          await context.close();
          writeFileSync(
            out + '/report.json',
            JSON.stringify(
              {
                passed: rows.length > 0 && rows.every((x) => x.passed),
                scope:
                  'Explicit synthetic media, held original responses and20/40ms test retry delays; actual component CSS, native browser pixels and stable content-box geometry. Not a live R2 or CDN-speed proof.',
                sourceCSSSHA256: createHash('sha256').update(css).digest('hex'),
                cases: rows,
              },
              null,
              2,
            ),
          );
        }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  server.close();
}
assert.equal(rows.length, Object.keys(engines).length * 7);
