import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const origin = new URL(process.env.BASE_URL || 'http://127.0.0.1:4326').origin;
const artwork = process.env.UC_EDIT_ID || 'airbus-aircraft-20261105-001';
const editPath = '/edit/' + artwork + '/';
const browser = await chromium.launch({
  executablePath: process.env.UC_CHROME_EXECUTABLE || undefined,
});

try {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      hasTouch: width === 390,
      deviceScaleFactor: width === 390 ? 3 : 1,
    });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
      const thumbnail = page.locator('.home-sample-flowers img');
      await thumbnail.scrollIntoViewIfNeeded();
      await page.waitForFunction(() => {
        const image = document.querySelector('.home-sample-flowers img');
        return image?.complete && image.naturalWidth;
      });
      const showcase = await thumbnail.evaluate((image) => ({
        original: image.getAttribute('src'),
        selected: image.currentSrc,
      }));
      if (showcase.original.startsWith('https://assets.ultraclipart.com/')) {
        assert.match(showcase.selected, /\.thumbnail\.[a-f0-9]+\.webp$/);
        assert.notEqual(showcase.selected, showcase.original);
      }

      let resumeSource;
      const held = new Promise((resolve) => (resumeSource = resolve));
      let loadedSource;
      let originalResponseCount = 0;
      await page.route(
        (url) =>
          url.pathname.endsWith('.webp') &&
          url.pathname.includes(artwork) &&
          !url.pathname.includes('.thumbnail.'),
        async (route) => {
          await held;
          // Production R2 CORS accepts the canonical site. On a Pages preview
          // test only, supply the same verified bytes to the preview origin.
          const preview = new URL(origin).hostname.endsWith('.ultraclipart.pages.dev');
          const response = await route.fetch({
            headers: preview
              ? { ...route.request().headers(), origin: 'https://ultraclipart.com' }
              : route.request().headers(),
          });
          loadedSource = await response.body();
          originalResponseCount++;
          if (preview) {
            await route.fulfill({
              response,
              headers: { ...response.headers(), 'access-control-allow-origin': origin },
            });
          } else await route.fulfill({ response });
        },
      );
      try {
        await page.goto(origin + editPath, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(
          () =>
            document.querySelector('.uc-editor')?.getAttribute('aria-busy') === null &&
            document.querySelector('.uc-canvas > svg image')?.getAttribute('href'),
          null,
          { timeout: 15000 },
        );
        const image = page.locator('.uc-canvas > svg image');
        assert.match(await image.getAttribute('href'), /(?:\.thumbnail\.|\/previews\/p1\/)/);
        assert.equal(originalResponseCount, 0, 'geometry editor opens before the original arrives');
        const fitBefore = await page.locator('.uc-canvas').boundingBox();
        assert.ok(fitBefore?.width && fitBefore.height);

        const consent = page.locator('#cookie-notice [data-cookie-choice="necessary"]:visible');
        if (await consent.count()) await consent.click();
        await page.locator('[data-action="zoom-in"]').click();
        assert.ok((await page.locator('.uc-canvas').boundingBox()).width > fitBefore.width);
        await page.locator('[data-action="zoom-out"]').click();
        const fitAfterZoom = await page.locator('.uc-canvas').boundingBox();
        const source = await page.locator('.uc-editor').evaluate((root) =>
          JSON.parse(root.dataset.rasterSource).webp,
        );
        const arrived = page.waitForResponse((res) => res.url() === source.url && res.ok());
        resumeSource();
        await arrived;
        assert.equal(originalResponseCount, 1);
        assert.equal(loadedSource.length, source.bytes);
        assert.equal(createHash('sha256').update(loadedSource).digest('hex'), source.sha256);
        for (let i = 0; i < 5; i++) await page.locator('[data-action="zoom-in"]').click();
        await page.waitForFunction(() =>
          document.querySelector('.uc-canvas > svg image')?.getAttribute('href')?.startsWith('data:image/webp;base64,'),
        );
        const shownHash = await image.evaluate(async (node) => {
          const bytes = Uint8Array.from(atob(node.getAttribute('href').split(',')[1]), (c) => c.charCodeAt(0));
          return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
            byte.toString(16).padStart(2, '0'),
          ).join('');
        });
        assert.equal(shownHash, source.sha256);
        for (let i = 0; i < 5; i++) await page.locator('[data-action="zoom-out"]').click();
        const fitAfterOriginal = await page.locator('.uc-canvas').boundingBox();
        assert.ok(Math.abs(fitAfterOriginal.width - fitAfterZoom.width) <= 1);
        assert.ok(Math.abs(fitAfterOriginal.height - fitAfterZoom.height) <= 1);
        await page.locator('[data-action="export"]').click();
        await page.locator('label').filter({ has: page.locator('[data-format][value="png"]') }).click();
        const downloading = page.waitForEvent('download');
        await page.locator('[data-action="download"]').click();
        const file = await downloading;
        const png = await readFile(await file.path());
        const expectedWidth = await page.locator('.uc-editor').evaluate((root) => JSON.parse(root.dataset.rasterSource).width);
        assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        assert.equal(png.readUInt32BE(16), expectedWidth);
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ width, editPath, showcase, fitBefore, fitAfterOriginal, originalResponseCount, pngWidth: expectedWidth }));

      } finally {
        resumeSource();
      }
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
