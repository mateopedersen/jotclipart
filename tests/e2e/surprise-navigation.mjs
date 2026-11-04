// Explicit synthetic network/HTML fixture. Live CDN and publication proof are separate.
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const out = resolve(process.env.UC_SURPRISE_REPORT ?? 'reports/surprise-navigation');
mkdirSync(out, { recursive: true });
const compile = async (contents) =>
  (
    await build({
      stdin: { contents, resolveDir: process.cwd(), loader: 'ts' },
      bundle: true,
      format: 'esm',
      write: false,
    })
  ).outputFiles[0].text;
const client = await compile(
  "import{initCuteSurprise}from'./src/scripts/cute-surprise.ts';import{initNavigationWarmth}from'./src/scripts/navigation-warmth.ts';initCuteSurprise();initNavigationWarmth();",
);
const policy = await compile("export{surpriseWarmImages}from'./src/lib/surprise-navigation.ts';");
const asset = (id) => 'https://assets.ultraclipart.com/explicit-fixture/' + id + '.webp';
const thumb = (id) => 'https://assets.ultraclipart.com/explicit-fixture/' + id + '-thumbnail.webp';
const records = [
  { id: 'alpha', topic: 'cat' },
  { id: 'bravo', topic: 'dog' },
];
const detail = (id) =>
  `<!doctype html><html><head><link rel="canonical" href="https://ultraclipart.com/art/${id}/"><script type="application/ld+json">${JSON.stringify({ '@type': 'ImageObject', contentUrl: asset(id), url: 'https://ultraclipart.com/art/' + id + '/', mainEntityOfPage: 'https://ultraclipart.com/art/' + id + '/' })}</script></head><body><h1>Explicit synthetic ${id}</h1><a id="art-preview"><img width="100" height="100" alt="Synthetic fixture" src="${asset(id)}" data-original-placeholder="${thumb(id)}" data-original-placeholder-for="${asset(id)}"></a><img src="https://unexpected.invalid/never-requested.webp"></body></html>`;
let normalWarmRequests = [];
let mode = 'idle',
  warmRequests = [],
  firstDoc = true;
const server = createServer(async (req, res) => {
  if (req.url === '/client.js' || req.url === '/policy.js') {
    res.setHeader('Content-Type', 'text/javascript');
    return res.end(req.url === '/client.js' ? client : policy);
  }
  if (req.url.startsWith('/surprise-picks.json')) {
    if (mode === 'slow-index' || mode === 'touch') await new Promise((r) => setTimeout(r, 900));
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ version: 3, items: [records[1]] }));
  }
  if (req.url.startsWith('/clipart/')) {
    if (req.headers['sec-fetch-dest'] !== 'document') normalWarmRequests.push(req.url);
    res.setHeader('Content-Type', 'text/html');
    return res.end('<h1>Explicit normal navigation fixture</h1>');
  }
  const target = /^\/art\/(alpha|bravo)\/$/.exec(req.url);
  if (target) {
    const isWarm = req.headers['sec-fetch-dest'] !== 'document';
    if (isWarm) warmRequests.push(target[1]);
    if (isWarm && mode === 'failed-warm') {
      res.writeHead(503);
      return res.end('Unavailable');
    }
    if (mode === 'cold-baseline' && firstDoc) await new Promise((r) => setTimeout(r, 550));
    firstDoc = false;
    res.setHeader('Content-Type', 'text/html');
    return res.end(
      detail(target[1]).replace('<img src="https://unexpected.invalid/never-requested.webp">', ''),
    );
  }
  res.setHeader('Content-Type', 'text/html');
  res.end(
    `<!doctype html><html><body><a class="desktop" data-surprise-art='${JSON.stringify(records)}' data-surprise-source="/surprise-picks.json" href="/art/alpha/">Surprise me</a><a class="mobile" style="display:none" data-surprise-art="" data-surprise-source="/surprise-picks.json" href="/art/alpha/">Surprise me</a><a id="normal" href="/clipart/cat/">Cat</a><a id="excluded" href="/edit/alpha/">Editor</a><script type="module" src="/client.js"></script></body></html>`,
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({
  executablePath:
    process.env.UC_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const image = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#246ddb' } })
  .webp()
  .toBuffer();
const report = {
  scope:
    'Synthetic controlled browser fixture. Prefetched HTML is inert, original source stays canonical, and navigation never awaits warm/index work. Not a live speed benchmark.',
  cases: [],
  errors: [],
  status: 'RUNNING',
};
try {
  for (const scenario of [
    'idle',
    'slow-index',
    'touch',
    'failed-warm',
    'save-data',
    'nojs',
    'cold-baseline',
  ]) {
    mode = scenario;
    warmRequests = [];
    firstDoc = true;
    const context = await browser.newContext({
      viewport: { width: scenario === 'touch' ? 390 : 1440, height: 900 },
      hasTouch: scenario === 'touch',
      javaScriptEnabled: scenario !== 'nojs',
    });
    const page = await context.newPage(),
      unexpected = [];
    page.on('pageerror', (e) => report.errors.push(e.message));
    await context.route('https://assets.ultraclipart.com/**', (r) =>
      r.fulfill({ status: 200, contentType: 'image/webp', body: image }),
    );
    await context.route('https://unexpected.invalid/**', (r) => {
      unexpected.push(r.request().url());
      return r.abort();
    });
    await page.addInitScript(
      ({ save }) => {
        Object.defineProperty(crypto, 'getRandomValues', {
          value: (a) => {
            a.fill(0);
            return a;
          },
        });
        if (save)
          Object.defineProperty(navigator, 'connection', {
            value: { saveData: true, effectiveType: '4g' },
          });
      },
      { save: scenario === 'save-data' },
    );
    try {
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      if (scenario !== 'nojs')
        await expect(page.locator('html')).toHaveAttribute('data-surprise-navigation', 'ready');
      const link = page.locator('.desktop');
      if (scenario === 'idle') {
        await expect.poll(() => warmRequests.length).toBe(1);
        await expect(page.locator('link[data-surprise-warm]')).toHaveCount(2);
        assert.equal(await link.getAttribute('href'), '/art/bravo/');
        await page.waitForTimeout(250);
        assert.equal(warmRequests.length, 1);
      } else if (scenario === 'slow-index') {
        await link.focus();
        const stable = await link.getAttribute('href');
        await expect.poll(() => warmRequests.length).toBe(1);
        await page.waitForTimeout(1300);
        assert.equal(
          await link.getAttribute('href'),
          stable,
          'Late index cannot change a prepared destination',
        );
        assert.equal(await page.locator('.mobile').getAttribute('href'), stable);
      } else if (scenario === 'failed-warm') {
        await link.focus();
        await expect.poll(() => warmRequests.length).toBe(1);
        await expect(page.locator('link[data-surprise-warm]')).toHaveCount(0);
      } else if (scenario === 'save-data') {
        await link.focus();
        await page.waitForTimeout(500);
        assert.equal(warmRequests.length, 0);
      }
      const selected = await link.getAttribute('href'),
        start = Date.now();
      if (scenario === 'touch') await link.tap();
      else await link.click();
      await page.waitForURL(base + selected, { waitUntil: 'domcontentloaded' });
      const elapsed = Date.now() - start;
      await expect(page.locator('h1')).toBeVisible();
      const id = selected.split('/')[2];
      assert.equal(await page.locator('#art-preview img').getAttribute('src'), asset(id));
      assert.deepEqual(unexpected, [], 'Reading warmed HTML must not load its unrelated images');
      if (scenario === 'touch')
        assert(elapsed < 850, 'Touch navigation cannot await the deliberately slow index');
      report.cases.push({
        scenario,
        warmDocuments: warmRequests.length,
        clickToDocumentMs: elapsed,
        originalSourcePreserved: true,
        passed: true,
      });
    } finally {
      await context.close();
    }
  }
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    normalWarmRequests = [];
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator('#excluded').focus();
    await page.waitForTimeout(150);
    assert.equal(normalWarmRequests.length, 0);
    await page.locator('#normal').focus();
    await expect.poll(() => normalWarmRequests.length).toBe(1);
    await page.locator('#normal').press('Enter');
    await page.waitForURL('**/clipart/cat/');
    await expect(page.locator('h1')).toBeVisible();
    report.cases.push({ scenario: 'public-navigation-intent-and-editor-exclusion', passed: true });
    await context.close();
  }
  const page = await browser.newPage();
  await page.goto(base);
  const results = await page.evaluate(
    async ({ html, path }) => {
      const { surpriseWarmImages: parse } = await import('/policy.js');
      return {
        valid: parse(html, path),
        wrongCanonical: parse(
          html.replace(
            'https://ultraclipart.com/art/alpha/',
            'https://ultraclipart.com/art/bravo/',
          ),
          path,
        ),
        foreign: parse(html.replaceAll('assets.ultraclipart.com', 'foreign.invalid'), path),
        unbound: parse(html.replace('ImageObject', 'Thing'), path),
        foreignPath: parse(html, 'https://external.invalid/'),
        oversized: parse('x'.repeat(1024 * 1024 + 1), path),
      };
    },
    { html: detail('alpha'), path: '/art/alpha/' },
  );
  assert.deepEqual(results.valid, [thumb('alpha'), asset('alpha')]);
  for (const k of ['wrongCanonical', 'foreign', 'unbound', 'foreignPath', 'oversized'])
    assert.deepEqual(results[k], []);
  report.cases.push({ scenario: 'source-bound-hint-validation', passed: true });
  assert.deepEqual(report.errors, []);
  report.status = 'SURPRISE_NAVIGATION_SOURCE_AND_NONBLOCKING_BROWSER_GATES_PASSED';
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report));
