import { chromium, webkit, expect } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import AxeBuilder from '@axe-core/playwright';
import { inspectLayout } from '../helpers/layout-audit.mjs';
const base = process.env.BASE_URL || 'http://127.0.0.1:4323';
const engine = process.env.UC_BROWSER || 'chromium';
const out = process.env.EVIDENCE_DIR || `reports/layout-states/${engine}`;
mkdirSync(out, { recursive: true });
const browser = await { chromium, webkit }[engine].launch();
const context = await browser.newContext({ reducedMotion: 'reduce', hasTouch: true });
// Localhost is not an allowed production CDN origin. Keep UI layout checks
// deterministic while the delivery suite verifies the real R2 CORS response.
const shareFixture = readFileSync(
  new URL('../../public/catalog/wave_003/winter-arctic-fox-resting.webp', import.meta.url),
);
assert.equal(
  createHash('sha256').update(shareFixture).digest('hex').slice(0, 16),
  'bcd9ea9b093fb409',
);
await context.route(
  'https://assets.ultraclipart.com/winter/winter-arctic-fox-resting.webp.*',
  (route) =>
    route.fulfill({
      body: shareFixture,
      contentType: 'image/webp',
      headers: { 'Access-Control-Allow-Origin': '*' },
    }),
);
const page = await context.newPage();
page.setDefaultTimeout(18000);
const report = {
  engine,
  date: new Date().toISOString(),
  states: [],
  errors: [],
  requests: [],
  shareImageTransport: 'Verified local original fixture; CDN CORS tested separately',
};
page.on('pageerror', (e) => report.errors.push({ url: page.url(), message: e.message }));
page.on('request', (r) => {
  if (!['GET', 'HEAD'].includes(r.method()))
    report.requests.push({ url: r.url(), method: r.method() });
});
async function go(route) {
  await page.goto(base + route, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => document.fonts.ready);
  const cookie = page.locator('[data-cookie-choice="necessary"]:visible').first();
  if (await cookie.count()) await cookie.click();
}
async function snapshot(name, target) {
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  const state = {
    name,
    route: page.url().replace(base, ''),
    viewportHeight: page.viewportSize().height,
    ...(await page.evaluate(inspectLayout)),
  };
  const scope = target ? page.locator(target) : page.locator('body');
  state.innerOverflow = await scope.evaluateAll((nodes) =>
    nodes
      .map((el) => ({
        selector: el.id || el.className,
        width: el.clientWidth,
        scroll: el.scrollWidth,
      }))
      .filter((v) => v.scroll > v.width + 2),
  );
  if (target) await scope.first().scrollIntoViewIfNeeded();
  if (process.env.UC_AXE === '1') {
    const result = await new AxeBuilder({ page })
      .setLegacyMode(engine === 'webkit')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    state.accessibility = result.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n) => ({ target: n.target, reason: n.failureSummary })),
    }));
  }
  await page.screenshot({ path: `${out}/${name}-${page.viewportSize().width}.png` });
  report.states.push(state);
  writeFileSync(out + '/report.json', JSON.stringify(report, null, 2));
  console.log(
    `${name} ${state.width}: overflow=${state.horizontalOverflow}, clipped=${state.clipped.length}, inner=${state.innerOverflow.length}`,
  );
}
async function scenario(name, run) {
  try {
    await run();
  } catch (e) {
    report.errors.push({ name, width: page.viewportSize().width, message: e.message });
    console.log(`ERROR ${name}: ${e.message.slice(0, 200)}`);
  }
}
try {
  const viewports = process.env.UC_VIEWPORTS
    ? JSON.parse(process.env.UC_VIEWPORTS)
    : (process.env.UC_WIDTHS || '320,390,768,1440')
        .split(',')
        .map((width) => ({ width: Number(width), height: 900 }));
  for (const { width, height } of viewports) {
    await page.setViewportSize({ width, height });
    await scenario('navigation', async () => {
      await go('/');
      const menu = page.locator('.site-menu-button');
      if (await menu.isVisible()) await menu.click();
      else await page.locator('#site-browse-toggle').click();
      await snapshot('browse-open', '.site-header');
      await page.keyboard.press('Escape');
      if (await menu.isVisible()) await menu.click();
      else await page.locator('#site-resources-toggle').click();
      await snapshot('resources-open', '.site-header');
      await page.keyboard.press('Escape');
      await go('/cookies/');
      await page.locator('#cookie-preferences [data-cookie-settings]').click();
      await snapshot('cookies-open', 'dialog[open]');
      await page.keyboard.press('Escape');
    });
    await scenario('download-share', async () => {
      await go('/art/winter-arctic-fox-resting/');
      await page.locator('[data-download-open][data-download-format="webp"]').first().click();
      await expect(page.locator('#download-dialog [data-download-content]')).toBeVisible();
      await page.locator('.download-panel-technical summary').click();
      await snapshot('download-details', '#download-dialog');
      await page.keyboard.press('Escape');
      await page.locator('[data-share-art]').first().click();
      await expect(page.locator('dialog.uc-share')).toBeVisible();
      await snapshot('share-open', 'dialog.uc-share');
      await page.locator('.uc-share-owned summary').click();
      await snapshot('share-keys', 'dialog.uc-share');
      await page.keyboard.press('Escape');
    });
    await scenario('boards', async () => {
      await go('/favorites/');
      await page.locator('[data-board-create]').click();
      await snapshot('board-form', '#board-dialog');
      await page.keyboard.press('Escape');
    });
    await scenario('ai-choices', async () => {
      await go('/ai-clipart-generator/');
      await page.locator('[data-ai-show-styles]').click();
      await expect(page.locator('#ai-choice-dialog')).toBeVisible();
      await snapshot('ai-styles', '#ai-choice-dialog');
      await page.keyboard.press('Escape');
      await page.getByText('More Colors & Custom HEX', { exact: true }).click();
      await snapshot('ai-colors', '.ai-build-controls');
      await page.getByText('Fine-tune your idea & generation settings', { exact: true }).click();
      await snapshot('ai-settings', '.ai-build-controls');
    });
    await scenario('studio', async () => {
      await go('/create/');
      await page.locator('.uc-editor').scrollIntoViewIfNeeded();
      await expect(page.locator('.uc-workspace')).not.toHaveAttribute('inert', '');
      const options = await page
        .locator('.uc-tools [data-panel]')
        .evaluateAll((items) => items.map((button) => button.dataset.panel));
      for (const panel of options) {
        await page.locator(`.uc-tools [data-panel="${panel}"]`).click();
        await snapshot('studio-' + panel, '.uc-properties');
      }
    });
  }
} finally {
  report.summary = {
    states: report.states.length,
    overflow: report.states.filter((s) => s.horizontalOverflow).length,
    clipped: report.states.filter((s) => s.clipped.length).length,
    innerOverflow: report.states.filter((s) => s.innerOverflow.length).length,
    errors: report.errors.length,
    accessibility:
      process.env.UC_AXE === '1'
        ? report.states.filter((s) => s.accessibility?.length).length
        : null,
  };
  writeFileSync(out + '/report.json', JSON.stringify(report, null, 2));
  console.log(report.summary);
  await browser.close();
}

if (Object.entries(report.summary).some(([key, value]) => key !== 'states' && value))
  process.exitCode = 1;
