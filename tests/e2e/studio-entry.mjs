import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const base = process.env.BASE_URL || 'http://127.0.0.1:4327';
const out = process.env.EVIDENCE_DIR || 'reports/studio-entry';
await mkdir(out, { recursive: true });
const report = { base, started: new Date().toISOString(), checks: [], errors: [] };
for (const [engine, implementation] of Object.entries({ chromium, webkit })) {
  const browser = await implementation.launch();
  try {
    for (const [width, height] of [
      [320, 568],
      [390, 844],
      [768, 1024],
      [844, 390],
      [1280, 600],
      [1440, 1000],
    ]) {
      const context = await browser.newContext({
        viewport: { width, height },
        hasTouch: width < 900,
      });
      const page = await context.newPage();
      try {
        await page.goto(base + '/create/', { waitUntil: 'domcontentloaded' });
        const root = page.locator('.uc-editor');
        const welcome = page.locator('.studio-welcome');
        await expect(welcome).toBeVisible();
        await expect(page.locator('#studio-title')).toBeInViewport();
        const cookie = page.locator('[data-cookie-choice=necessary]:visible').first();
        if (await cookie.count()) await cookie.click();
        await root.scrollIntoViewIfNeeded();
        await expect(page.locator('.uc-workspace')).not.toHaveAttribute('inert', '', {
          timeout: 60000,
        });
        await expect(root).not.toHaveAttribute('data-wb-focus', 'true');
        assert.notEqual(await root.evaluate((el) => getComputedStyle(el).position), 'fixed');
        await page.locator('[data-panel=create]').click();
        await page.locator('[data-shape=heart]').click();
        const before = await page.evaluate(() =>
          JSON.parse(localStorage.getItem('ultraclipart:editor:v1:my-clipart')),
        );
        assert.ok(before?.layers.length);
        const toggle = page.locator('[data-wb-back-page]');
        await expect(toggle).toHaveText('Open Workspace');
        await toggle.click();
        await expect(root).toHaveAttribute('data-wb-focus', 'true');
        await expect(toggle).toHaveText('Back to Page');
        await toggle.click();
        await expect(root).toHaveAttribute('data-wb-focus', 'false');
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect(page.locator('#studio-title')).toBeInViewport();
        await page.locator('.site-footer').scrollIntoViewIfNeeded();
        await expect(page.locator('.site-footer')).toBeInViewport();
        assert.ok(await page.evaluate(() => scrollY > 100));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await root.scrollIntoViewIfNeeded();
        await expect(page.locator('.uc-workspace')).not.toHaveAttribute('inert', '', {
          timeout: 60000,
        });
        await expect(root).not.toHaveAttribute('data-wb-focus', 'true');
        const after = await page.evaluate(() =>
          JSON.parse(localStorage.getItem('ultraclipart:editor:v1:my-clipart')),
        );
        assert.deepEqual(
          after.layers,
          before.layers,
          'Opening and leaving workspace must preserve the project',
        );
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: `${out}/${engine}-${width}.png` });
        report.checks.push({
          engine,
          width,
          height,
          welcome: true,
          pageScroll: true,
          explicitWorkspace: true,
          returnToPage: true,
          projectPreserved: true,
        });
      } catch (error) {
        report.errors.push({ engine, width, height, error: error.stack });
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
report.finished = new Date().toISOString();
report.passed = report.errors.length === 0;
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;
