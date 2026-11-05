import assert from 'node:assert/strict';
import { chromium, webkit } from '@playwright/test';
const origin = process.env.BASE_URL ?? 'https://ultraclipart.com';
const engine = process.env.UC_BROWSER ?? 'chromium';
const browser = await (engine === 'chromium' ? chromium : webkit).launch({
  executablePath: engine === 'chromium' ? process.env.UC_CHROME_EXECUTABLE : undefined,
});
try {
  for (const width of [390, 1440]) {
    const page = await browser.newPage({
      viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390,
    });
    const images = new Map();
    const start = performance.now();
    const elapsed = () => Math.round(performance.now() - start);
    page.on('request', request => {
      const url = request.url();
      if (request.resourceType() === 'image' && url.startsWith('https://assets.ultraclipart.com/'))
        images.set(request, { url, at: elapsed() });
    });
    page.on('response', response => {
      const row = images.get(response.request());
      if (row) {
        row.status = response.status();
        row.bytes = Number(response.headers()['content-length'] ?? 0);
      }
    });
    page.on('requestfinished', request => {
      const row = images.get(request);
      if (row) row.finish = elapsed();
    });
    page.on('requestfailed', request => {
      const row = images.get(request);
      if (row) row.failure = request.failure()?.errorText;
    });
    let response, titleMs, coverMs, error, loadMs, covers, path;
    try {
      response = await page.goto(origin + '/collections/', { waitUntil: 'commit', timeout: 30000 });
      assert.equal(response.status(), 200);
      await page.locator('main h1').waitFor({ state: 'visible', timeout: 15000 });
      titleMs = elapsed();
      await page.waitForFunction(() =>
        [...document.querySelectorAll('.collection-group-tile:first-child .collection-cover img')]
          .filter(img => img.getBoundingClientRect().width > 0)
          .every(img => img.complete && img.naturalWidth > 0),
        null, { timeout: 20000 });
      coverMs = elapsed();
      covers = await page.locator('.collection-group-tile:first-child .collection-cover img')
        .evaluateAll(nodes => nodes.map(img => ({ original: img.getAttribute('src'), chosen: img.currentSrc })));
      assert.equal(covers.length, 3);
      assert.ok(covers.every(cover =>
        cover.original !== cover.chosen &&
        /\.thumbnail\.[a-f0-9]+\.webp$/.test(cover.chosen),
      ));
      await page.waitForLoadState('load', { timeout: 12000 });
      loadMs = elapsed();
      const originals = new Set(covers.map(cover => cover.original));
      assert.ok([...images.values()].every(request => !originals.has(request.url)));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      const cookieChoice = page.locator('#cookie-notice [data-cookie-choice="necessary"]:visible');
      if (await cookieChoice.count()) await cookieChoice.click();
      await page.locator('#collection-query').fill('musical instruments');
      const card = page.locator('.collection-group-tile[href="/collection/musical-instruments/"]');
      await card.waitFor({ state: 'visible', timeout: 10000 });
      await Promise.all([page.waitForURL('**/collection/musical-instruments/', { waitUntil: 'commit' }), card.click()]);
      path = new URL(page.url()).pathname;
      assert.equal(path, '/collection/musical-instruments/');
      await page.locator('main h1').waitFor({ state: 'visible', timeout: 10000 });
      assert.match(await page.locator('main h1').innerText(), /musical instruments/i);
    } catch(e) {
      error = e.message.split('\n')[0];
      process.exitCode = 1;
    } finally {
      console.log(JSON.stringify({
        engine, width, titleMs, coverMs, loadMs, covers, path, error,
        ray: response?.headers()['cf-ray'], server: response?.headers()['server-timing'],
        cache: response?.headers()['x-uc-html-cache'], status: response?.status(),
        images: [...images.values()],
      }));
      await page.close();
    }
  }
} finally {
  await browser.close();
}
