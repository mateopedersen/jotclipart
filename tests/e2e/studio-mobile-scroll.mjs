import { chromium, webkit, devices, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';

const base = process.env.BASE_URL || 'http://127.0.0.1:4328';
const out = process.env.EVIDENCE_DIR || 'reports/studio-mobile-scroll';
mkdirSync(out, { recursive: true });
const report = { base, checks: [], status: 'running' };
const documentState = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('ultraclipart:editor:v1:my-clipart')));

async function swipe(session, x, y, dx, dy) {
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= 10; i++) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + (dx * i) / 10, y: y + (dy * i) / 10 }],
    });
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

try {
  for (const [engine, type] of Object.entries({ chromium, webkit })) {
    const browser = await type.launch();
    try {
      const context = await browser.newContext({
        ...devices[engine === 'chromium' ? 'Pixel 5' : 'iPhone 13'],
        viewport: { width: 390, height: 844 },
      });
      const page = await context.newPage();
      const cdp = engine === 'chromium' ? await context.newCDPSession(page) : null;
      await page.goto(base + '/create/');
      await page.locator('.uc-editor').scrollIntoViewIfNeeded();
      await expect(page.locator('.uc-editor')).not.toHaveAttribute('aria-busy', 'true', {
        timeout: 60000,
      });
      const cookie = page.locator('[data-cookie-choice=necessary]:visible');
      if (await cookie.count()) await cookie.click();
      const root = page.locator('.uc-editor');
      await expect(root).toHaveAttribute('data-wb-focus', 'true');
      if (await page.locator('[data-inspector-canvas]').isVisible())
        await page.locator('[data-inspector-canvas]').tap();
      await root.evaluate((element) => (element.scrollTop = 0));
      const box = await page.locator('.uc-stage').boundingBox();
      const x = box.x + box.width * 0.15,
        y = Math.min(780, box.y + box.height * 0.8);
      if (cdp) await swipe(cdp, x, y, 0, -180);
      else {
        // Playwright has no native WebKit swipe API and disallows mobile wheel.
        // Use its real mobile layout with default keyboard scrolling; do not
        // present this as a physical iPhone touch test.
        await page.locator('.uc-stage').focus();
        await page.keyboard.press('PageDown');
      }
      await expect.poll(() => root.evaluate((element) => element.scrollTop)).toBeGreaterThan(15);
      report.checks.push({
        engine,
        check: 'blank canvas scrolls the focused phone workspace',
        input: cdp ? 'native Chromium touch events' : 'WebKit mobile layout and keyboard PageDown',
      });

      if (cdp) {
        await page.locator('[data-panel=create]').tap();
        await page.locator('[data-action=draw]').tap();
        await expect(root).toHaveAttribute('data-drawing', 'true');
        if (await page.locator('[data-inspector-canvas]').isVisible())
          await page.locator('[data-inspector-canvas]').tap();
        await page.locator('.uc-stage').scrollIntoViewIfNeeded();
        const canvas = await page.locator('[data-artwork-canvas]').boundingBox();
        const before = await root.evaluate((element) => element.scrollTop);
        const count = (await documentState(page))?.layers.length ?? 0;
        await swipe(cdp, canvas.x + canvas.width * 0.2, canvas.y + canvas.height * 0.3, 60, 25);
        await expect.poll(async () => (await documentState(page)).layers.length).toBe(count + 1);
        assert.ok(Math.abs((await root.evaluate((element) => element.scrollTop)) - before) < 5);
        report.checks.push({
          engine,
          check: 'native touch drawing adds a layer without page scrolling',
        });
        await page.locator('[data-panel=create]').tap();
        await page.locator('[data-action=draw]').tap();
        await expect(root).toHaveAttribute('data-drawing', 'false');
        await page.locator('[data-shape=heart]').tap();
        const inserted = (await documentState(page)).layers.at(-1);
        if (await page.locator('[data-inspector-canvas]').isVisible())
          await page.locator('[data-inspector-canvas]').tap();
        await page.locator('.uc-stage').scrollIntoViewIfNeeded();
        const shape = await page
          .locator(`[data-artwork-canvas] [data-layer="${inserted.id}"]`)
          .boundingBox();
        const scrollBeforeDrag = await root.evaluate((element) => element.scrollTop);
        await swipe(cdp, shape.x + shape.width / 2, shape.y + shape.height / 2, 30, 45);
        await expect
          .poll(
            async () =>
              (await documentState(page)).layers.find((layer) => layer.id === inserted.id).y,
          )
          .toBeGreaterThan(inserted.y + 5);
        assert.ok(
          Math.abs((await root.evaluate((element) => element.scrollTop)) - scrollBeforeDrag) < 5,
        );
        report.checks.push({
          engine,
          check: 'native vertical object drag moves the layer instead of scrolling the page',
        });
      }

      await page.locator('[data-panel=elements]').tap();
      await page.locator('[data-artwork-search]').fill('sunflower');
      await expect(page.locator('[data-artwork]').first()).toBeVisible({ timeout: 30000 });
      const grid = page.locator('.uc-artwork-grid');
      await grid.scrollIntoViewIfNeeded();
      const gridBox = await grid.boundingBox();
      if (cdp)
        await swipe(cdp, gridBox.x + gridBox.width / 2, gridBox.y + gridBox.height * 0.75, 0, -90);
      else {
        await page.locator('[data-artwork]').first().focus();
        await page.keyboard.press('PageDown');
      }
      await expect.poll(() => grid.evaluate((element) => element.scrollTop)).toBeGreaterThan(10);
      report.checks.push({ engine, check: 'artwork library remains independently scrollable' });
      await page.locator('[data-inspector-canvas]').tap();

      for (const viewport of [
        { width: 844, height: 390 },
        { width: 320, height: 568 },
      ]) {
        await page.setViewportSize(viewport);
        await expect
          .poll(() => root.evaluate((element) => getComputedStyle(element).overflowY))
          .toBe('auto');
        await root.evaluate((element) => (element.scrollTop = 0));
        if (cdp) await swipe(cdp, 20, Math.min(280, viewport.height - 30), 0, -130);
        else {
          await page.locator('[data-wb-back-page]').focus();
          await page.keyboard.press('PageDown');
        }
        await expect.poll(() => root.evaluate((element) => element.scrollTop)).toBeGreaterThan(10);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
          false,
        );
        report.checks.push({
          engine,
          check: 'workspace scrolls after orientation/size change',
          viewport,
        });
      }
      await page.screenshot({ path: `${out}/${engine}-320.png` });
      await context.close();
      for (const viewport of [
        { width: 1280, height: 600 },
        { width: 1440, height: 1000 },
      ]) {
        const desktop = await browser.newContext({ viewport, hasTouch: false });
        try {
          const desktopPage = await desktop.newPage();
          await desktopPage.goto(base + '/create/');
          await desktopPage.locator('.uc-editor').scrollIntoViewIfNeeded();
          await expect(desktopPage.locator('.uc-editor')).not.toHaveAttribute('aria-busy', 'true', {
            timeout: 60000,
          });
          assert.equal(
            await desktopPage
              .locator('.uc-editor')
              .evaluate((element) => getComputedStyle(element).overflowY),
            'hidden',
          );
          assert.equal(
            await desktopPage.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
            false,
          );
          report.checks.push({
            engine,
            check: 'desktop keeps its fitted workspace without horizontal overflow',
            viewport,
          });
        } finally {
          await desktop.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = String(error);
  throw error;
} finally {
  writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
