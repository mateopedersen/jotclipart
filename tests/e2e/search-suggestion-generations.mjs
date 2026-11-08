import { chromium } from '@playwright/test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
const require = createRequire(
  realpathSync(new URL('../../node_modules/astro/package.json', import.meta.url)),
);
const { build } = require('esbuild');
const compiled = await build({
  stdin: {
    contents:
      "import{initSearchSuggestions}from'./src/scripts/search-suggestions';initSearchSuggestions();",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
});
const actualSourceCode = compiled.outputFiles[0].text;
const out = 'work/quality/search-suggestion-generations';
fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const A = 'a'.repeat(64),
  B = 'b'.repeat(64),
  C = 'c'.repeat(64);
const manifest = (s) => ({
  schema: 1,
  version: s,
  ranking: 2,
  total: 1,
  pageChunk: 256,
  tokenBuckets: 256,
  lexiconLengths: [],
  facets: [],
  topics: [],
  site: 'site',
  transport: {
    protocol: 'snapshot-search-v1',
    endpoint: '/catalog-search.json',
    snapshot: s,
    directory: 'source-bound-site-v1',
  },
});
const entry = (s) => ({
  id: 'camera',
  kind: 'topic',
  title: 'Camera ' + s[0],
  description: 'Camera',
  text: 'camera',
  href: '/clipart/camera-' + s[0] + '/',
});
const result = (s, q) => ({
  schema: 1,
  snapshot: s,
  result: {
    manifest: manifest(s),
    items: [
      {
        id: q + '-' + s[0],
        title: q + ' ' + s[0],
        thumb: 'https://assets.ultraclipart.com/a.webp',
      },
    ],
    total: 1,
    pages: 1,
    page: 1,
    hasFuzzyMatches: false,
  },
});
const report = {
  scope: 'Private deterministic UI/backend race fixtures only; not live authority or performance.',
  cases: [],
};
try {
  for (const mode of ['stale-page-root', 'no-page-root-directory-race', 'cancel-old-query']) {
    const calls = [];
    let manifestReads = 0;
    const c = await b.newContext();
    await c.route('**/*', async (r) => {
      const u = new URL(r.request().url());
      if (u.hostname === 'assets.ultraclipart.com')
        return r.fulfill({
          status: 200,
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
        });
      if (u.pathname === '/')
        return r.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><meta name="catalog-snapshot" content="${mode === 'no-page-root-directory-race' ? '' : A}"><form action="/search/"><input name="q"></form><script type="module" src="/candidate.js"></script>`,
        });
      if (u.pathname === '/candidate.js')
        return r.fulfill({ contentType: 'text/javascript', body: actualSourceCode });
      calls.push({ path: u.pathname, body: r.request().postData() });
      const reply = (value) =>
        r.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
      if (u.pathname === '/search-data/manifest.json') {
        manifestReads++;
        return reply(
          manifest(
            mode === 'stale-page-root'
              ? B
              : mode === 'no-page-root-directory-race'
                ? manifestReads === 1
                  ? B
                  : C
                : A,
          ),
        );
      }
      if (u.pathname.match(/\/search-data\/[a-f0-9]{64}\/(?:site|navigation).json/)) {
        const s = u.pathname.split('/')[2];
        if (mode === 'no-page-root-directory-race' && s === B)
          await new Promise((r) => setTimeout(r, 400));
        return reply({ schema: 1, snapshot: s, result: [entry(s)] });
      }
      if (u.pathname === '/catalog-search.json') {
        const { snapshot: s, state } = JSON.parse(r.request().postData());
        if (
          (mode === 'stale-page-root' && s === A) ||
          (mode === 'no-page-root-directory-race' && s === B)
        )
          return r.fulfill({
            status: 409,
            contentType: 'application/json',
            body: '{"error":"catalog_changed"}',
          });
        if (mode === 'cancel-old-query' && state.q === 'camera')
          await new Promise((r) => setTimeout(r, 350));
        return reply(result(s, state.q));
      }
      return r.fulfill({ status: 404, body: '' });
    });
    const p = await c.newPage();
    await p.goto('https://fixture.invalid/');
    const input = p.locator('input');
    await input.fill('camera');
    if (mode === 'cancel-old-query') {
      await p.waitForRequest((r) => r.url().endsWith('/catalog-search.json'));
      await input.fill('dog');
      await p.locator('.search-suggestions a[href="/art/dog-a/"]').waitFor();
      await p.waitForTimeout(500);
      assert.equal(await p.locator('.search-suggestions a[href^="/art/camera-"]').count(), 0);
    } else {
      const expected = mode === 'stale-page-root' ? B : C;
      await p.locator(`.search-suggestions a[href="/art/camera-${expected[0]}/"]`).waitFor();
      await p.locator(`.search-suggestions a[href="/clipart/camera-${expected[0]}/"]`).waitFor();
      assert.equal(
        await p.locator(`.search-suggestions a[href="/clipart/camera-${expected[0]}/"]`).count(),
        1,
      );
      if (expected === C)
        assert.equal(
          await p.locator('.search-suggestions a[href="/clipart/camera-b/"]').count(),
          0,
        );
      const before = calls.length;
      await input.fill('cameras');
      await p.locator(`.search-suggestions a[href="/art/cameras-${expected[0]}/"]`).waitFor();
      const newer = calls.slice(before);
      assert.equal(newer.filter((x) => x.path === '/search-data/manifest.json').length, 0);
      assert(
        newer
          .filter((x) => x.path === '/catalog-search.json')
          .every((x) => JSON.parse(x.body).snapshot === expected),
      );
    }
    report.cases.push({ mode, passed: true, manifestReads, calls });
    await c.close();
  }
  report.status = 'PRIVATE_DIRECTORY_GENERATION_AND_ABORT_UI_REGRESSIONS_PASSED';
} catch (e) {
  report.status = 'PRIVATE_GENERATION_TEST_FAILED';
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  await b.close();
  fs.writeFileSync(out + '/report.json', JSON.stringify(report, null, 2));
}
console.log(
  JSON.stringify({ status: report.status, cases: report.cases.length, error: report.error }),
);
