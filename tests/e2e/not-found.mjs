import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium, webkit, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const origin = process.env.BASE_URL || 'http://127.0.0.1:8788';
const reportDirectory = process.env.ERROR_PAGE_REPORT || 'reports/not-found';
const deployed = new URL(origin).hostname !== '127.0.0.1';
const report = { origin, layouts: [], navigation: [] };
mkdirSync(reportDirectory, { recursive: true });

for (const engine of [chromium, webkit]) {
  const browser = await engine.launch();
  try {
    for (const width of [320, 390, 768, 1024, 1440, 1920]) {
      const context = await browser.newContext({ viewport: { width, height: 950 } });
      try {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        for (const path of [
          '/404',
          '/404/',
          '/missing/very-deep/illustration/',
          ...(deployed ? ['/art/jotclipart-404-browser-smoke-missing/'] : []),
        ]) {
          const response = await page.goto(origin + path, { waitUntil: 'domcontentloaded' });
          assert.equal(response.status(), 404, path);
          assert.equal(response.request().redirectedFrom(), null, path);
          await expect(page.locator('h1')).toHaveText("We couldn't find that page.");
          await expect(page.locator('h1')).toHaveCSS('color', 'rgb(17, 17, 17)');
          await expect(page.locator('.error-description')).toHaveCSS('color', 'rgb(69, 69, 69)');
          await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', 'noindex');
          await expect(page.getByLabel('Search the library')).toBeVisible();
          await expect
            .poll(() =>
              page
                .locator('.error-visual img')
                .evaluate((img) => img.complete && img.naturalWidth > 0),
            )
            .toBe(true);
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          const head = await page.request.head(origin + path, { maxRedirects: 0 });
          assert.equal(head.status(), 404, path);
          assert.equal((await head.body()).length, 0);
        }
        if ([390, 1440].includes(width)) {
          const audit = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
            .analyze();
          assert.deepEqual(
            audit.violations.map((violation) => violation.id),
            [],
          );
          await page.screenshot({
            path: `${reportDirectory}/${engine.name()}-${width}.png`,
            fullPage: true,
          });
        }
        assert.deepEqual(errors, []);
        report.layouts.push({ browser: engine.name(), width });
      } finally {
        await context.close();
      }
    }
    const plain = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await plain.newPage();
      await page.goto(origin + '/404');
      await page.getByRole('searchbox').fill('watercolor fox');
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await page.waitForURL(
        (url) => url.pathname === '/search/' && url.searchParams.get('q') === 'watercolor fox',
      );
      if (deployed) {
        for (const path of ['/', '/collections/', '/new/', '/create/', '/contact/']) {
          const response = await page.request.get(origin + path);
          assert.equal(response.status(), 200, path);
        }
      }
      report.navigation.push({ browser: engine.name(), nativeSearch: true });
    } finally {
      await plain.close();
    }
    if (deployed) {
      const page = await browser.newPage();
      try {
        await page.goto(origin + '/404');
        const query = page.getByRole('combobox', { name: 'Search the library' });
        await query.fill('mang');
        const subject = page.locator('.search-suggestions a[href="/clipart/mango/"]');
        await expect(subject).toBeVisible({ timeout: 30000 });
        await subject.click();
        await page.waitForURL('**/clipart/mango/');
        report.navigation.push({ browser: engine.name(), searchSuggestions: true });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
}
writeFileSync(reportDirectory + '/report.json', JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    passed: true,
    layouts: report.layouts.length,
    navigation: report.navigation.length,
  }),
);
