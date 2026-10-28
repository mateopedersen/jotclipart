import { chromium, webkit, expect } from '@playwright/test';
import { templateRoutes } from '../../scripts/performance/routes.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { bridgeLocalCdn } from '../helpers/local-cdn.mjs';
const base = process.env.BASE_URL || 'http://127.0.0.1:4338';
const out = process.env.OUT || 'reports/performance/site-speed-pages';
mkdirSync(out, { recursive: true });
const rows = [];
const routes = process.env.PERFORMANCE_ROUTES?.split(',') ?? [
  ...templateRoutes,
  '/clipart/robot/',
  '/clipart/dinner/',
];
const engines = process.env.UC_BROWSER
  ? { [process.env.UC_BROWSER]: { chromium, webkit }[process.env.UC_BROWSER] }
  : { chromium, webkit };
for (const [engine, type] of Object.entries(engines)) {
  const browser = await type.launch();
  try {
    for (const width of [390, 1440])
      for (const path of routes) {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          hasTouch: width === 390,
        });
        const page = await context.newPage(),
          errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        const row = { engine, width, path, localCdnFixture: await bridgeLocalCdn(context, base) };
        try {
          const r = await page.goto(base + path, { waitUntil: 'domcontentloaded' });
          assert.ok(
            path === '/404.html' ? [200, 404].includes(r.status()) : r.status() === 200,
            `${r.status()} ${path}`,
          );
          await page.evaluate(() => document.fonts.ready);
          await expect(page.locator('h1').first()).toBeVisible();
          if (path.startsWith('/edit/'))
            await expect(page.locator('.uc-workspace')).not.toHaveAttribute('inert', '', {
              timeout: 30000,
            });
          const choice = page.locator('[data-cookie-choice=necessary]:visible').first();
          if (await choice.count()) await choice.click();
          await page.waitForTimeout(150);
          row.overflow = await page.evaluate(() =>
            Math.max(0, document.documentElement.scrollWidth - innerWidth),
          );
          assert.ok(row.overflow <= 1, `Horizontal overflow ${row.overflow}px`);
          row.height = await page.evaluate(() => document.documentElement.scrollHeight);
          if (
            [
              '/',
              '/categories/',
              '/collections/',
              '/create/',
              '/clipart/baby/',
              '/art/baby-pumpkin-costume-clipart/',
            ].includes(path)
          )
            await page.screenshot({
              path: `${out}/${engine}-${width}-${path === '/' ? 'home' : path.replaceAll('/', '_')}.png`,
            });
          const pictures = page.locator(
            'main img[src^="https://assets.ultraclipart.com/"], .footer-art-paper img',
          );
          if (await pictures.count()) {
            for (const image of [pictures.first(), pictures.last()]) {
              // WebKit cannot scroll a skipped descendant of content-visibility
              // into view directly. Scroll the reserved frame, as a visitor does.
              await image.evaluate((img) => {
                let frame = img.parentElement;
                while (frame && getComputedStyle(frame).contentVisibility !== 'auto')
                  frame = frame.parentElement;
                (frame || img).scrollIntoView({ block: 'center' });
              });
              await expect
                .poll(() => image.evaluate((n) => n.complete && n.naturalWidth > 0), {
                  timeout: 20000,
                })
                .toBe(true);
            }
          }
          assert.deepEqual(errors, []);
          row.ok = true;
        } catch (error) {
          row.error = String(error);
          row.errors = errors;
          await page
            .screenshot({
              path: `${out}/failure-${engine}-${width}-${path.replaceAll('/', '_').replaceAll('?', '_')}.png`,
            })
            .catch(() => {});
        }
        rows.push(row);
        writeFileSync(`${out}/report.json`, JSON.stringify(rows, null, 2));
        console.log(JSON.stringify(row));
        await context.close();
      }
  } finally {
    await browser.close();
  }
}
if (rows.some((r) => !r.ok)) process.exitCode = 1;
