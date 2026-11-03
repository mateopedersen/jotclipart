import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readCollectionRegistries } from '../../scripts/collection-editorial.mjs';
const base = process.env.BASE_URL ?? 'http://127.0.0.1:4339';
const out = resolve(process.env.EVIDENCE_DIR ?? 'reports/collection-introductions');
const catalog = JSON.parse(readFileSync(new URL('../../data/art.json', import.meta.url)));
const registry = readCollectionRegistries(new URL('../../', import.meta.url).pathname);
const topics = [
  'qatar-flag',
  'sunflower',
  'bat',
  'camera',
  'word',
  'copyright',
  'donald-trump',
  'tesla',
  '007',
  '1x-neo',
  'artemis-3',
  'election-day',
];
const report = { base, cases: [], errors: [], passed: false };
mkdirSync(out, { recursive: true });
for (const [engine, type] of Object.entries({ chromium, webkit })) {
  const browser = await type.launch();
  try {
    for (const width of [320, 390, 768, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.on('pageerror', (e) => report.errors.push(`${engine}: ${e.message}`));
      for (const topic of topics) {
        const statsRequest = page.waitForResponse(
          (r) => new URL(r.url()).pathname === '/catalog-stats.json',
        );
        const discoveryRequest = page.waitForResponse(
          (r) => new URL(r.url()).pathname === '/surprise-picks.json',
        );
        const response = await page.goto(`${base}/clipart/${topic}/`, {
          waitUntil: 'domcontentloaded',
        });
        assert.equal(response.status(), 200, topic);
        const panel = page.locator('[data-collection-summary]');
        await expect(panel.locator('p')).toHaveCount(registry.topics[topic].paragraphs.length);
        const [statsResponse, discoveryResponse] = await Promise.all([
          statsRequest,
          discoveryRequest,
        ]);
        assert.equal(statsResponse.status(), 200, topic + ' count response');
        assert.equal(discoveryResponse.status(), 200, topic + ' discovery response');
        const [stats] = await Promise.all([statsResponse.json(), discoveryResponse.json()]);
        const count = catalog.filter((a) => a.topic === topic && a.published && a.indexable).length;
        assert.equal(stats.topics[topic], count, topic + ' live count');
        await expect(panel.locator('[data-catalog-count="topic"]')).toHaveText(
          `${new Intl.NumberFormat('en-US').format(count)} illustration${count === 1 ? '' : 's'}`,
        );
        const bounds = await panel.evaluate((el) => ({
          width: el.clientWidth,
          scroll: el.scrollWidth,
          page: document.documentElement.scrollWidth,
          viewport: innerWidth,
          clipped: [...el.querySelectorAll('p')].some((p) => p.scrollHeight > p.clientHeight + 1),
        }));
        assert.ok(
          bounds.scroll <= bounds.width + 1 &&
            bounds.page <= bounds.viewport + 1 &&
            !bounds.clipped,
          JSON.stringify({ engine, topic, width, ...bounds }),
        );
        assert.ok(!(await panel.textContent()).includes('{{artworkCount}}'));
        report.cases.push({ engine, width, topic, count, passed: true });
        writeFileSync(`${out}/browser-report.json`, JSON.stringify(report, null, 2) + '\n');
        if (topic === 'qatar-flag' && [390, 1440].includes(width))
          await page.locator('.hero').screenshot({ path: `${out}/${engine}-qatar-${width}.png` });
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
assert.deepEqual(report.errors, []);
report.passed = true;
writeFileSync(`${out}/browser-report.json`, JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({ cases: report.cases.length, errors: report.errors.length, passed: true }),
);
