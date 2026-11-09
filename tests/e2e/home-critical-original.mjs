// Synthetic transfer timing; does not claim public CDN latency.
import { chromium, webkit, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { originalImageSchedulingScript } from '../../src/lib/original-image-scheduling-inline.mjs';
const sharp = createRequire(import.meta.resolve('astro/package.json'))('sharp'),
  bytes = await sharp({ create: { width: 80, height: 80, channels: 4, background: '#1765d1' } })
    .webp()
    .toBuffer(),
  css = readFileSync('src/styles/original-image-loading.css', 'utf8'),
  out = resolve(process.env.EVIDENCE_DIR || 'reports/home-critical-original');
mkdirSync(out, { recursive: true });
const server = createServer((req, res) => {
  const q = new URL(req.url, 'http://fixture'),
    marked = q.searchParams.get('marked') !== 'false',
    hidden = q.searchParams.get('hidden') === 'true';
  res.setHeader('Content-Type', 'text/html');
  res.end(
    '<!doctype html><html><head><meta name="viewport" content="width=device-width"><script>' +
      originalImageSchedulingScript +
      '</script><style>' +
      css +
      '.row{display:flex;gap:8px}.art-picture{width:100px;height:100px;display:block;position:relative;flex-shrink:0}.art-picture img{width:100%;height:100%;object-fit:contain}</style></head><body><div class="row">' +
      Array.from(
        { length: 4 },
        (_, i) =>
          '<a class="art-picture" style="' +
          (i === 0 && hidden ? 'display:none' : '') +
          '"><img width="100" height="100" loading="lazy" data-original-deferred="pending" ' +
          (i === 0 && marked ? 'data-home-critical="true"' : '') +
          ' src="https://assets.ultraclipart.com/fixture/' +
          i +
          '.webp" alt="Synthetic test ' +
          i +
          '"></a>',
      ).join('') +
      '</div></body></html>',
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const report = {
  scope: 'Source critical scheduler with explicit synthetic image timings; originals retained',
  cases: [],
  passed: false,
};
try {
  for (const [engine, type] of Object.entries({ chromium, webkit })) {
    const b = await type.launch({
      executablePath:
        engine === 'chromium'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : '/Users/melihozcan/Library/Caches/ms-playwright/webkit-2370/pw_run.sh',
    });
    try {
      for (const scenario of [
        { name: 'desktop', width: 1440, delay: 250 },
        { name: 'mobile', width: 390, delay: 250 },
        { name: 'unmarked', width: 1440, delay: 250, marked: false },
        { name: 'hidden', width: 1440, delay: 250, hidden: true },
        { name: 'bounded-stall', width: 1440, delay: 2300 },
      ]) {
        const c = await b.newContext({ viewport: { width: scenario.width, height: 800 } }),
          p = await c.newPage(),
          requests = [],
          errors = [];
        p.on('pageerror', (e) => errors.push(e.message));
        let firstResponseAt;
        await c.route('https://assets.ultraclipart.com/**', async (route) => {
          const id = Number(/(\d)\.webp/.exec(route.request().url())[1]);
          requests.push({ id, at: Date.now() });
          if (id === 0) {
            await new Promise((r) => setTimeout(r, scenario.delay));
            firstResponseAt = Date.now();
          }
          await route.fulfill({ contentType: 'image/webp', body: bytes });
        });
        await p.goto(
          'http://127.0.0.1:' +
            server.address().port +
            '/?marked=' +
            scenario.marked +
            '&hidden=' +
            Boolean(scenario.hidden),
        );
        await expect
          .poll(
            () =>
              p
                .locator('img')
                .evaluateAll((xs) =>
                  xs.every(
                    (i) =>
                      i.parentElement.style.display === 'none' ||
                      (i.complete && i.naturalWidth > 0),
                  ),
                ),
            { timeout: 10000 },
          )
          .toBe(true);
        const first = requests.find((x) => x.id === 0),
          others = requests.filter((x) => x.id !== 0);
        assert.equal(others.length, 3);
        if (scenario.name === 'desktop') assert(others.every((x) => x.at >= firstResponseAt - 15));
        if (scenario.name === 'bounded-stall') {
          assert(others.every((x) => x.at - first.at < 2000));
          assert(others.every((x) => x.at >= first.at + 1000));
        }
        if (['mobile', 'unmarked'].includes(scenario.name))
          assert(others.some((x) => x.at < firstResponseAt));
        if (scenario.hidden) assert.equal(first, undefined);
        const srcsets = await p
          .locator('img')
          .evaluateAll((xs) => xs.map((i) => i.getAttribute('srcset')));
        assert(srcsets.every((x) => x === null));
        assert.deepEqual(errors, []);
        report.cases.push({ engine, ...scenario, requests, firstResponseAt, errors, passed: true });
        await c.unrouteAll({ behavior: 'wait' });
        await c.close();
        console.log(engine, scenario.name, 'PASS');
      }
    } finally {
      await b.close();
    }
  }
  report.passed = report.cases.length === 10;
} finally {
  await new Promise((r) => server.close(r));
  writeFileSync(out + '/report.json', JSON.stringify(report, null, 2));
}
assert(report.passed);
