// Synthetic pixels with the actual shared card CSS and scheduler/controller.
// This regression checks painted content boxes, not only outer frame rectangles.
import { build } from 'esbuild';
import sharp from 'sharp';
import { chromium, webkit, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { originalImageSchedulingScript } from '../../src/lib/original-image-scheduling-inline.mjs';
const out = process.env.EVIDENCE_DIR ?? 'reports/original-image-card-content-box';
mkdirSync(out, { recursive: true });
let cards = readFileSync('src/styles/card-media.css', 'utf8'),
  loading = readFileSync('src/styles/original-image-loading.css', 'utf8');
if (process.env.UC_BEFORE_FIX === '1') {
  const fixture = 'tests/fixtures/original-image-card-content-box/';
  const manifest = JSON.parse(readFileSync(fixture + 'before-manifest.json', 'utf8'));
  assert.equal(manifest.revision, '14a216ccf157c71be0ae022712612730f0adb76d');
  const frozen = (name) => {
    const bytes = readFileSync(fixture + name);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.files[name]);
    return bytes.toString('utf8');
  };
  cards = frozen('card-media-before.css');
  loading = frozen('original-image-loading-before.css');
}
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
const original = await sharp({
  create: { width: 320, height: 160, channels: 4, background: '#1c84d1' },
})
  .webp({ lossless: true })
  .toBuffer();
const thumbnail = await sharp(original).resize(80, 40).webp({ lossless: true }).toBuffer();
const globalCSS = readFileSync('src/styles/global.css', 'utf8').replace(/@import[^;]+;/g, '');
const subjectCSS = readFileSync('src/styles/home-subject-gallery.css', 'utf8');
const relatedCSS = readFileSync('src/styles/related.css', 'utf8');
const kinds = [
  ['art-card', 'art-picture'],
  ['hsg-subject', 'hsg-picture'],
  ['related-card', 'related-picture'],
  ['standalone', 'art-picture'],
];
const server = createServer((req, res) => {
  if (req.url === '/module.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' }).end(js);
    return;
  }
  const kind = Number(new URL(req.url, 'http://local').searchParams.get('kind') ?? 0),
    [card, picture] = kinds[kind];
  const src = 'https://assets.ultraclipart.com/fixture/original.webp';
  res
    .writeHead(200, { 'content-type': 'text/html' })
    .end(
      `<!doctype html><html><head><script>${originalImageSchedulingScript}</script><style>*{box-sizing:border-box}body{margin:20px}.fixture{width:min(320px,100%)}${cards}${globalCSS}${subjectCSS}${relatedCSS}${loading}</style></head><body><article class="fixture ${card}"><a class="${picture}" href=/art/fixture/><img width=320 height=160 loading=lazy alt="Synthetic blue rectangle" data-original-deferred=pending src="${src}" data-original-placeholder="https://assets.ultraclipart.com/fixture/thumbnail.webp" data-original-placeholder-for="${src}"></a></article><script type=module src=/module.js></script></body></html>`,
    );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port;
const engine = process.env.UC_BROWSER ?? 'chromium';
const browser = await { chromium, webkit }[engine].launch(
  engine === 'chromium' && process.env.UC_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.UC_CHROMIUM_EXECUTABLE_PATH }
    : {},
);
const report = {
  engine,
  testSHA256: createHash('sha256')
    .update(readFileSync(new URL(import.meta.url)))
    .digest('hex'),
  cardCSS_SHA256: createHash('sha256').update(cards).digest('hex'),
  loadingCSS_SHA256: createHash('sha256').update(loading).digest('hex'),
  beforeFix: process.env.UC_BEFORE_FIX === '1',
  cases: [],
};
const paintBounds = async (path) => {
  const { data, info } = await sharp(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let left = info.width,
    top = info.height,
    right = -1,
    bottom = -1;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 4;
      if (
        Math.abs(data[i] - 28) < 4 &&
        Math.abs(data[i + 1] - 132) < 4 &&
        Math.abs(data[i + 2] - 209) < 4 &&
        data[i + 3] > 250
      ) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  assert(right >= left && bottom >= top, 'Synthetic artwork must be painted');
  return { left, top, right, bottom };
};
const content = async (locator) =>
  locator.evaluate((el) => {
    const r = el.getBoundingClientRect(),
      s = getComputedStyle(el),
      n = (p) => parseFloat(p) || 0,
      sx = el.offsetWidth ? r.width / el.offsetWidth : 1,
      sy = el.offsetHeight ? r.height / el.offsetHeight : 1;
    return {
      x: r.x + sx * (n(s.borderLeftWidth) + n(s.paddingLeft)),
      y: r.y + sy * (n(s.borderTopWidth) + n(s.paddingTop)),
      width:
        r.width -
        sx * (n(s.borderLeftWidth) + n(s.borderRightWidth) + n(s.paddingLeft) + n(s.paddingRight)),
      height:
        r.height -
        sy * (n(s.borderTopWidth) + n(s.borderBottomWidth) + n(s.paddingTop) + n(s.paddingBottom)),
      backgroundOrigin: s.backgroundOrigin,
      backgroundClip: s.backgroundClip,
    };
  });
try {
  for (let round = 1; round <= 2; round++)
    for (const width of [390, 1440])
      for (let kind = 0; kind < kinds.length; kind++) {
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        let release;
        const gate = new Promise((r) => (release = r));
        const page = await context.newPage();
        const item = { round, width, kind: kinds[kind][0], status: 'running', errors: [] };
        report.cases.push(item);
        page.on('pageerror', (e) => item.errors.push(e.message));
        await page.route('https://assets.ultraclipart.com/fixture/**', async (route) => {
          if (route.request().url().includes('thumbnail'))
            return route.fulfill({ contentType: 'image/webp', body: thumbnail });
          await gate;
          return route.fulfill({ contentType: 'image/webp', body: original });
        });
        try {
          await page.goto(origin + '/?kind=' + kind, { waitUntil: 'domcontentloaded' });
          const frame = page.locator('.fixture>a'),
            image = frame.locator('img'),
            backdrop = frame.locator('.original-image-loading-backdrop');
          await expect(backdrop).toHaveCount(1);
          await page.setViewportSize({ width: width === 390 ? 1440 : 390, height: 900 });
          await expect(backdrop).toHaveCount(1);
          item.resizedPending = await content(backdrop);
          await page.setViewportSize({ width, height: 900 });
          if (kind < 3) {
            await page
              .locator('.fixture')
              .evaluate((el) => el.style.setProperty('--card-media-padding', '21px'));
            await expect(backdrop).toHaveCSS('padding-left', '21px');
            await page
              .locator('.fixture')
              .evaluate((el) => el.style.removeProperty('--card-media-padding'));
            await expect(backdrop).toHaveCSS(
              'padding-left',
              kind === 0 ? '9px' : width === 390 ? (kind === 1 ? '12px' : '10px') : '16px',
            );
            await frame.evaluate((el) => {
              const parent = el.parentElement,
                next = document.createElement('article');
              next.className = parent.className;
              next.style.setProperty('--card-media-padding', '23px');
              parent.after(next);
              next.append(el);
              parent.remove();
            });
            await expect(backdrop).toHaveCount(1);
            await expect(backdrop).toHaveCSS('padding-left', '23px');
            item.reparentedPending = true;
          }
          await frame.hover();
          if (kind === 0 || kind === 3)
            await expect(backdrop).toHaveCSS('transform', 'matrix(1.035, 0, 0, 1.035, 0, 0)');
          await backdrop.evaluate(async (el) => {
            const src = getComputedStyle(el).backgroundImage.slice(5, -2);
            const preview = new Image();
            preview.src = src;
            await preview.decode();
          });
          item.pending = await content(backdrop);
          item.frameBefore = await frame.boundingBox();
          await frame.screenshot({ path: `${out}/${round}-${width}-${kind}-pending.png` });
          release();
          await expect(backdrop).toHaveCount(0);
          await expect(image).toBeVisible();
          if (kind === 0 || kind === 3)
            await expect(image).toHaveCSS('transform', 'matrix(1.035, 0, 0, 1.035, 0, 0)');
          await expect
            .poll(() => image.evaluate((i) => i.complete && i.naturalWidth === 320))
            .toBe(true);
          item.loaded = await content(image);
          item.frameAfter = await frame.boundingBox();
          for (const key of ['x', 'y', 'width', 'height'])
            assert(
              Math.abs(item.pending[key] - item.loaded[key]) < 0.1,
              'Preview/original content mismatch ' + key,
            );
          assert.deepEqual(item.frameAfter, item.frameBefore);
          if (kind < 3) {
            assert.equal(item.pending.backgroundOrigin, 'content-box');
            assert.equal(item.pending.backgroundClip, 'content-box');
          }
          await frame.screenshot({ path: `${out}/${round}-${width}-${kind}-loaded.png` });
          item.pendingPaint = await paintBounds(`${out}/${round}-${width}-${kind}-pending.png`);
          item.loadedPaint = await paintBounds(`${out}/${round}-${width}-${kind}-loaded.png`);
          for (const key of ['left', 'top', 'right', 'bottom'])
            assert(
              Math.abs(item.pendingPaint[key] - item.loadedPaint[key]) <= 1,
              'Painted artwork boundary mismatch ' + key,
            );
          assert.deepEqual(item.errors, []);
          item.status = 'PASS';
        } catch (error) {
          item.status = 'FAIL';
          item.error = String(error);
        } finally {
          release();
          await context.close();
          writeFileSync(out + '/report.json', JSON.stringify(report, null, 2));
        }
      }
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
console.log(
  JSON.stringify({
    engine,
    beforeFix: report.beforeFix,
    passed: report.cases.filter((x) => x.status === 'PASS').length,
    failed: report.cases.filter((x) => x.status === 'FAIL').length,
    out,
  }),
);
if (report.cases.some((x) => x.status !== 'PASS')) process.exitCode = 1;
