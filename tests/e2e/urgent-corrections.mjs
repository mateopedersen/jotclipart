import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chromium, webkit, expect } from '@playwright/test';
import sharp from 'sharp';
import { readEditorialCatalog } from '../helpers/editorial-catalog.mjs';
import { bridgeLocalCdn, markLocalCdnTeardown } from '../helpers/local-cdn.mjs';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:4339';
const live = base === 'https://ultraclipart.com';
const engine = process.env.UC_BROWSER ?? 'chromium';
assert(['chromium', 'webkit'].includes(engine));
const catalog = readEditorialCatalog(), byId = new Map(catalog.map((item) => [item.id, item]));
const publication = JSON.parse(readFileSync('data/publication.json'));
const files = new Map(publication.files.map((file) => [`${file.assetId}/${file.kind}`, file]));
const digest = (body) => createHash('sha256').update(body).digest('hex');
const observed = new Map();

async function sourceBytes(record) {
  if (!live) return readFileSync('public' + record.path);
  const response = await fetch(record.url, { headers: { Origin: 'https://ultraclipart.com' }, signal: AbortSignal.timeout(30000), redirect: 'error' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type')?.split(';')[0], record.contentType);
  assert.ok(['*', 'https://ultraclipart.com'].includes(response.headers.get('access-control-allow-origin')));
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, record.bytes); assert.equal(digest(bytes), record.sha256);
  return bytes;
}

async function monochrome(id) {
  if (observed.has(id)) return observed.get(id);
  const item = byId.get(id), record = files.get(id + '/thumb');
  assert(item && record);
  const bytes = await sourceBytes(record);
  assert.equal(digest(bytes), record.sha256);
  const { data } = await sharp(bytes).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let visible = 0, chromatic = 0, saturated = 0, ink = 0, spread = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const high = Math.max(data[i], data[i + 1], data[i + 2]);
    const low = Math.min(data[i], data[i + 1], data[i + 2]);
    visible++; spread += high - low;
    if (high - low > 12) chromatic++;
    if (high - low > 28) saturated++;
    if (high < 230) ink++;
  }
  const c = chromatic / (visible || 1), s = saturated / (visible || 1),
    d = spread / (visible || 1), dark = ink / (visible || 1);
  const declared = ['Outline', 'Black & White'].includes(item.style);
  const neutral = visible > 0 && dark > 0.02 &&
    ((declared && c <= 0.06 && s <= 0.001 && d <= 9) || (c <= 0.005 && s <= 0.001 && d <= 6));
  observed.set(id, neutral); return neutral;
}

const browser = await (engine === 'webkit' ? webkit : chromium).launch();
const context = await browser.newContext({ viewport: { width: engine === 'webkit' ? 390 : 1440, height: 1000 } });
if (!live) await bridgeLocalCdn(context, base);
const page = await context.newPage(); page.setDefaultTimeout(30000);
let summary;
try {
  assert.equal((await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })).status(), 200);
  await expect(page.locator('body')).not.toContainText('For Cards & Invitations');
  await expect(page.locator('body')).not.toContainText('Watercolor Illustration');
  const cards = page.locator('.home-recent-grid .art-card');
  await expect(cards).toHaveCount(15);
  const ids = await cards.evaluateAll((elements) => elements.map((element) => element.dataset.id));
  assert.equal(new Set(ids).size, 15);
  assert.equal(new Set(ids.map((id) => byId.get(id)?.topic)).size, 15);
  const states = await Promise.all(ids.map(monochrome));
  assert(states.includes(true) && states.includes(false));
  for (let i = 1; i < states.length; i++) assert.notEqual(states[i], states[i - 1], 'Recent row should alternate actual color and monochrome artwork');
  for (let i = 0; i < 15; i++) {
    const image = cards.nth(i).locator('img').first();
    // Headless WebKit may consider a lazy image visible without scrolling it
    // into the viewport. Use an actual page scroll before waiting for bytes.
    await image.evaluate((element) => window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 80));
    await expect.poll(() => image.evaluate((node) => node.complete && node.naturalWidth > 0), { timeout: 30000 }).toBe(true);
  }
  if (live) {
    const redirect = await page.request.get(base + '/clipart/300/', { maxRedirects: 0 });
    assert.equal(redirect.status(), 301);
    assert.equal(new URL(redirect.headers().location, base).pathname, '/clipart/300-movie/');
  }
  assert.equal((await page.goto(base + '/clipart/300-movie/', { waitUntil: 'domcontentloaded', timeout: 60000 })).status(), 200);
  await expect(page.locator('main h1')).toHaveText('300 Movie Clipart');
  await expect(page.locator('.gallery .art-card')).toHaveCount(50);
  assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), 'https://ultraclipart.com/clipart/300-movie/');
  const schema = (await page.locator('script[type="application/ld+json"]').allTextContents()).map(JSON.parse);
  assert(schema.some((entry) => entry['@type'] === 'CollectionPage' && entry.url === 'https://ultraclipart.com/clipart/300-movie/' && entry.mainEntity.numberOfItems === 50));
  for (const id of ['300-001', 'xbox-014']) {
    assert.equal((await page.goto(base + '/art/' + id + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })).status(), 200);
    const item = byId.get(id); await expect(page.locator('main h1')).toHaveText(item.title);
    assert(await page.locator('img').evaluateAll((images, alt) => images.some((image) => image.alt === alt), item.alt));
    const root = page.locator('[data-related-root]');
    await expect(root).toHaveAttribute('data-ready', 'true', { timeout: 30000 });
    assert((await root.locator('.related-card').count()) > 0);
  }
  for (const kind of ['webp', 'pdf', 'thumb']) {
    const record = files.get('xbox-014/' + kind), body = await sourceBytes(record);
    assert.equal(body.length, record.bytes); assert.equal(digest(body), record.sha256);
  }
  summary = { status: live ? 'URGENT_CORRECTIONS_LIVE_BROWSER_PASS' : 'URGENT_CORRECTIONS_LOCAL_BROWSER_PASS', engine, homeCards: ids.length, colors: states.filter((x) => !x).length, monochrome: states.filter(Boolean).length, filmArtworks: 50, related: 2, xboxDownloads: 3 };
} finally {
  // Only unused in-flight local CDN requests may be disposed during explicit teardown.
  markLocalCdnTeardown(context);
  try { await context.close(); } finally { await browser.close(); }
}
console.log(JSON.stringify(summary));
