import { chromium, webkit } from '@playwright/test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { siteNavigationScript } from '../../src/lib/site-navigation-inline.mjs';
const out = 'work/quality/site-navigation-controller';
fs.mkdirSync(out, { recursive: true });
const report = {
  scope:
    'Private minimal markup + exact repository navigation script and strict CSP; not a live test.',
  cases: [],
};
try {
  for (const engine of ['chromium', 'webkit']) {
    const b = await { chromium, webkit }[engine].launch(
      engine === 'chromium'
        ? {
            executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            headless: true,
          }
        : { headless: true },
    );
    try {
      for (const width of [390, 1440]) {
        const c = await b.newContext({ viewport: { width, height: 844 }, hasTouch: width === 390 });
        const hash = createHash('sha256').update(siteNavigationScript).digest('base64');
        await c.route('https://fixture.invalid/', (r) =>
          r.fulfill({
            contentType: 'text/html',
            headers: {
              'Content-Security-Policy':
                "default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-" + hash + "'",
            },
            body: `<!doctype html><style>.site-dropdown-heading{display:${width === 390 ? 'none' : 'block'}}</style><header data-site-header><button class="menu-button site-menu-button" aria-expanded="false">Menu</button><nav id="navigation"><div data-nav-disclosure><button class="site-nav-trigger" aria-expanded="false">Browse</button><div class="site-dropdown" hidden><div class="site-dropdown-heading"><a href="/categories/">View all</a></div><a class="site-dropdown-link" href="/categories/">Categories</a></div></div></nav></header><script>${siteNavigationScript}</script><button id="outside">Outside</button>`,
          }),
        );
        const p = await c.newPage();
        const errors = [];
        p.on('pageerror', (e) => errors.push(e.message));
        await p.goto('https://fixture.invalid/');
        await p.locator('.menu-button').click();
        assert.equal(await p.locator('.menu-button').getAttribute('aria-expanded'), 'true');
        await p.evaluate(() =>
          window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false })),
        );
        assert.equal(await p.locator('.menu-button').getAttribute('aria-expanded'), 'true');
        await p.evaluate(() =>
          window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
        );
        assert.equal(await p.locator('.menu-button').getAttribute('aria-expanded'), 'false');
        await p.locator('.site-nav-trigger').focus();
        await p.keyboard.press('ArrowDown');
        assert(
          await p.locator('.site-dropdown-link').evaluate((a) => a === document.activeElement),
        );
        await p.keyboard.press('Escape');
        assert(await p.locator('.site-nav-trigger').evaluate((a) => a === document.activeElement));
        await p.locator('.menu-button').click();
        await p.locator('#outside').click();
        assert.equal(await p.locator('.menu-button').getAttribute('aria-expanded'), 'false');
        assert.deepEqual(errors, []);
        report.cases.push({
          engine,
          width,
          earlyHandler: true,
          initialPageShowPreserved: true,
          syntheticBFCacheReset: true,
          visibleKeyboardFocus: true,
          escapeRestore: true,
          outsideClose: true,
          errors,
        });
        await c.close();
      }
    } finally {
      await b.close();
    }
  }
  report.status = 'PRIVATE_CRITICAL_CONTROLLER_ACCESSIBILITY_AND_LIFECYCLE_PASSED';
} catch (e) {
  report.status = 'FAILED';
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  fs.writeFileSync(out + '/report.json', JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
