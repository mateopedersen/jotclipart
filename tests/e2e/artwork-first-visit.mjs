import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, webkit } from '@playwright/test';

const base = new URL(process.env.BASE_URL ?? 'https://ultraclipart.com').origin;
const build = process.env.UC_BUILD_ROOT;
assert.ok(build, 'Provide the compiled catalog software directory as UC_BUILD_ROOT');
const id = process.env.UC_ART_ID ?? 'airbus-aircraft-20261105-001';
const scripts = JSON.parse(await readFile(build + '/art-ssr/compiled/script-urls.json'));
const related = Object.entries(scripts).find(([source]) => source.includes('/RelatedArtwork.astro?'))?.[1];
assert.match(related, /^\/__ssr-client\/[a-f0-9]{40}\/[\w-]+\.js$/);
const engine = process.env.UC_BROWSER ?? 'chromium';
assert.ok(['chromium', 'webkit'].includes(engine));
const browser = await (engine === 'chromium' ? chromium : webkit).launch({
  executablePath: engine === 'chromium' ? process.env.UC_CHROME_EXECUTABLE : undefined,
});

try {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      isMobile: width === 390,
      hasTouch: width === 390,
    });
    const page = await context.newPage();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const matched = new Map();
    const failed = [];
    let started;
    page.on('pageerror', error => failed.push(error.message));
    await page.route(
      url => url.pathname === related || (
        url.hostname === 'assets.ultraclipart.com' &&
        url.pathname.includes(id + '.webp.') &&
        !url.pathname.includes('.thumbnail.')
      ),
      async route => {
        const path = new URL(route.request().url()).pathname;
        matched.set(path === related ? 'related' : 'original', Math.round(performance.now() - started));
        await held;
        await route.continue().catch(() => {});
      },
    );
    try {
      started = performance.now();
      const response = await page.goto(base + '/art/' + id + '/', {
        waitUntil: 'commit', timeout: 30000,
      });
      assert.equal(response.status(), 200);
      const ready = page.locator('main h1');
      await ready.waitFor({ state: 'visible', timeout: 12000 });
      const headingMs = Math.round(performance.now() - started);
      await page.waitForLoadState('load', { timeout: 12000 });
      const loadMs = Math.round(performance.now() - started);
      await page.waitForFunction(() => {
        const image = document.querySelector('#art-preview img');
        return image?.complete && image.naturalWidth > 0;
      });
      const image = page.locator('#art-preview img');
      const before = await image.evaluate(node => ({
        original: node.getAttribute('src'),
        selected: node.currentSrc,
        width: node.getBoundingClientRect().width,
        height: node.getBoundingClientRect().height,
      }));
      assert.match(before.original, /\.webp\.[a-f0-9]+\.webp$/);
      assert.match(before.selected, /\.thumbnail\.[a-f0-9]+\.webp$/);
      assert.ok(before.width > 0 && before.height > 0);
      assert.ok(await page.locator('main a[href="/edit/' + id + '/"]').first().isVisible());
      const guideSources = await page.locator('.file-guide-illustration image')
        .evaluateAll(nodes => nodes.map(node => node.getAttribute('href')));
      assert.ok(guideSources.length > 0);
      assert.ok(guideSources.every(source => source === before.selected));

      const cookieChoice = page.locator('#cookie-notice [data-cookie-choice="necessary"]:visible');
      if (await cookieChoice.count()) await cookieChoice.click();
      const swatch = page.locator('.art-preview-controls [data-bg="#b8d8ff"]');
      await swatch.click();
      assert.equal(await swatch.getAttribute('aria-pressed'), 'true');

      const limit = performance.now() + 8000;
      while (matched.size < 2 && performance.now() < limit) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.deepEqual([...matched.keys()].sort(), ['original', 'related']);
      release();
      await page.waitForFunction(
        () => {
          const image = document.querySelector('#art-preview img');
          return image?.complete && image.naturalWidth > 0 &&
            image.currentSrc === image.getAttribute('src');
        },
        null,
        { timeout: 15000 },
      );
      const after = await image.boundingBox();
      assert.ok(Math.abs(before.width - after.width) <= 1);
      assert.ok(Math.abs(before.height - after.height) <= 1);
      assert.deepEqual(failed, []);
      const nav = await page.evaluate(() => {
        const entry = performance.getEntriesByType('navigation')[0];
        return Object.fromEntries(
          ['nextHopProtocol', 'responseStart', 'domContentLoadedEventStart', 'loadEventStart']
            .map(key => [key, entry[key]]),
        );
      });
      for (const at of matched.values()) assert.ok(at >= Math.floor(nav.loadEventStart) - 100);
      console.log(JSON.stringify({
        engine, width, path: '/art/' + id + '/', headingMs, loadMs,
        nav, held: Object.fromEntries(matched), box: [before.width, before.height],
        source: before.original, preview: before.selected, guideImages: guideSources.length,
        snapshot: response.headers()['x-uc-snapshot'],
      }));
    } finally {
      release();
      await context.close();
    }
  }
} finally {
  await browser.close();
}
