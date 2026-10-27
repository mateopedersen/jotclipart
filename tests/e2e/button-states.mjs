import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const base = process.env.BASE_URL || 'http://127.0.0.1:4323';
const out = process.env.EVIDENCE_DIR || 'reports/button-states';
await mkdir(out, { recursive: true });
const sourceCss =
  process.env.UC_SOURCE_SHARE_CSS === '1'
    ? await readFile(new URL('../../src/share/dialog.css', import.meta.url), 'utf8')
    : null;
const report = {
  base,
  sourceCssOverride: !!sourceCss,
  started: new Date().toISOString(),
  states: [],
  errors: [],
};
const imageFixture = await readFile(
  new URL(
    '../../public/catalog/donald-trump/donald-trump-architectural-blueprint-clipart.webp',
    import.meta.url,
  ),
);
assert.equal(
  createHash('sha256').update(imageFixture).digest('hex'),
  'ac7bfa43a34097c98893c41d9345c38f0c8a0d9f10112b62b69c1568448d6308',
);
report.imageTransport = 'Checksum-verified original fixture; CDN CORS is tested separately.';

function appearance(button) {
  const css = getComputedStyle(button);
  const rgb = (value) => value.match(/[\d.]+/g).map(Number);
  const luminance = (color) =>
    rgb(color)
      .slice(0, 3)
      .map((v) => {
        const n = v / 255;
        return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
      })
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const bg = css.backgroundColor;
  const a = luminance(css.color),
    b = luminance(bg);
  const rect = button.getBoundingClientRect();
  return {
    color: css.color,
    background: bg,
    opacity: css.opacity,
    contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
    width: rect.width,
    height: rect.height,
    clipped: button.scrollWidth > button.clientWidth + 1,
    outline: css.outlineStyle,
    iconColor: button.querySelector('svg')
      ? getComputedStyle(button.querySelector('svg')).color
      : null,
  };
}

for (const [engine, implementation] of Object.entries({ chromium, webkit })) {
  const browser = await implementation.launch();
  try {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
      Object.defineProperty(navigator, 'share', { configurable: true, value: async () => {} });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.route(
      'https://assets.ultraclipart.com/donald-trump/donald-trump-architectural-blueprint-clipart.webp.*',
      (route) =>
        route.fulfill({
          body: imageFixture,
          contentType: 'image/webp',
          headers: { 'Access-Control-Allow-Origin': '*' },
        }),
    );
    await page.route('**/api/share/**', (route) => route.abort());
    page.on('pageerror', (error) => report.errors.push({ engine, error: error.message }));
    await page.goto(base + '/art/donald-trump-architectural-blueprint-clipart/');
    if (sourceCss) await page.addStyleTag({ content: sourceCss });
    const cookie = page.locator('[data-cookie-choice="necessary"]:visible').first();
    if (await cookie.count()) await cookie.click();
    await page.locator('[data-share-art]').first().click();
    const dialog = page.locator('.uc-share');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.uc-share-native')).toBeEnabled({ timeout: 30000 });

    async function states(button, name, width) {
      const initial = await button.evaluate(appearance);
      for (const state of ['normal', 'hover', 'focus', 'active']) {
        await page.mouse.move(0, 0);
        await button.evaluate((node) => node.blur());
        if (state === 'hover' || state === 'active') await button.hover();
        if (state === 'focus') {
          await page.keyboard.press('Tab');
          await button.focus();
        }
        if (state === 'active') await page.mouse.down();
        const measured = await button.evaluate(appearance);
        // Suppress only this test click after measuring the real pressed state.
        // Releasing on the backdrop would close the native dialog.
        if (state === 'active') {
          await button.evaluate((node) =>
            node.addEventListener(
              'click',
              (event) => {
                event.preventDefault();
                event.stopImmediatePropagation();
              },
              { once: true, capture: true },
            ),
          );
          await page.mouse.up();
        }
        report.states.push({ engine, width, name, state, ...measured });
        assert.ok(
          measured.contrast >= 4.5,
          `${engine} ${width} ${name} ${state}: contrast ${measured.contrast}`,
        );
        assert.equal(measured.clipped, false, `${engine} ${width} ${name}: clipped text`);
        assert.ok(
          Math.abs(initial.width - measured.width) < 1 &&
            Math.abs(initial.height - measured.height) < 1,
          `${name}: hover changed dimensions`,
        );
        if (state === 'focus')
          assert.notEqual(measured.outline, 'none', `${name}: no keyboard focus`);
        if (measured.iconColor)
          assert.equal(measured.iconColor, measured.color, `${name}: icon/text color mismatch`);
      }
    }
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await states(dialog.locator('.uc-share-native'), 'Native Share', width);
      await states(dialog.locator('.uc-share-download'), 'Download', width);
      await states(dialog.locator('.uc-share-copy-link'), 'Copy Link', width);
      await dialog.screenshot({ path: `${out}/${engine}-share-${width}.png` });
      console.log(`${engine}: share buttons passed at ${width}px`);
    }
    // The public-link control uses the same stylesheet but is shown only for a
    // private composition. Exercise its CSS in the real dialog without publishing.
    await dialog.evaluate((node) => {
      const fixture = document.createElement('button');
      fixture.className = 'uc-share-publish-button';
      fixture.textContent = 'Create Public Link';
      fixture.dataset.appearanceFixture = 'true';
      node.querySelector('.uc-share-options').append(fixture);
    });
    const publish = dialog.locator('[data-appearance-fixture]');
    await page.setViewportSize({ width: 390, height: 900 });
    await states(publish, 'Publish CSS Fixture', 390);
    for (const button of [publish, dialog.locator('.uc-share-native')]) {
      await button.evaluate((node) => {
        node.disabled = true;
      });
      await button.hover({ force: true });
      const measured = await button.evaluate(appearance);
      report.states.push({
        engine,
        width: 390,
        name: 'Disabled CSS Fixture',
        state: 'hover',
        ...measured,
      });
      assert.ok(measured.contrast >= 4.5);
      assert.equal(measured.opacity, '1');
    }
    await context.close();
  } catch (error) {
    report.errors.push({ engine, error: error.stack });
  } finally {
    await browser.close();
  }
}
report.finished = new Date().toISOString();
report.passed = report.errors.length === 0;
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({ states: report.states.length, passed: report.passed, errors: report.errors }),
);
if (!report.passed) process.exitCode = 1;
