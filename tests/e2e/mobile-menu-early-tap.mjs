import { chromium, webkit, devices } from '@playwright/test';
import fs from 'node:fs';
const base = process.env.UC_TEST_BASE_URL ?? 'https://ultraclipart.com';
const engine = process.argv[2] ?? 'chromium',
  out = 'work/quality/mobile-menu-early-tap-' + engine;
fs.mkdirSync(out, { recursive: true });
const b = await { chromium, webkit }[engine].launch(
  engine === 'chromium'
    ? {
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true,
      }
    : { headless: true },
);
let release;
const held = new Promise((r) => (release = r)),
  report = {
    engine,
    scope:
      'Controlled delay of actual menu module, unchanged real HTML and JS; not a latency benchmark.',
  };
try {
  const c = await b.newContext({
    ...devices[engine === 'webkit' ? 'iPhone 13' : 'Pixel 7'],
    viewport: { width: 390, height: 844 },
  });
  await c.route('**/__ssr-client/**/*.js', async (r) => {
    const response = await r.fetch();
    await held;
    await r.fulfill({ response });
  });
  const p = await c.newPage();
  await p.goto(base + '/', { waitUntil: 'commit' });
  const menu = p.locator('.site-menu-button');
  await menu.waitFor({ state: 'visible' });
  await menu.tap();
  report.beforeRelease = await menu.getAttribute('aria-expanded');
  release();
  await p.waitForLoadState('load');
  await p.waitForTimeout(100);
  report.afterRelease = await menu.getAttribute('aria-expanded');
  report.readyBeforeModules = await p
    .locator('[data-site-header]')
    .getAttribute('data-navigation-ready');
  if (
    report.beforeRelease !== 'true' ||
    report.afterRelease !== 'true' ||
    report.readyBeforeModules !== 'true'
  )
    throw Error('Menu must work before all external modules finish');
  await p.locator('.site-dropdown-link[href="/categories/"]:visible').first().tap();
  await p.waitForURL('**/categories/');
  report.nativeTap = true;
  report.status = 'PUBLIC_EARLY_MENU_TAP_AND_NATIVE_NAVIGATION_PASSED';
} catch (e) {
  report.status = 'TEST_FAILED';
  report.error = e.message;
  process.exitCode = 1;
} finally {
  release();
  await b.close();
  fs.writeFileSync(out + '/report.json', JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
