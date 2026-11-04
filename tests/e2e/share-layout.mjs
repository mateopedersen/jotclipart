// Real public buttons and dialog. No message is sent and no public share is created.
import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const base = process.env.BASE_URL || 'http://127.0.0.1:4321';
const out = resolve(process.env.EVIDENCE_DIR || 'reports/share-layout');
mkdirSync(out, { recursive: true });
const report = { base, passed: false, scope: 'Actual artwork/card sharing styles, opening and closing; no publication or social message', cases: [], errors: [] };
try {
  for (const [engine, type] of Object.entries({ chromium, webkit })) {
    const browser = await type.launch(engine === 'chromium' && process.env.UC_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.UC_CHROMIUM_EXECUTABLE_PATH } : {});
    try {
      for (const width of [320, 390, 768, 1440]) {
        const page = await browser.newPage({ viewport: { width, height: 1000 }, hasTouch: width < 768, isMobile: width < 768 });
        const mutations = [];
        page.on('pageerror', error => report.errors.push(error.message));
        page.on('request', request => { if (request.method() === 'POST' && /\/api\/share\//.test(new URL(request.url()).pathname)) mutations.push(request.url()); });
        const discovery=page.waitForResponse(r=>new URL(r.url()).pathname==='/surprise-picks.json');
        const response = await page.goto(base + '/art/winter-arctic-fox-resting/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        assert.equal(response.status(), 200);
        if (process.env.UC_EXPECTED_SNAPSHOT_SHA256) assert.equal(response.headers()['x-uc-snapshot'], process.env.UC_EXPECTED_SNAPSHOT_SHA256);
        await(await discovery).json();
        const share = page.locator('.share-trigger-detail'), favorite = page.locator('.art-detail [data-favorite]');
        await share.scrollIntoViewIfNeeded();
        const geometry = await share.evaluate((element) => {
          const box = element.getBoundingClientRect(), style = getComputedStyle(element), sibling = element.parentElement.querySelector('[data-favorite]').getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height, favoriteX: sibling.x, favoriteWidth: sibling.width, display: style.display, marginTop: style.marginTop };
        });
        assert(Math.abs(geometry.x - geometry.favoriteX) < 1);
        assert(Math.abs(geometry.width - geometry.favoriteWidth) < 1);
        assert.equal(geometry.display, 'inline-flex');
        assert.equal(geometry.marginTop, '10px');
        assert(geometry.height >= 44);
        const originalFavorite = await favorite.getAttribute('aria-pressed');
        await share.screenshot({ path: out + '/' + engine + '-' + width + '-button.png' });
        await share.click();
        const dialog = page.locator('dialog.uc-share');
        await expect(dialog).toBeVisible({ timeout: 30000 });
        await expect(dialog.locator('.uc-share-download')).toBeEnabled({ timeout: 30000 });
        await expect(dialog.locator('#uc-share-link')).toHaveValue('https://ultraclipart.com/art/winter-arctic-fox-resting/');
        const layout = await dialog.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth, radius: getComputedStyle(element).borderRadius }));
        assert.equal(layout.radius, width <= 700 ? '17px' : '24px');
        assert(layout.scrollWidth <= layout.width + 1);
        await dialog.screenshot({ path: out + '/' + engine + '-' + width + '-dialog.png' });
        await dialog.locator('.uc-share-close').click();
        await expect(dialog).toHaveCount(0);
        assert.equal(await favorite.getAttribute('aria-pressed'), originalFavorite);
        const nextDiscovery=page.waitForResponse(r=>new URL(r.url()).pathname==='/surprise-picks.json');
        const cards = await page.goto(base + '/clipart/winter/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        assert.equal(cards.status(), 200);await(await nextDiscovery).json();
        const card = page.locator('.share-trigger-card').first();
        assert.equal(await card.evaluate(element => getComputedStyle(element).position), 'absolute');
        assert.equal(Math.round((await card.boundingBox()).width), 40);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        assert.deepEqual(mutations, []);
        report.cases.push({ engine, width, geometry, dialog: layout, root: response.headers()['x-uc-snapshot'], revision: response.headers()['x-uc-revision'], publicationCalls: mutations.length, passed: true });
        await page.close();
      }
    } finally { await browser.close(); }
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) { report.failure = error.stack; throw error; }
finally { writeFileSync(out + '/report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, failure: report.failure, errors: report.errors })); }
