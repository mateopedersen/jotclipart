import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  bridgeLocalCdn,
  isExpectedLocalTeardownError,
  markLocalCdnTeardown,
} from '../helpers/local-cdn.mjs';
const base = process.env.BASE_URL || 'http://127.0.0.1:4340';
const out = 'reports/performance/editor-source-loading';
mkdirSync(out, { recursive: true });
const rows = [];
for (const [engine, implementation] of Object.entries({ chromium, webkit })) {
  const browser = await implementation.launch();
  try {
    for (const missing of [false, true]) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
      });
      const fixture = await bridgeLocalCdn(context, base);
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const id = 'classic-white-volleyball-realistic-clipart';
      const path = '/edit/' + id + '/';
      let release,
        originals = 0,
        missingRequests = 0;
      const hold = new Promise((done) => {
        release = done;
      });
      await page.route(
        (url) => url.pathname.includes(id) && url.pathname.endsWith('.webp') &&
          !url.pathname.includes('.thumbnail.'),
        async (route) => {
        originals++;
        try {
          const response = await route.fetch();
          await hold;
          await route.fulfill({
            response,
            headers: { ...response.headers(), 'access-control-allow-origin': new URL(base).origin },
          });
        } catch (error) {
          if (
            !isExpectedLocalTeardownError(context, error) &&
            !/already handled|has been closed/.test(String(error))
          )
            throw error;
        }
      });
      if (missing)
        await page.route('**/previews/p1/*-960.webp', (route) => {
          missingRequests++;
          return route.abort();
        });
      try {
        await page.goto(base + path, { waitUntil: 'domcontentloaded' });
        const preview = page.locator('.uc-canvas > svg image');
        if (!missing) {
          await expect(preview).toHaveAttribute('href', /^\/previews\/p1\//);
          const loaded = await preview.evaluate(async (image) => {
            const probe = new Image();
            probe.src = image.getAttribute('href');
            await probe.decode();
            return probe.naturalWidth;
          });
          assert.ok(loaded > 0 && loaded <= 960);
        }
        await expect.poll(() => originals, { timeout: 30000 }).toBe(1);
        if (missing) await expect(page.locator('.uc-workspace')).toHaveAttribute('inert', '');
        else await expect(page.locator('.uc-workspace')).not.toHaveAttribute('inert', '');
        release();
        await expect(page.locator('.uc-workspace')).not.toHaveAttribute('inert', '', {
          timeout: 30000,
        });
        await expect(page.locator('.uc-editor')).not.toHaveAttribute('aria-busy', 'true');
        assert.equal(originals, 1, 'The bootstrap and editor share one verified original request');
        if (missing) {
          assert.ok(missingRequests > 0);
          await expect(page.locator('[data-artwork-canvas] image')).toHaveAttribute(
            'href',
            /^data:image\/webp;base64,/,
          );
        } else assert.deepEqual(errors, []);
        rows.push({
          engine,
          missingPreview: missing,
          originals,
          missingRequests,
          smallPreview: !missing,
          controlsWaitedForOriginal: missing,
          fallbackVerified: missing,
          localCdnFixture: fixture,
          errors,
          passed: true,
        });
      } finally {
        release();
        markLocalCdnTeardown(context);
        await context.close();
      }
      writeFileSync(out + '/report.json', JSON.stringify(rows, null, 2));
    }
  } finally {
    await browser.close();
  }
}
console.log(JSON.stringify(rows));
