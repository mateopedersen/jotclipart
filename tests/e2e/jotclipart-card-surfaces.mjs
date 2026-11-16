// Actual shared CSS in an isolated browser. No public catalog or media writes.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium, firefox, webkit } from '@playwright/test';

const source = process.env.WHITE_SURFACE_CSS || 'src/styles/global.css';
const css = readFileSync(source, 'utf8');
const media = readFileSync('src/styles/card-media.css', 'utf8');
const loading = readFileSync('src/styles/original-image-loading.css', 'utf8');
const out = process.env.EVIDENCE_DIR || 'reports/jotclipart-card-surfaces';
mkdirSync(out, { recursive: true });
const engine = process.env.UC_BROWSER || 'chromium';
assert(['chromium', 'firefox', 'webkit'].includes(engine));
const browser = await { chromium, firefox, webkit }[engine].launch({ headless: true });
const result = {
  schema: 1,
  engine,
  sourceSHA256: createHash('sha256').update(css).digest('hex'),
  fixture:
    'Six synthetic transparent/opaque subjects with actual shared card CSS; no editorial-review claim.',
  status: 'RUNNING',
  rows: [],
};
const svg = (i) =>
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160">${
      i % 2 ? '<rect width="320" height="160" fill="white"/>' : ''
    }<path d="M40 100 Q160 10 280 100" stroke="black" fill="none" stroke-width="4"/></svg>`,
  );
try {
  for (const width of [320, 390, 768, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    await page.route('**/*', (route) => route.abort());
    await page.setContent(
      `<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${media}\n${loading}</style>` +
        `<main><section class="gallery">${Array.from(
          { length: 6 },
          (_, i) =>
            `<article class="art-card" data-id="subject-${i}"><a class="art-picture" href="#subject-${i}">` +
            `<img src="${svg(i)}" width="320" height="160" alt="Synthetic subject ${i}"></a>` +
            `<div class="card-body"><a class="card-title" href="#subject-${i}">Fixture subject</a>` +
            '<div class="formats"><a href="#image">Image</a><a href="#pdf">PDF</a></div>' +
            '<div class="card-actions"><a class="button" href="#edit">Edit</a></div></div></article>',
        ).join('')}</section></main>`,
    );
    await page
      .locator('.art-picture img')
      .evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
    const measure = () =>
      page.locator('.art-card').evaluateAll((cards) =>
        cards.map((card) => {
          const frame = card.querySelector('.art-picture'),
            image = frame.querySelector('img');
          const box = frame.getBoundingClientRect(),
            style = getComputedStyle(frame);
          return {
            id: card.dataset.id,
            background: style.backgroundColor,
            backgroundImage: style.backgroundImage,
            width: box.width,
            height: box.height,
            aspectRatio: style.aspectRatio,
            source: image.getAttribute('src'),
          };
        }),
      );
    const before = await measure();
    await page.locator('.art-picture').first().hover();
    await page.keyboard.press('Tab');
    await page.locator('.art-picture').nth(3).focus();
    const interaction = await measure();
    await page.locator('.gallery').evaluate((gallery) => {
      [...gallery.children].reverse().forEach((card) => gallery.append(card));
    });
    const reordered = await measure();
    const byId = new Map(before.map((row) => [row.id, row]));
    for (const row of [...interaction, ...reordered]) {
      const original = byId.get(row.id);
      assert(row.width > 0 && row.height > 0);
      assert(Math.abs(row.width - original.width) < 0.1);
      assert(Math.abs(row.height - original.height) < 0.1);
      assert.equal(row.aspectRatio, original.aspectRatio);
      assert.equal(row.source, original.source);
    }
    const allWhite = [...before, ...interaction, ...reordered].every(
      (row) => row.background === 'rgb(255, 255, 255)' && row.backgroundImage === 'none',
    );
    result.rows.push({ width, allWhite, before, interaction, reordered });
    if (width === 390) await page.screenshot({ path: out + '/cards-390.png' });
    await page.close();
  }
  result.status = result.rows.every((row) => row.allWhite) ? 'PASS' : 'FAIL';
  assert.equal(
    result.status,
    'PASS',
    'Gallery frame surfaces must stay white at every position and interaction state',
  );
} catch (error) {
  result.status = 'FAIL';
  result.error = error.message;
  process.exitCode = 1;
} finally {
  await browser.close();
  writeFileSync(out + '/result.json', JSON.stringify(result, null, 2) + '\n');
}
console.log(
  JSON.stringify({
    status: result.status,
    engine,
    widths: result.rows.map((row) => row.width),
    white: result.rows.map((row) => row.allWhite),
    error: result.error,
    report: out + '/result.json',
  }),
);
