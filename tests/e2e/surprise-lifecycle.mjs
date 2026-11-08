// Controlled delayed-index fixture and genuine native navigation, not a CDN speed benchmark.
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium, firefox, webkit, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const out = process.env.UC_LIFECYCLE_REPORT ?? 'reports/surprise-lifecycle';
mkdirSync(out, { recursive: true });
const client = (
  await build({
    stdin: {
      contents: "import{initCuteSurprise}from'./src/scripts/cute-surprise.ts';initCuteSurprise();",
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    write: false,
  })
).outputFiles[0].text;
let pendingIndex,
  mode = '';
const server = createServer(async (req, res) => {
  res.setHeader(
    'content-type',
    req.url === '/client.js'
      ? 'text/javascript'
      : req.url?.startsWith('/surprise-picks.json')
        ? 'application/json'
        : 'text/html',
  );
  if (req.url === '/client.js') return res.end(client);
  if (req.url?.startsWith('/surprise-picks.json')) {
    pendingIndex = () => {
      res.statusCode = mode === 'departure-failed' ? 503 : 200;
      res.end(JSON.stringify({ version: 3, items: [{ id: 'bravo', topic: 'dog' }] }));
    };
    return;
  }
  if (req.url === '/depart/') {
    await new Promise((r) => setTimeout(r, 100));
    pendingIndex?.();
    await new Promise((r) => setTimeout(r, 700));
    return res.end('<h1>Destination</h1>');
  }
  if (req.url?.startsWith('/art/')) return res.end('<h1>Actual fallback destination</h1>');
  res.end(
    `<!doctype html><a data-surprise-art='[{"id":"alpha","topic":"cat"}]' data-surprise-source='/surprise-picks.json' href='/art/alpha/'>Surprise</a><a id='depart' href='/depart/'>Native departure</a><a id='hash' href='#details'>Same document</a><a id='new-tab' href='/depart/' target='_blank'>New tab</a><p id='details'>Details</p><script type='module' src='/client.js'></script>`,
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port,
  rows = [],
  selectedEngines = (process.env.UC_LIFECYCLE_ENGINES ?? 'chromium,firefox,webkit').split(',');
assert(
  selectedEngines.length &&
    selectedEngines.every((e) => ['chromium', 'firefox', 'webkit'].includes(e)),
);
const expectedCases = new Set(selectedEngines).size * 12;
let environmentError;
const saveReport = () =>
  writeFileSync(
    out + '/report.json',
    JSON.stringify(
      {
        scope:
          'Controlled delayed JSON, original source module and real native browser navigation. Not a live CDN speed benchmark. BFCache persistence is recorded, never presumed.',
        expectedCases,
        completedCases: rows.length,
        environmentError,
        passed: !environmentError && rows.length === expectedCases && rows.every((r) => r.passed),
        rows,
      },
      null,
      2,
    ),
  );
try {
  for (const [engine, type] of Object.entries({ chromium, firefox, webkit })) {
    if (!selectedEngines.includes(engine)) continue;
    const browser = await type.launch(
      engine === 'chromium'
        ? {
            executablePath:
              process.env.UC_CHROME_PATH ??
              '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          }
        : {},
    );
    try {
      for (const width of [390, 1440])
        for (const scenario of [
          'departure-failed',
          'departure-success',
          'prevented',
          'same-document',
          'new-tab',
          'restored',
        ]) {
          mode = scenario;
          pendingIndex = undefined;
          const context = await browser.newContext({
              viewport: { width, height: 844 },
              hasTouch: width === 390,
            }),
            page = await context.newPage(),
            events = [],
            errors = [],
            start = Date.now();
          await context.addInitScript(() => {
            window.__lifecyclePageShows = [];
            addEventListener('pageshow', (e) => window.__lifecyclePageShows.push(e.persisted));
          });
          page.on('pageerror', (e) => errors.push(e.message));
          page.on('request', (r) =>
            events.push({
              url: r.url(),
              at: Date.now() - start,
              resource: r.resourceType(),
              navigation: r.isNavigationRequest(),
            }),
          );
          const row = { engine, width, scenario, errors, events, passed: false };
          try {
            await page.goto(base, { waitUntil: 'domcontentloaded' });
            await expect.poll(() => !!pendingIndex).toBe(true);
            if (scenario === 'prevented')
              await page
                .locator('#depart')
                .evaluate((link) => link.addEventListener('click', (e) => e.preventDefault()));
            const clickAt = Date.now() - start;
            if (scenario === 'new-tab') {
              const popupPromise = page.waitForEvent('popup');
              await page.locator('#new-tab').click();
              const popup = await popupPromise;
              await expect(popup.locator('h1')).toHaveText('Destination');
              await popup.close();
            } else if (scenario === 'same-document') {
              await page.locator('#hash').click();
              pendingIndex();
            } else {
              await page.locator('#depart').click();
              if (scenario === 'prevented') pendingIndex();
            }
            if (scenario.startsWith('departure-') || scenario === 'restored') {
              await expect(page.locator('h1')).toHaveText('Destination');
              assert.deepEqual(
                events.filter((e) => e.url.includes('/art/') && e.at >= clickAt),
                [],
                'A departed document cannot start optional artwork warming',
              );
              if (scenario === 'restored') {
                await page.goBack({ waitUntil: 'domcontentloaded' });
                await expect(page.locator('html')).toHaveAttribute(
                  'data-surprise-navigation',
                  'ready',
                );
                row.persistedPageShows = await page.evaluate(() => window.__lifecyclePageShows);
                const link = page.locator('[data-surprise-art]');
                await link.focus();
                const href = await link.getAttribute('href');
                await link.click();
                await page.waitForURL(base + href);
                await expect(page.locator('h1')).toHaveText('Actual fallback destination');
              }
            } else {
              await expect(page.locator('[data-surprise-art]')).toHaveAttribute(
                'href',
                '/art/bravo/',
              );
              await expect
                .poll(
                  () =>
                    events.filter((e) => e.url.includes('/art/bravo/') && e.resource === 'fetch')
                      .length,
                )
                .toBe(1);
              assert(
                new URL(page.url()).pathname === '/',
                'Non-departing gestures preserve the active document',
              );
            }
            assert.deepEqual(errors, [], 'No swallowed or transition-time page errors are allowed');
            row.passed = true;
          } catch (error) {
            row.error = error.message;
          } finally {
            rows.push(row);
            await context.close();
            saveReport();
          }
          console.log(JSON.stringify({ ...row, events: undefined }));
        }
    } finally {
      await browser.close();
    }
  }
} catch (error) {
  environmentError = error.message;
  throw error;
} finally {
  await new Promise((r) => server.close(r));
  saveReport();
}
assert.equal(rows.length, expectedCases);
assert(rows.every((r) => r.passed));
