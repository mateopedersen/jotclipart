import { chromium, webkit } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
const output = process.env.EVIDENCE_DIR || 'reports/image-stability';
mkdirSync(output, { recursive: true });
const css = ['global.css', 'related.css', 'card-media.css', 'original-image-loading.css']
  .map((f) => readFileSync('src/styles/' + f, 'utf8'))
  .join('\n');
const report = {
  scope:
    'Actual shared CSS with explicitly synthetic cards; geometry before and after dynamic appends',
  cases: [],
  errors: [],
};
for (const [engine, type] of Object.entries({ chromium, webkit })) {
  const browser = await type.launch(
    engine === 'chromium'
      ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }
      : {},
  );
  try {
    for (const width of [390, 768, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.setContent(
        `<style>*{box-sizing:border-box}${css}</style><div class="related-group"><div class="related-grid"></div></div><div class="gallery"></div>`,
      );
      for (const count of [1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 16, 24, 32, 48, 49, 50]) {
        const data = await page.evaluate((count) => {
          const grids = [
            ['.related-grid', 'related-card', 'related-picture'],
            ['.gallery', 'art-card', 'art-picture'],
          ];
          return grids.map(([selector, card, frame]) => {
            const grid = document.querySelector(selector);
            grid.innerHTML = Array.from(
              { length: count },
              () =>
                `<article class="${card}"><a class="${frame}"><img width="2000" height="1000" alt="Synthetic frame" /></a><div>Fixture</div></article>`,
            ).join('');
            const before = [...grid.children].map((c) => {
              const b = c.getBoundingClientRect();
              return { width: b.width, height: c.firstElementChild.getBoundingClientRect().height };
            });
            grid.insertAdjacentHTML(
              'beforeend',
              `<article class="${card}"><a class="${frame}"><img width="2000" height="1000" alt="Synthetic append" /></a><div>Fixture</div></article>`,
            );
            const after = [...grid.children].slice(0, -1).map((c) => {
              const b = c.getBoundingClientRect();
              return { width: b.width, height: c.firstElementChild.getBoundingClientRect().height };
            });
            return {
              selector,
              before,
              after,
              stable: before.every(
                (b, i) =>
                  Math.abs(b.width - after[i].width) < 1 &&
                  Math.abs(b.height - after[i].height) < 1,
              ),
            };
          });
        }, count);
        report.cases.push({ engine, width, count, checks: data });
        for (const d of data)
          if (!d.stable) report.errors.push({ engine, width, count, selector: d.selector });
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
writeFileSync(output + '/geometry.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ cases: report.cases.length, errors: report.errors }));
assert.deepEqual(report.errors, []);
