import AxeBuilder from '@axe-core/playwright';
// Explicit network fixtures test scheduling and failure recovery, not CDN speed.
import { chromium, webkit, firefox, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { build } from 'esbuild';
import { siteNavigationScript } from '../../src/lib/site-navigation-inline.mjs';
const folder = resolve(process.env.EVIDENCE_DIR ?? 'reports/original-image-scheduling');
mkdirSync(folder, { recursive: true });
const bytes = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#286fc1' } })
  .webp({ lossless: true })
  .toBuffer();
const client = (
  await build({
    stdin: {
      contents:
        'import{initOriginalImageLoading}from"./src/scripts/original-image-loading.ts";initOriginalImageLoading(document,{retryDelays:[20,60],stallMs:300});',
      resolveDir: process.cwd(),
    },
    write: false,
    bundle: true,
    format: 'esm',
  })
).outputFiles[0].contents;
const css = readFileSync('src/styles/original-image-loading.css', 'utf8');
const html =
  '<!doctype html><html><head><script>' +
  siteNavigationScript +
  '</script><style>' +
  css +
  '.grid{display:grid;grid-template-columns:repeat(4,100px);gap:10px}.art-picture{width:100px;height:100px;aspect-ratio:1;display:block;position:relative}.art-picture img{width:100%;height:100%;object-fit:contain}.space{height:900px}</style></head><body><div class="grid">' +
  Array.from(
    { length: 80 },
    (_, i) =>
      '<a class="art-picture" aria-label="Explicit fixture ' +
      i +
      '" href="/art/fixture-' +
      i +
      '/"><img src="https://assets.ultraclipart.com/fixture/scheduled-' +
      i +
      '.webp" alt="Explicit fixture ' +
      i +
      '" loading="lazy" data-original-deferred="pending" width="100" height="100"></a>',
  ).join('') +
  '</div><script type="module" src="/client.js"></script></body></html>';
// Actual category CSS reserves the artwork track while original bytes are pending.
const categoryCSS = readFileSync('src/styles/categories.css', 'utf8');
const categoryHTML =
  '<!doctype html><html><head><meta name="viewport" content="width=device-width"><script>' +
  siteNavigationScript +
  '</script><style>' +
  css +
  categoryCSS +
  '</style></head><body><div class="category-discovery"><header class="discovery-hero"><div>Explicit geometry fixture</div><div class="discovery-moodboard">' +
  Array.from(
    { length: 4 },
    (_, i) =>
      '<a class="discovery-scene-card" href="/art/fixture-' +
      i +
      '/" aria-label="Explicit fixture ' +
      i +
      '"><img src="https://assets.ultraclipart.com/fixture/category-' +
      i +
      '.webp" alt="Explicit fixture ' +
      i +
      '" width="155" height="140" loading="lazy" data-original-deferred="pending"><span>Fixture ' +
      i +
      '</span></a>',
  ).join('') +
  '</div></header></div></body></html>';
const token = "'sha256-" + createHash('sha256').update(siteNavigationScript).digest('base64') + "'";
const server = createServer((q, r) => {
  r.setHeader('Content-Type', q.url === '/client.js' ? 'text/javascript' : 'text/html');
  r.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src https://assets.ultraclipart.com; style-src 'self' 'unsafe-inline'; script-src 'self' " +
      token,
  );
  r.end(q.url === '/client.js' ? client : q.url === '/category-frames' ? categoryHTML : html);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
let completed = false;
const report = {
  at: new Date().toISOString(),
  scope: 'Explicit delayed-network fixtures; unchanged original URLs and existing retry controller',
  cases: [],
};
try {
  for (const [name, type] of Object.entries(
    process.env.UC_BROWSER
      ? { [process.env.UC_BROWSER]: { chromium, webkit, firefox }[process.env.UC_BROWSER] }
      : { chromium, webkit },
  )) {
    const browser = await type.launch(
      name === 'chromium' && process.env.UC_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.UC_CHROMIUM_EXECUTABLE_PATH }
        : {},
    );
    try {
      for (const scenario of [
        'healthy',
        'slow-scroll',
        'transient',
        'permanent',
        'no-io',
        'no-javascript',
        'constructor-failure',
        'watchdog',
        'watchdog-deep',
        'dynamic',
        'replacement',
        'back-forward',
        'false-offline-hint',
        'late-false-offline-hint',
        'print',
      ]) {
        const context = await browser.newContext({
            viewport: { width: 440, height: 350 },
            javaScriptEnabled: scenario !== 'no-javascript',
          }),
          page = await context.newPage();
        const attempts = new Map(),
          errors = [];
        let active = 0,
          peak = 0;
        page.on('pageerror', (e) => errors.push(e.message));
        if (scenario === 'no-io')
          await context.addInitScript(() => {
            window.IntersectionObserver = undefined;
          });
        if (['watchdog', 'watchdog-deep'].includes(scenario))
          await context.addInitScript(() => {
            window.IntersectionObserver = class {
              observe() {}
              unobserve() {}
              disconnect() {}
            };
          });
        if (scenario === 'back-forward')
          await context.addInitScript(() => {
            window.__pageshows = [];
            addEventListener('pageshow', (e) => window.__pageshows.push(e.persisted));
          });
        if (scenario === 'constructor-failure')
          await context.addInitScript(() => {
            window.IntersectionObserver = class {
              constructor() {
                throw Error('Explicit unsupported fixture');
              }
            };
          });
        await context.route('https://assets.ultraclipart.com/**', async (route) => {
          const url = route.request().url(),
            n = (attempts.get(url) ?? 0) + 1;
          attempts.set(url, n);
          active++;
          peak = Math.max(peak, active);
          try {
            await new Promise((r) =>
              setTimeout(r, scenario === 'slow-scroll' && url.includes('scheduled-0.') ? 1000 : 80),
            );
            await route.fulfill(
              (scenario === 'permanent' || (scenario === 'transient' && n === 1)) &&
                url.includes('scheduled-0.')
                ? { status: 503, body: 'Explicit failure fixture' }
                : { status: 200, contentType: 'image/webp', body: bytes },
            );
          } finally {
            active--;
          }
        });
        // The fixture network stays reachable. A false OS/browser hint must not
        // gate originals or require an online event to recover visible content.
        if (scenario === 'late-false-offline-hint') {
          await context.addInitScript(() => {
            Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
          });
        }
        if (scenario === 'false-offline-hint') {
          await context.addInitScript(() => {
            Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
          });
        }
        await page.goto('http://127.0.0.1:' + server.address().port, {
          waitUntil: 'domcontentloaded',
        });
        const frames = await page
          .locator('.art-picture')
          .evaluateAll((xs) => xs.map((x) => ({ width: x.offsetWidth, height: x.offsetHeight })));
        if (scenario === 'late-false-offline-hint') {
          assert.equal(await page.evaluate(() => navigator.onLine), true);
          await expect.poll(() => attempts.size).toBeGreaterThan(0);
          await page.evaluate(() => {
            Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
            dispatchEvent(new Event('offline'));
            // Expose another row while preserving overlap with the first viewport.
            scrollTo(0, 220);
          });
        }
        if (['false-offline-hint', 'late-false-offline-hint'].includes(scenario)) {
          await expect(page.locator('html')).toHaveAttribute('data-original-scheduling', 'active');
          assert.equal(await page.evaluate(() => navigator.onLine), false);
        }
        if (scenario === 'watchdog-deep') await page.evaluate(() => scrollTo(0, 1800));
        if (scenario === 'slow-scroll') await page.evaluate(() => scrollTo(0, 700));
        if (scenario === 'print')
          await page.evaluate(() => dispatchEvent(new Event('beforeprint')));
        if (scenario === 'replacement')
          await page.evaluate(() => {
            const i = document.querySelectorAll('.art-picture img')[35];
            i.src = 'https://assets.ultraclipart.com/fixture/replacement.webp';
            i.scrollIntoView();
          });
        if (scenario === 'dynamic')
          await page.evaluate(() => {
            const f = document.createElement('a');
            f.className = 'art-picture';
            f.href = '/art/dynamic/';
            f.setAttribute('aria-label', 'Explicit dynamic fixture');
            const i = document.createElement('img');
            i.dataset.originalDeferred = 'pending';
            i.loading = 'lazy';
            i.alt = 'Explicit dynamic fixture';
            i.width = i.height = 100;
            i.src = 'https://assets.ultraclipart.com/fixture/dynamic.webp';
            f.append(i);
            document.querySelector('.grid').prepend(f);
          });
        await expect
          .poll(
            () =>
              page.locator('.art-picture').evaluateAll(
                (xs, allowFailure) =>
                  xs
                    .filter((x) => {
                      const r = x.getBoundingClientRect();
                      return r.bottom > 0 && r.top < innerHeight;
                    })
                    .every((x) => {
                      const i = x.querySelector('img');
                      return (
                        (allowFailure &&
                          i.src.includes('scheduled-0.') &&
                          i.dataset.originalImageState === 'error' &&
                          i.dataset.originalDeferred === 'open') ||
                        (i.complete && i.naturalWidth > 0)
                      );
                    }),
                scenario === 'permanent',
              ),
            { timeout: 15000 },
          )
          .toBe(true);
        if (
          ![
            'no-io',
            'no-javascript',
            'constructor-failure',
            'watchdog',
            'watchdog-deep',
            'print',
          ].includes(scenario)
        ) {
          assert(peak <= 6, 'No native offscreen request flood: ' + peak);
          assert(attempts.size < 40, 'The complete offscreen gallery must not be prefetched');
        }
        if (scenario === 'permanent') {
          await expect(page.locator('.art-picture img').first()).toHaveAttribute(
            'data-original-image-state',
            'error',
          );
          await expect(page.locator('.original-image-status')).toHaveText(
            'Image unavailable. Open artwork.',
          );
          assert.equal(attempts.get('https://assets.ultraclipart.com/fixture/scheduled-0.webp'), 3);
        }
        if (scenario === 'transient')
          assert.equal(attempts.get('https://assets.ultraclipart.com/fixture/scheduled-0.webp'), 2);
        if (scenario === 'slow-scroll') {
          await page.waitForTimeout(1100);
          assert.equal(
            attempts.get('https://assets.ultraclipart.com/fixture/scheduled-0.webp'),
            1,
            'Healthy slow transfer retains progress',
          );
        }
        if (scenario === 'print')
          await expect
            .poll(() =>
              page
                .locator('.art-picture img')
                .evaluateAll((xs) => xs.every((i) => i.complete && i.naturalWidth > 0)),
            )
            .toBe(true);
        const initialPeak = peak;
        if (scenario === 'back-forward') {
          await page.waitForTimeout(200);
          await page.goto('about:blank');
          await page.goBack({ waitUntil: 'domcontentloaded' });
          await expect
            .poll(() =>
              page
                .locator('.art-picture img')
                .first()
                .evaluate((i) => i.complete && i.naturalWidth > 0),
            )
            .toBe(true);
        }
        assert.equal(errors.length, 0, JSON.stringify(errors));
        // Axe injects executable code and cannot finish with JavaScript disabled.
        // Native accessible-name checks remain required for that case.
        await expect(page.locator('.art-picture').first()).toHaveAccessibleName(/Explicit/);
        const names = await page.locator('.art-picture').evaluateAll((xs) =>
          xs.map((a) => ({
            name: a.getAttribute('aria-label'),
            expected: a.querySelector('img').alt,
          })),
        );
        assert(names.every((x) => x.name === x.expected && x.name.trim()));
        if (scenario !== 'no-javascript') {
          const accessibility = await new AxeBuilder({ page }).withRules(['link-name']).analyze();
          assert.deepEqual(accessibility.violations, []);
        }

        const after = await page
          .locator('.art-picture')
          .evaluateAll((xs) => xs.map((x) => ({ width: x.offsetWidth, height: x.offsetHeight })));
        assert(after.every((x) => x.width === 100 && x.height === 100));
        assert(frames.every((x) => x.width === 100 && x.height === 100));
        const urls = await page.locator('.art-picture img').evaluateAll((xs) =>
          xs.map((i) => ({
            src: i.getAttribute('src'),
            current: i.currentSrc,
            alt: i.alt,
            loaded: i.complete && i.naturalWidth > 0,
          })),
        );
        assert(
          urls.every(
            (i) =>
              i.src.startsWith('https://assets.ultraclipart.com/fixture/') &&
              (!i.current || i.current === i.src) &&
              i.alt,
          ),
        );
        assert(urls.filter((i) => i.loaded).every((i) => i.current === i.src));
        report.cases.push({
          engine: name,
          scenario,
          passed: true,
          peakConcurrent: peak,
          initialPeakConcurrent: initialPeak,
          requested: attempts.size,
          attempts: Object.fromEntries(attempts),
          stableFrames: true,
          originalURLs: true,
          ...(scenario === 'back-forward'
            ? { pageshows: await page.evaluate(() => window.__pageshows) }
            : {}),
          errors,
        });
        console.log(
          JSON.stringify({
            engine: name,
            scenario,
            passed: true,
            initialPeak,
            peak,
            requests: attempts.size,
          }),
        );
        await page.screenshot({ path: resolve(folder, name + '-' + scenario + '.png') });
        await context.close();
      }
      for (const width of [390, 1440]) {
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        try {
          await context.addInitScript(() =>
            Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }),
          );
          let releaseImages, requested = 0;
          const imageGate = new Promise((resolve) => { releaseImages = resolve; });
          await context.route('https://assets.ultraclipart.com/**', async (route) => {
            requested++;
            await imageGate;
            await route.fulfill({ status: 200, contentType: 'image/webp', body: bytes });
          });
          const page = await context.newPage();
          await page.goto('http://127.0.0.1:' + server.address().port + '/category-frames', {
            waitUntil: 'domcontentloaded',
          });
          const cards = page.locator('.discovery-scene-card');
          await expect(cards.locator('img')).toHaveCount(4);
          await expect.poll(() => requested).toBeGreaterThan(0);
          assert.equal(await cards.locator('img').evaluateAll((xs) => xs.some((i) => i.complete && i.naturalWidth > 0)), false);
          const before = await cards.evaluateAll((xs) =>
            xs.map((x) => ({ width: x.offsetWidth, height: x.offsetHeight })),
          );
          await expect(page.locator('html')).toHaveAttribute('data-original-scheduling', 'active');
          assert.equal(await page.evaluate(() => navigator.onLine), false);
          releaseImages();
          await expect
            .poll(() =>
              page
                .locator('img')
                .evaluateAll((xs) => xs.every((i) => i.complete && i.naturalWidth > 0)),
            )
            .toBe(true);
          const after = await cards.evaluateAll((xs) =>
            xs.map((x) => ({ width: x.offsetWidth, height: x.offsetHeight })),
          );
          assert.deepEqual(
            after,
            before,
            'Category artwork space stays reserved before original requests start',
          );
          assert(before.every((x) => x.width > 0 && x.height > 0));
          report.cases.push({
            engine: name,
            scenario: 'category-reserved-frame',
            width,
            before,
            after,
            passed: true,
          });
          console.log(
            JSON.stringify({
              engine: name,
              scenario: 'category-reserved-frame',
              width,
              passed: true,
            }),
          );
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
  completed = true;
} finally {
  server.close();
  writeFileSync(
    resolve(folder, 'report.json'),
    JSON.stringify(
      {
        ...report,
        passed: completed && report.cases.length > 0 && report.cases.every((x) => x.passed),
      },
      null,
      2,
    ),
  );
}
