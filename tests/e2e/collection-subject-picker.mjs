import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const base = process.env.BASE_URL ?? 'http://127.0.0.1:4339',
  out = resolve(process.env.EVIDENCE_DIR ?? 'reports/collection-subject-picker');
mkdirSync(out, { recursive: true });
const report = {
  base,
  scope:
    'Actual collection disclosure across mobile/desktop, native subject links and no-JavaScript fallback; not a physical-device test',
  passed: false,
  cases: [],
};
try {
  for (const [engine, type] of Object.entries({ chromium, webkit })) {
    const browser = await type.launch(
      engine === 'chromium' && process.env.UC_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.UC_CHROMIUM_EXECUTABLE_PATH }
        : {},
    );
    try {
      for (const [width, js] of [
        [320, true],
        [390, true],
        [768, true],
        [1440, true],
        ...(engine === 'webkit' ? [[390, false]] : []),
      ]) {
        const context = await browser.newContext({
            viewport: { width, height: 950 },
            hasTouch: width < 768,
            isMobile: width < 768,
            javaScriptEnabled: js,
          }),
          page = await context.newPage(),
          errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        const startup = js
          ? page.waitForResponse((r) => new URL(r.url()).pathname === '/surprise-picks.json')
          : undefined;
        const response = await page.goto(base + '/collection/technology-devices/', {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
        assert.equal(response.status(), 200);
        if (process.env.UC_EXPECTED_SNAPSHOT_SHA256)
          assert.equal(
            response.headers()['x-uc-snapshot'],
            process.env.UC_EXPECTED_SNAPSHOT_SHA256,
          );
        if (startup) {
          const r = await startup;
          assert.equal(r.status(), 200);
          await r.json();
        }
        const picker = page.locator('.mobile-subject-picker'),
          links = picker.locator('nav a'),
          count = await links.count();
        assert(count > 0);
        assert.equal(Number(await picker.locator('.subject-count').textContent()), count);
        assert.equal(await page.locator('.desktop-subject-links').count(), 0);
        const row = {
          engine,
          width,
          javaScript: js,
          topics: count,
          root: response.headers()['x-uc-snapshot'],
        };
        {
          await expect(picker).toBeVisible();
          await expect(picker).not.toHaveAttribute('open');
          row.galleryTop = (await page.locator('main .gallery').first().boundingBox()).y;
          row.galleryGap =
            row.galleryTop - ((await picker.boundingBox()).y + (await picker.boundingBox()).height);
          assert(
            row.galleryGap >= 0 && row.galleryGap <= 160,
            'Collapsed subject list must not leave excessive empty space before the gallery heading',
          );
          await picker.locator('summary').click();
          await expect(picker).toHaveAttribute('open', '');
          const box = await picker
            .locator('nav')
            .evaluate((e) => ({ height: e.clientHeight, scroll: e.scrollHeight }));
          assert(box.height <= 550 && box.scroll > box.height);
          const target = links.last(),
            href = await target.getAttribute('href');
          assert(/^\/clipart\/[a-z0-9-]+\/$/.test(href));
          await target.evaluate((e) => e.scrollIntoView({ block: 'nearest', behavior: 'instant' }));
          if (js) {
            const next = page.waitForResponse(
              (r) => new URL(r.url()).pathname === '/surprise-picks.json',
            );
            await target.click();
            await (await next).json();
          } else await target.click();
          await expect(page).toHaveURL(base + href);
        }
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
          false,
        );
        assert.deepEqual(errors, []);
        row.passed = true;
        report.cases.push(row);
        writeFileSync(out + '/report.json', JSON.stringify(report, null, 2));
        await page.screenshot({ path: out + '/' + engine + '-' + width + '-' + js + '.png' });
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }
  report.passed = true;
} catch (e) {
  report.failure = e.stack;
  throw e;
} finally {
  writeFileSync(out + '/report.json', JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({ passed: report.passed, cases: report.cases.length, failure: report.failure }),
  );
}
