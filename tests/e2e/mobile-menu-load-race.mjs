import { chromium, webkit, devices } from '@playwright/test';
import fs from 'node:fs';
const base = process.env.UC_TEST_BASE_URL ?? 'https://ultraclipart.com';
if (
  !/^https:\/\/(?:ultraclipart\.com|[a-z0-9-]+\.ultraclipart\.pages\.dev)$/.test(base) &&
  base !== 'http://127.0.0.1:54931'
)
  throw Error('Allowed test origin required');
const engine = process.argv[2] ?? 'chromium',
  out = 'work/quality/mobile-menu-load-race-' + engine;
fs.mkdirSync(out, { recursive: true });
const browser = await { chromium, webkit }[engine].launch(
  engine === 'chromium'
    ? {
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true,
      }
    : { headless: true },
);
const report = {
  status: 'RUNNING',
  engine,
  scope:
    'Controlled delay on the actual public logo response, unchanged real HTML/JavaScript/bytes. Tests interaction before the initial load/pageshow; not a natural latency benchmark.',
};
let release;
const held = new Promise((r) => (release = r));
try {
  const context = await browser.newContext({
    ...devices[engine === 'webkit' ? 'iPhone 13' : 'Pixel 7'],
    viewport: { width: 390, height: 844 },
    serviceWorkers: 'block',
  });
  await context.route(base + '/logo.svg', async (route) => {
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  await context.addInitScript(() => {
    window.__navEvents = [];
    for (const name of ['load', 'pageshow', 'DOMContentLoaded'])
      window.addEventListener(name, (e) =>
        window.__navEvents.push({
          event: name,
          at: performance.now(),
          persisted: e.persisted,
          menu: document.querySelector('.site-menu-button')?.getAttribute('aria-expanded'),
        }),
      );
    document.addEventListener(
      'click',
      (e) => {
        if (e.target.closest?.('.site-menu-button'))
          queueMicrotask(() =>
            window.__navEvents.push({
              event: 'menu-click-after-handlers',
              at: performance.now(),
              menu: document.querySelector('.site-menu-button')?.getAttribute('aria-expanded'),
            }),
          );
      },
      true,
    );
  });
  const page = await context.newPage();
  await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const choice = page.locator('[data-cookie-choice="necessary"]:visible').first();
  if (await choice.count()) await choice.tap();
  report.beforeReady = await page.evaluate(() => document.readyState);
  await page.locator('.site-menu-button').tap();
  report.expandedBeforeRelease = await page
    .locator('.site-menu-button')
    .getAttribute('aria-expanded'); // Avoid font wait while holding the initial load event.

  release();
  await page.waitForLoadState('load', { timeout: 45000 });
  await page.waitForTimeout(150);
  report.expandedAfterRelease = await page
    .locator('.site-menu-button')
    .getAttribute('aria-expanded');
  report.events = await page.evaluate(() => window.__navEvents);
  await page.screenshot({ path: out + '/after-load-completes.png' });
  report.initialMenuPreserved =
    report.expandedBeforeRelease === 'true' && report.expandedAfterRelease === 'true';
  if (!report.initialMenuPreserved) throw Error('Initial pageshow closed the visitor-opened menu');
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
  );
  report.syntheticBFCacheReset =
    (await page.locator('.site-menu-button').getAttribute('aria-expanded')) === 'false';
  if (!report.syntheticBFCacheReset) throw Error('BFCache restore must reset the menu');
  await page.locator('.site-menu-button').tap();
  await page.locator('.site-dropdown-link[href="/categories/"]:visible').first().tap();
  await page.waitForURL('**/categories/');
  report.status = 'PUBLIC_MENU_LATE_LOAD_AND_NATIVE_NAVIGATION_PASSED';
} catch (e) {
  report.status = 'TEST_FAILED';
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  release();
  await browser.close();
  fs.writeFileSync(out + '/report.json', JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
