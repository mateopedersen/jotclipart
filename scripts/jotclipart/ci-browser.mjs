import { observeCatalogRequests, settleBeforeDirectNavigation } from './browser-readiness.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { chromium, firefox, webkit, expect } from '@playwright/test';
import sharp from 'sharp';

const mode = process.argv[2] ?? 'browser',
  base = process.env.BASE_URL ?? 'https://preview.jotclipart.com';
const wanted = process.env.EXPECT_REVISION ?? process.env.GITHUB_SHA;
assert(/^[a-f0-9]{40}$/.test(wanted ?? ''), 'A real source commit is required');
const origin = new URL(base).origin;
assert(
  base === origin &&
    (origin === 'https://preview.jotclipart.com' ||
      /^https:\/\/(?:[a-z0-9-]+\.)?jotclipart\.pages\.dev$/.test(origin)),
  'Only the independent JotClipart Pages preview is allowed',
);
const rootDir = resolve('reports/jotclipart-native-browser');
mkdirSync(rootDir, { recursive: true });
const sha = (b) => createHash('sha256').update(b).digest('hex'),
  textHash = (s) => sha(Buffer.from(s));
const baselinePin = JSON.parse(readFileSync('config/jotclipart-migration-baseline.json')),
  baselineBytes = readFileSync('config/' + baselinePin.file);
assert.equal(sha(baselineBytes), baselinePin.sha256);
assert.equal(baselineBytes.length, baselinePin.bytes);
const baseline = gunzipSync(baselineBytes)
  .toString('utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
assert.equal(baseline.length, baselinePin.artworks);
const oldHost = (host) =>
  host === 'ultraclipart.com' ||
  host.endsWith('.ultraclipart.com') ||
  host === 'ultraclipart.pages.dev' ||
  host.endsWith('.ultraclipart.pages.dev') ||
  (/ultraclipart/i.test(host) && host.endsWith('.workers.dev'));
let sourceGETs = 0;
async function get(path, timeout = 60000) {
  await delay(40);
  sourceGETs++;
  const response = await fetch(origin + path, {
    redirect: 'manual',
    headers: { 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(Math.max(1, Math.min(60000, timeout))),
  });
  assert.equal(response.status, 200, 'Source GET ' + path);
  return response;
}
async function release(timeout = 60000) {
  const r = await get('/delivery-release.json', timeout);
  const body = await r.json();
  assert.equal(body.controlRevision, wanted, 'Preview has a different software commit');
  assert(/^[a-f0-9]{64}$/.test(body.verifiedRoot));
  assert(
    body.artworks >= baselinePin.artworks && body.subjects >= baselinePin.topics,
    'Published catalog rolled back',
  );
  return body;
}
const decode = (s) =>
  s
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
async function pinPreview() {
  const deadline = Date.now() + 20 * 60 * 1000;
  let before, last;
  while (Date.now() < deadline) {
    try {
      before = await release(deadline - Date.now());
      break;
    } catch (error) {
      last = error.message;
      console.log(
        JSON.stringify({ phase: 'waiting-for-owner-preview-deployment', expectedCommit: wanted }),
      );
      await delay(Math.max(0, Math.min(15000, deadline - Date.now())));
    }
  }
  assert(before, 'Matching preview deployment did not arrive within 20 minutes: ' + last);
  const index = await (await get('/sitemap.xml')).text();
  const docs = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(decode(m[1])));
  assert(
    docs.length >= baselinePin.sitemapDocuments && docs.length <= 128,
    'Sitemap index shrank or exceeded audit budget',
  );
  const families = {
      art: new Map(),
      images: new Map(),
      topics: new Set(),
      collections: new Set(),
      pages: new Set(),
    },
    sitemaps = [];
  for (const doc of docs) {
    assert.equal(doc.origin, 'https://jotclipart.com');
    assert(/^\/sitemap-(?:pages|topics|collections|art|images)(?:-\d+)?\.xml$/.test(doc.pathname));
    const response = await get(doc.pathname);
    assert.equal(response.headers.get('x-uc-snapshot'), before.verifiedRoot);
    const xml = await response.text(),
      family = doc.pathname.match(/^\/sitemap-([a-z]+)/)[1],
      rows = [...xml.matchAll(/<url><loc>([^<]+)<\/loc>([\s\S]*?)<\/url>/g)];
    for (const row of rows) {
      const canonical = new URL(decode(row[1]));
      assert.equal(canonical.origin, 'https://jotclipart.com');
      assert(!families[family].has(canonical.pathname), 'Duplicate canonical in sitemap family');
      if (family === 'art') families.art.set(canonical.pathname, null);
      else if (family === 'images') {
        const images = [...row[2].matchAll(/<image:loc>([^<]+)<\/image:loc>/g)].map(
          (m) => new URL(decode(m[1])),
        );
        assert.equal(images.length, 1);
        assert.equal(images[0].origin, 'https://assets.jotclipart.com');
        assert(!images[0].search && !images[0].hash);
        families.images.set(canonical.pathname, decodeURIComponent(images[0].pathname.slice(1)));
      } else families[family].add(canonical.pathname);
    }
    sitemaps.push({ path: doc.pathname, family, urls: rows.length, sha256: textHash(xml) });
  }
  assert.equal(families.art.size, before.artworks);
  assert.equal(families.images.size, before.artworks);
  assert.equal(families.topics.size, before.subjects);
  assert(
    families.collections.size >= baselinePin.collections &&
      families.pages.size >= baselinePin.otherPages,
  );
  const exactRoot = before.verifiedRoot === baselinePin.sourceRoot;
  const urlPlan = JSON.parse(
    readFileSync('data/routes/artwork-public-url-ordinal-repair-20261110.json'),
  );
  const retiredRepairs =
    before.verifiedRoot !== urlPlan.parentRoot &&
    urlPlan.kind === 'OWNER_AUTHORIZED_ARTWORK_ORDINAL_URL_REPAIR' &&
    urlPlan.legacyPolicy === 'retire-without-redirect'
      ? new Map(urlPlan.changes.map((change) => [change.id, change]))
      : new Map();
  for (const row of baseline) {
    const repair = retiredRepairs.get(row.id);
    if (repair) {
      assert.equal(row.canonicalPath, '/art/' + repair.oldSlug + '/');
      assert.equal(row.sourceTitle, repair.title);
      assert.equal(row.topic, repair.topic);
    }
    const acceptedPath = repair ? '/art/' + repair.slug + '/' : row.canonicalPath;
    assert(
      families.art.has(acceptedPath) && families.images.has(acceptedPath),
      'An accepted canonical path disappeared without its exact owner-authorized replacement',
    );
    if (exactRoot)
      assert.equal(
        families.images.get(row.canonicalPath),
        row.media.find((m) => m.role === 'webp').objectKey,
        'Unchanged-root artwork points to a different R2 original',
      );
  }
  const discoveryResponse = await get('/surprise-picks.json');
  assert.equal(discoveryResponse.headers.get('x-uc-snapshot'), before.verifiedRoot);
  const discovery = await discoveryResponse.json();
  assert.equal(discovery.version, 3);
  assert(
    Array.isArray(discovery.items) && discovery.items.length > 0 && discovery.items.length <= 512,
  );
  for (const pick of discovery.items) {
    const slug = pick.publicSlug ?? pick.id;
    assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug));
    assert(
      families.art.has('/art/' + slug + '/'),
      'A Surprise destination is not a current canonical artwork URL',
    );
  }
  const after = await release();
  assert.equal(
    after.verifiedRoot,
    before.verifiedRoot,
    'Catalog changed during complete sitemap pin',
  );
  const chosen =
    baseline.find((r) => r.id === 'classic-white-volleyball-realistic-clipart') ??
    baseline.find(
      (r) =>
        r.media.some((m) => m.role === 'pdf') &&
        r.media.find((m) => m.role === 'webp')?.bytes < 2_000_000,
    );
  assert(chosen);
  const repairedSample = retiredRepairs.get(chosen.id),
    samplePath = repairedSample ? '/art/' + repairedSample.slug + '/' : chosen.canonicalPath,
    sampleResponse = await get(samplePath);
  assert.equal(sampleResponse.headers.get('x-uc-snapshot'), before.verifiedRoot);
  const sampleHTML = await sampleResponse.text(),
    downloadJSON = /<script\b[^>]*\bdata-download-record\b[^>]*>([\s\S]*?)<\/script>/i.exec(
      sampleHTML,
    );
  assert(downloadJSON, 'Preview sample lacks its authenticated download descriptor');
  const record = JSON.parse(downloadJSON[1]),
    original = record.download?.files?.webp;
  assert.equal(record.id, chosen.id);
  assert.equal(new URL(record.webp).origin, 'https://assets.jotclipart.com');
  assert(original?.bytes > 0 && /^[a-f0-9]{64}$/.test(original.sha256));
  sourceGETs++;
  const mediaResponse = await fetch(record.webp, {
    headers: { Origin: origin },
    redirect: 'error',
    signal: AbortSignal.timeout(60000),
  });
  assert.equal(mediaResponse.status, 200, 'Actual original GET failed before browser matrix');
  assert.equal(
    mediaResponse.headers.get('access-control-allow-origin'),
    origin,
    'Original GET must allow the preview origin; HEAD alone does not verify cached GET CORS',
  );
  const mediaBytes = Buffer.from(await mediaResponse.arrayBuffer());
  assert.equal(mediaBytes.length, original.bytes);
  assert.equal(sha(mediaBytes), original.sha256);
  const result = {
    status: 'MATCHING_PREVIEW_AND_COMPLETE_SITEMAPS_VERIFIED',
    at: new Date().toISOString(),
    url: origin,
    sourceCommit: wanted,
    snapshotRoot: before.verifiedRoot,
    baselineRoot: baselinePin.sourceRoot,
    baselineSHA256: baselinePin.sha256,
    exactBaselineMetadataRequired: exactRoot,
    baselineArtworks: baseline.length,
    actualArtworks: families.art.size,
    topics: families.topics.size,
    collections: families.collections.size,
    otherPages: families.pages.size,
    sitemapDocuments: docs.length,
    currentCanonicalSurpriseDestinationsVerified: discovery.items.length,
    sitemaps,
    baselineCanonicalPathsPresent: baseline.length,
    unchangedRootR2KeysCompared: exactRoot ? baseline.length : 0,
    sameR2BucketEvidence:
      'Existing signed source baseline object keys preserved; no private R2 inventory is rerun by CI.',
    sourceGETs,
    maximumExplicitSourceGETRatePerSecond: 25,
    sample: chosen,
    actualOriginalGET: {
      id: record.id,
      bytes: mediaBytes.length,
      sha256: original.sha256,
      cors: mediaResponse.headers.get('access-control-allow-origin'),
      cache: mediaResponse.headers.get('cf-cache-status'),
    },
    actualAIInference: false,
  };
  writeFileSync(join(rootDir, 'preview-pin.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, sitemaps: undefined, sample: undefined }));
}

async function browserFlow() {
  const engine = process.env.UC_BROWSER ?? 'chromium',
    width = Number(process.env.VIEWPORT_WIDTH ?? 1440);
  assert(['chromium', 'firefox', 'webkit'].includes(engine));
  assert([320, 390, 768, 1440].includes(width));
  const pin = JSON.parse(readFileSync(join(rootDir, 'preview-pin.json')));
  assert.equal(pin.sourceCommit, wanted);
  assert.equal(pin.url, origin);
  assert.equal(pin.baselineSHA256, baselinePin.sha256);
  const dir = join(rootDir, engine + '-' + width);
  mkdirSync(dir, { recursive: true });
  const report = {
    status: 'RUNNING',
    engine,
    viewport: { width, height: width < 768 ? 844 : 1000 },
    sourceCommit: wanted,
    snapshotRoot: pin.snapshotRoot,
    checks: [],
    downloads: [],
    blockedOldHostRequests: [],
    pageErrors: [],
    badSoftwareResources: [],
    expectedPreviewOriginRefusals: [],
    actualAIInference: false,
    serverShareCreation: false,
    unexpectedMutationAttempts: [],
  };
  const browser = await { chromium, firefox, webkit }[engine].launch({ headless: true });
  const contexts = [];
  let currentPage;
  const guard = async (context) => {
    // Cold provider pages and their source-bound modules can exceed the
    // library's 30s default. Content, snapshot and UI assertions still follow.
    context.setDefaultNavigationTimeout(60000);
    contexts.push(context);
    const starts = [];
    await context.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (oldHost(url.hostname)) {
        report.blockedOldHostRequests.push({ host: url.hostname, path: url.pathname });
        return route.abort();
      }
      if (
        request.method() === 'POST' &&
        /^\/api\/(?:ai\/generate|share\/create)/.test(url.pathname)
      ) {
        report.unexpectedMutationAttempts.push(url.pathname);
        return route.abort();
      }
      if (
        url.origin === origin &&
        request.method() === 'GET' &&
        ['document', 'xhr', 'fetch'].includes(request.resourceType())
      ) {
        const now = Date.now();
        while (starts.length && starts[0] < now - 1000) starts.shift();
        if (starts.length >= 30) await delay(1000 - (now - starts[0]));
        starts.push(Date.now());
      }
      return route.continue();
    });
    context.on('page', (page) => {
      observeCatalogRequests(page, origin);
      page.on('pageerror', (e) => {
        report.pageErrors.push(e.message);
        (report.pageErrorContexts ??= []).push({
          url: page.url(),
          message: e.message,
          stack: e.stack,
        });
      });
      page.on('response', (r) => {
        const u = new URL(r.url()),
          status = r.status();
        if (
          u.origin === origin &&
          /\/api\/(?:ai|share)\/session/.test(u.pathname) &&
          [403, 503].includes(status)
        ) {
          report.expectedPreviewOriginRefusals.push({ path: u.pathname, status });
          return;
        }
        if (
          [origin, 'https://assets.jotclipart.com'].includes(u.origin) &&
          status >= 400 &&
          /\.(?:js|css|woff2?|wasm|svg|webp|png)(?:$|\?)/.test(u.pathname)
        )
          report.badSoftwareResources.push({ path: u.pathname, status });
      });
    });
    return context;
  };
  const context = await guard(
    await browser.newContext({ viewport: report.viewport, acceptDownloads: true }),
  );
  const page = await context.newPage();
  currentPage = page;
  const dismiss = async (p) => {
    await p.waitForFunction(() => typeof window.__ucCookieNoticeReady?.then === 'function', null, {
      timeout: 10000,
    });
    await p.evaluate(async () => {
      let timeout;
      try {
        await Promise.race([
          window.__ucCookieNoticeReady,
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(Error('Cookie notice readiness timed out')), 7000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    });
    const choice = p.locator('#cookie-notice [data-cookie-choice=necessary]:visible').first();
    if (await choice.count()) await choice.click();
    await expect(p.locator('#cookie-notice')).not.toBeVisible();
  };
  const layout = async (p) => {
    await p.evaluate(() => document.fonts.ready);
    assert(
      await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2),
      'Unexpected horizontal viewport overflow',
    );
    assert.equal(
      await p.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--brand-primary')
          .trim()
          .toUpperCase(),
      ),
      '#52B788',
    );
  };
  const navigate = async (p, path, { javascript = true } = {}) => {
    await settleBeforeDirectNavigation(p);
    const r = await p.goto(origin + path, { waitUntil: 'domcontentloaded' });
    assert.equal(r.status(), 200, path);
    assert.equal(r.headers()['x-uc-snapshot'], pin.snapshotRoot, 'Mixed snapshot on ' + path);
    if (javascript) await dismiss(p);
    return r;
  };
  const check = (name, details = {}) => report.checks.push({ name, ...details });
  async function readDownload(download, max = 25 * 1024 * 1024) {
    const stream = await download.createReadStream();
    assert(stream, 'Browser download stream unavailable');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of stream) {
      bytes += chunk.length;
      assert(bytes <= max, 'Browser download exceeded bounded size');
      chunks.push(chunk);
    }
    assert.equal(await download.failure(), null);
    return Buffer.concat(chunks);
  }
  const click = async (locator) => {
    await locator.scrollIntoViewIfNeeded();
    await locator.click();
  };
  async function saveProject(p) {
    const menu = p.locator('.wb-file-menu');
    if ((await menu.getAttribute('open')) === null) await menu.locator('summary').click();
    const pending = p.waitForEvent('download');
    await click(menu.locator('[data-action=save]'));
    const download = await pending,
      bytes = await readDownload(download, 8 * 1024 * 1024),
      doc = JSON.parse(bytes);
    assert(Array.isArray(doc.layers) && doc.layers.length > 0);
    assert([1, 2].includes(doc.version));
    report.downloads.push({
      kind: 'portable-project',
      bytes: bytes.length,
      sha256: sha(bytes),
      filename: download.suggestedFilename(),
    });
    return { doc, bytes };
  }
  try {
    const live = await release();
    assert.equal(live.verifiedRoot, pin.snapshotRoot);
    await navigate(page, '/');
    await expect(page.locator('h1')).toContainText(/clipart/i);
    const brandLink = page
      .locator('.site-header')
      .getByRole('link', { name: 'JotClipart home', exact: true });
    await expect(brandLink).toBeVisible();
    const wordmark = brandLink.locator('img');
    await expect(wordmark).toHaveAttribute('alt', 'JotClipart');
    await expect(wordmark).toHaveAttribute('src', '/brand/jotclipart-logo-3d.webp');
    await expect(wordmark).toHaveJSProperty('complete', true);
    const renderedLogoURL = new URL(await wordmark.evaluate((image) => image.currentSrc));
    assert.equal(renderedLogoURL.origin, origin);
    assert(/^\/brand\/jotclipart-logo-3d(?:-(?:320|480))?\.webp$/.test(renderedLogoURL.pathname));
    const renderedLogoBytes = readFileSync('public' + renderedLogoURL.pathname),
      renderedLogoInfo = await sharp(renderedLogoBytes).metadata();
    await expect.poll(() => wordmark.evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);
    // Responsive w-descriptor sources have density-corrected naturalWidth.
    // Verify the actual selected file's pixel dimensions and full bytes instead.
    assert(renderedLogoInfo.width > 0 && renderedLogoInfo.height > 0);
    assert([320, 480, 1200].includes(renderedLogoInfo.width));
    assert.equal(
      sha(Buffer.from(await (await get(renderedLogoURL.pathname)).arrayBuffer())),
      sha(renderedLogoBytes),
    );
    const logoSHA = sha(
      Buffer.from(await (await get('/brand/jotclipart-logo-3d.webp')).arrayBuffer()),
    );
    assert.equal(logoSHA, sha(readFileSync('public/brand/jotclipart-logo-3d.webp')));
    await expect(page).toHaveTitle(/Free.*JotClipart/);
    await layout(page);
    await page.screenshot({ path: join(dir, 'home.png') });
    check('Homepage branding, typography load and responsive viewport', { logoSHA256: logoSHA });
    const surprise = page.locator('[data-surprise-art]:visible').first();
    await expect(surprise).toBeVisible();
    await surprise.scrollIntoViewIfNeeded();
    // The real pointer click is followed by an explicit document readiness
    // check. Do not add a second implicit wait for every image on that page.
    await Promise.all([
      page.waitForURL(
        (url) => url.origin === origin && /^\/art\/[a-z0-9-]+\/$/.test(url.pathname),
        { waitUntil: 'domcontentloaded', timeout: 45000 },
      ),
      surprise.click({ noWaitAfter: true }),
    ]);
    const surprisedURL = new URL(page.url());
    assert.equal(surprisedURL.origin, origin, 'Surprise escaped the preview origin');
    assert(/^\/art\/[a-z0-9-]+\/$/.test(surprisedURL.pathname));
    assert(!surprisedURL.search && !surprisedURL.hash);
    // Native prerender activation need not emit a fresh navigation Response.
    // Validate the actual clicked document and its canonical HTTP route instead.
    const surpriseResponse = await get(surprisedURL.pathname);
    assert.equal(surpriseResponse.headers.get('x-uc-snapshot'), pin.snapshotRoot);
    await expect(page.locator('meta[name="catalog-snapshot"]')).toHaveAttribute(
      'content',
      pin.snapshotRoot,
    );
    const surpriseTiming = await page.evaluate(() => {
      const entry = performance.getEntriesByType('navigation')[0];
      return {
        responseStatus: entry?.responseStatus ?? null,
        activationStart: entry?.activationStart ?? null,
      };
    });
    if (surpriseTiming.responseStatus) assert.equal(surpriseTiming.responseStatus, 200);
    await dismiss(page);
    const surpriseCanonical = await page.locator('link[rel=canonical]').getAttribute('href');
    assert.equal(surpriseCanonical, 'https://jotclipart.com' + surprisedURL.pathname);
    const surpriseRecord = await page
      .locator('script[data-download-record]')
      .evaluate((el) => JSON.parse(el.textContent));
    assert(/^[a-z0-9-]+$/.test(surpriseRecord.id));
    assert.equal(new URL(surpriseRecord.webp).origin, 'https://assets.jotclipart.com');
    await expect(page.locator('h1')).toHaveText(/^Free (?!Free )/);
    await layout(page);
    check(
      'Surprise actual pointer click follows its real alias redirect to a source-bound same-origin artwork',
      { path: surprisedURL.pathname, id: surpriseRecord.id },
    );
    await navigate(page, '/clipart/' + pin.sample.topic + '/');
    await expect(page.locator('h1')).toHaveText(/^Free (?!Free )/);
    assert((await page.locator('.art-card').count()) > 0);
    await layout(page);
    check('Topic gallery and one Free prefix');
    const shareCard = page.locator('.art-card').first(),
      shareTrigger = shareCard.locator('[data-share-art]'),
      shareID = await shareCard.getAttribute('data-id'),
      shareURL = await shareTrigger.getAttribute('data-share-url'),
      shareImageURL = await shareTrigger.getAttribute('data-share-image');
    assert.equal(new URL(shareURL).origin, 'https://jotclipart.com');
    assert(/^\/art\/[a-z0-9-]+\/$/.test(new URL(shareURL).pathname));
    assert.equal(new URL(shareImageURL).origin, 'https://assets.jotclipart.com');
    assert.equal(await shareCard.locator('.art-picture img').getAttribute('src'), shareImageURL);
    const expectedShareSource = baseline
      .find((item) => item.id === shareID)
      ?.media.find((media) => media.role === 'webp');
    if (pin.exactBaselineMetadataRequired) assert(expectedShareSource);
    const shareCanonicalResponse = await get(new URL(shareURL).pathname);
    assert.equal(shareCanonicalResponse.headers.get('x-uc-snapshot'), pin.snapshotRoot);
    const shareCanonicalHTML = await shareCanonicalResponse.text(),
      shareRecordJSON = /<script\b[^>]*\bdata-download-record\b[^>]*>([\s\S]*?)<\/script>/i.exec(
        shareCanonicalHTML,
      );
    assert(shareRecordJSON, 'Current share canonical lacks a source-bound download descriptor');
    const shareRecord = JSON.parse(shareRecordJSON[1]),
      currentShareSource = shareRecord.download?.files?.webp;
    assert.equal(shareRecord.id, shareID);
    assert.equal(shareRecord.webp, shareImageURL);
    assert(currentShareSource?.bytes > 0 && /^[a-f0-9]{64}$/.test(currentShareSource.sha256));
    const sourceFetch = page.waitForResponse(
      (response) =>
        response.url() === shareImageURL && response.request().resourceType() === 'fetch',
      { timeout: 45000 },
    );
    await click(shareTrigger);
    const shareDialog = page.locator('dialog.uc-share');
    await expect(shareDialog).toBeVisible();
    assert.equal(await page.locator('dialog.uc-share').count(), 1);
    await expect(shareDialog.locator('#uc-share-link')).toHaveValue(shareURL);
    const sourceResponse = await sourceFetch,
      shareSourceBytes = await sourceResponse.body();
    assert.equal(sourceResponse.status(), 200);
    assert.equal(shareSourceBytes.length, currentShareSource.bytes);
    assert.equal(sha(shareSourceBytes), currentShareSource.sha256);
    assert.equal(
      sourceResponse.headers()['access-control-allow-origin'],
      origin,
      'Actual share source CORS',
    );
    if (pin.exactBaselineMetadataRequired) {
      assert.equal(shareSourceBytes.length, expectedShareSource.bytes);
      assert.equal(sha(shareSourceBytes), expectedShareSource.sha256);
      assert.equal(
        decodeURIComponent(new URL(shareImageURL).pathname.slice(1)),
        expectedShareSource.objectKey,
      );
    }
    await expect(shareDialog.locator('.uc-share-download')).toBeEnabled({ timeout: 45000 });
    await expect(shareDialog.locator('.uc-share-file-note')).toContainText(/\d+ × \d+ PNG/);
    for (const href of await shareDialog
      .locator('.uc-share-network')
      .evaluateAll((links) => links.map((link) => link.href))) {
      const networkURL = new URL(href);
      assert.equal(networkURL.protocol, 'https:');
      assert(
        [
          'www.pinterest.com',
          'www.facebook.com',
          'wa.me',
          'x.com',
          't.me',
          'www.linkedin.com',
          'www.reddit.com',
          'bsky.app',
          'www.threads.net',
        ].includes(networkURL.hostname),
      );
      assert(!decodeURIComponent(href).includes('ultraclipart.com'));
    }
    assert.equal(await shareDialog.locator('.uc-share-network').count(), 9);
    const shareSize = await shareDialog.evaluate((dialog) => {
      const rect = dialog.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        width: rect.width,
        scrollWidth: dialog.scrollWidth,
        clientWidth: dialog.clientWidth,
        viewport: innerWidth,
      };
    });
    assert(shareSize.left >= -1 && shareSize.right <= shareSize.viewport + 1);
    assert(shareSize.scrollWidth <= shareSize.clientWidth + 2, 'Share dialog horizontal overflow');
    const shareDownloadPending = page.waitForEvent('download');
    await click(shareDialog.locator('.uc-share-download'));
    const shareDownload = await shareDownloadPending,
      sharedPNG = await readDownload(shareDownload),
      sharedPNGInfo = await sharp(sharedPNG).metadata();
    assert.match(shareDownload.suggestedFilename(), /^jotclipart-[a-z0-9-]+\.png$/);
    assert.equal(sharedPNGInfo.format, 'png');
    assert(
      sharedPNGInfo.width > 0 &&
        sharedPNGInfo.height > 0 &&
        Math.max(sharedPNGInfo.width, sharedPNGInfo.height) <= 2048,
    );
    await expect(shareDialog.locator('.uc-share-preview img')).toHaveJSProperty(
      'naturalWidth',
      sharedPNGInfo.width,
    );
    await expect(shareDialog.locator('.uc-share-preview img')).toHaveJSProperty(
      'naturalHeight',
      sharedPNGInfo.height,
    );
    report.downloads.push({
      kind: 'actual-share-derived-PNG',
      id: shareID,
      bytes: sharedPNG.length,
      sha256: sha(sharedPNG),
      filename: shareDownload.suggestedFilename(),
      width: sharedPNGInfo.width,
      height: sharedPNGInfo.height,
    });
    await page.screenshot({ path: join(dir, 'share.png') });
    await page.keyboard.press('Escape');
    await expect(shareDialog).toHaveCount(0);
    assert.equal(await shareTrigger.evaluate((button) => document.activeElement === button), true);
    await layout(page);
    check(
      'Actual gallery-card Share opens one responsive dialog, validates original CORS/source, downloads a branded PNG and restores keyboard focus',
      {
        id: shareID,
        originalSHA256: sha(shareSourceBytes),
        originalBytes: shareSourceBytes.length,
        nativeOSShareInvoked: false,
        publicShareCreated: false,
      },
    );
    const cold = await navigate(page, pin.sample.canonicalPath);
    await expect(page.locator('h1')).toHaveText(/^Free (?!Free )/);
    const record = await page
      .locator('script[data-download-record]')
      .evaluate((el) => JSON.parse(el.textContent));
    assert.equal(record.id, pin.sample.id);
    assert(new URL(record.webp).origin === 'https://assets.jotclipart.com');
    if (pin.exactBaselineMetadataRequired) {
      await expect(page.locator('h1')).toHaveText(pin.sample.displayTitle);
      assert.equal(record.title, pin.sample.sourceTitle);
      assert.equal(textHash(record.alt), pin.sample.altHash);
      assert.equal(
        textHash(await page.locator('meta[name=description]').getAttribute('content')),
        pin.sample.descriptionHash,
      );
    }
    await expect(page.locator('[data-related-root]')).toBeVisible();
    const related = page.locator('[data-related-id]:visible');
    assert((await related.count()) > 0);
    const ids = await related.evaluateAll((nodes) => nodes.map((n) => n.dataset.relatedId));
    assert.equal(new Set(ids).size, ids.length);
    assert(!ids.includes(record.id));
    await layout(page);
    await page.screenshot({ path: join(dir, 'art.png') });
    await settleBeforeDirectNavigation(page);
    const warm = await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(warm.headers()['x-uc-snapshot'], pin.snapshotRoot);
    check('Artwork metadata, related identity and cold/warm snapshot consistency', {
      coldCache: cold.headers()['x-uc-html-cache'],
      warmCache: warm.headers()['x-uc-html-cache'],
    });
    for (const format of ['webp', 'pdf']) {
      const source = record.download?.files?.[format];
      assert(source && source.bytes > 0 && /^[a-f0-9]{64}$/.test(source.sha256));
      if (pin.exactBaselineMetadataRequired) {
        const expected = pin.sample.media.find((m) => m.role === format);
        assert.equal(source.sha256, expected.sha256);
        assert.equal(source.bytes, expected.bytes);
      }
      const opener = page
        .locator(`[data-download-open="${record.id}"][data-download-format="${format}"]`)
        .first();
      await opener.scrollIntoViewIfNeeded();
      const beforePointerScroll = await page.evaluate(() => scrollY);
      // Pointer activation can scroll after an earlier visibility check. Capture
      // the real opening position before the application's document click handler.
      await opener.evaluate((link) => {
        link.removeAttribute('data-native-opening-scroll');
        link.addEventListener(
          'click',
          () => link.setAttribute('data-native-opening-scroll', String(scrollY)),
          { once: true, capture: true },
        );
      });
      await opener.click();
      const capturedScroll = await opener.getAttribute('data-native-opening-scroll'),
        scroll = Number(capturedScroll);
      assert(
        capturedScroll !== null && Number.isFinite(scroll),
        'Actual download opening scroll was not captured',
      );
      const dialog = page.locator('#download-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('[data-download-artwork]')).toHaveText(/^Free (?!Free )/);
      await click(dialog.locator('[data-download-select=pdf]'));
      await click(dialog.locator('[data-download-select=webp]'));
      await click(dialog.locator(`[data-download-select=${format}]`));
      const pending = page.waitForEvent('download');
      await click(dialog.locator('[data-download-save]'));
      const download = await pending,
        bytes = await readDownload(download);
      assert.equal(bytes.length, source.bytes);
      assert.equal(sha(bytes), source.sha256);
      assert(
        format === 'pdf'
          ? bytes.subarray(0, 5).toString() === '%PDF-'
          : bytes.subarray(0, 4).toString() === 'RIFF' &&
              bytes.subarray(8, 12).toString() === 'WEBP',
      );
      assert(
        download
          .suggestedFilename()
          .toLowerCase()
          .endsWith('.' + format),
      );
      report.downloads.push({
        kind: 'original-' + format,
        id: record.id,
        bytes: bytes.length,
        sha256: sha(bytes),
        filename: download.suggestedFilename(),
        beforePointerScroll,
        actualOpeningScroll: scroll,
      });
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute('data-download-open')),
        record.id,
      );
      const restoredScroll = await page.evaluate(() => scrollY);
      assert(
        Math.abs(restoredScroll - scroll) <= 2,
        JSON.stringify({ beforePointerScroll, actualOpeningScroll: scroll, restoredScroll }),
      );
    }
    check(
      'Actual original Image/PDF browser downloads, rapid format switch, Escape/focus/scroll restoration',
    );
    const favorite = page.locator(`[data-favorite="${record.id}"]`).first();
    if ((await favorite.getAttribute('aria-pressed')) !== 'true') await click(favorite);
    await expect(favorite).toHaveAttribute('aria-pressed', 'true');
    await navigate(page, '/search/?q=' + encodeURIComponent(pin.sample.topic) + '&type=artwork');
    await expect(page.locator('#search-results')).toHaveAttribute('aria-busy', 'false', {
      timeout: 30000,
    });
    assert((await page.locator('#search-results .art-card').count()) > 0);
    await page.locator('#search-query').fill(record.title.replace(/ clipart$/i, ''));
    // Submit the new query with the actual keyboard. The previous topic results
    // already include this artwork, so its visibility alone cannot prove the
    // debounced query has run before the following direct navigation.
    await page.locator('#search-query').press('Enter');
    await expect(page.locator('#search-results')).toHaveAttribute('aria-busy', 'false', {
      timeout: 30000,
    });
    await expect(page.locator(`#search-results [data-id="${record.id}"]`)).toBeVisible({
      timeout: 30000,
    });
    await layout(page);
    check('Actual search UI resolves the selected identity');
    await navigate(page, '/edit/' + record.id + '/');
    await expect(page.locator('.uc-editor')).not.toHaveAttribute('aria-busy', 'true', {
      timeout: 60000,
    });
    await expect(page.locator('.uc-workspace')).not.toHaveAttribute('inert', '', {
      timeout: 60000,
    });
    await expect(page.locator('[data-action=export]')).toBeEnabled();
    check('Original artwork opens in the real editor');
    await navigate(page, '/create/');
    const editor = page.locator('.uc-editor');
    await editor.scrollIntoViewIfNeeded();
    await expect(page.locator('.uc-workspace')).not.toHaveAttribute('inert', '', {
      timeout: 60000,
    });
    await click(page.locator('[data-panel=create]'));
    await click(page.locator('[data-shape=heart]'));
    const project = await saveProject(page);
    await click(page.locator('[data-action=export]'));
    const exportDialog = page.locator('[data-export-dialog]');
    await expect(exportDialog).toBeVisible();
    await click(exportDialog.locator('label:has([data-format][value=webp])'));
    await expect(exportDialog.locator('[data-format][value=webp]')).toBeChecked();
    await exportDialog.locator('[data-size]').selectOption('1024');
    const exported = page.waitForEvent('download');
    await click(exportDialog.locator('[data-action=download]'));
    const image = await exported,
      editedBytes = await readDownload(image);
    assert(
      editedBytes.subarray(0, 4).toString() === 'RIFF' &&
        editedBytes.subarray(8, 12).toString() === 'WEBP',
    );
    report.downloads.push({
      kind: 'actual-Studio-edited-WebP',
      bytes: editedBytes.length,
      sha256: sha(editedBytes),
    });
    await click(exportDialog.locator('[data-action=close-export]'));
    await page.screenshot({ path: join(dir, 'studio.png') });
    check('Actual Studio shape edit, portable project save and rendered WebP export');
    await navigate(page, '/favorites/');
    await expect(page.locator('#favorites')).toHaveAttribute('aria-busy', 'false', {
      timeout: 45000,
    });
    assert((await page.locator(`#favorites [data-id="${record.id}"]`).count()) > 0);
    await click(page.locator('[data-board-create]'));
    const board = page.locator('#board-dialog');
    await board.locator('[name=title]').fill('CI ' + engine + ' ' + width);
    await board.locator('button[type=submit]').click();
    await expect(board).not.toBeVisible();
    const boards = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('ultraclipart-favorite-boards-v1')),
    );
    const boardId = boards.boards.find((b) => b.title === 'CI ' + engine + ' ' + width).id;
    await click(page.locator('[data-board=all]'));
    await expect(page.locator('#favorites')).toHaveAttribute('aria-busy', 'false', {
      timeout: 45000,
    });
    await click(page.locator('#favorites-select'));
    await click(page.locator(`[data-favorite-select="${record.id}"]`));
    await page.locator('#favorites-bulk-board').selectOption(boardId);
    await click(page.locator('#favorites-bulk-add'));
    const backupPending = page.waitForEvent('download');
    await click(page.locator('#boards-export'));
    const backup = await readDownload(await backupPending, 5_000_000),
      backupData = JSON.parse(backup);
    assert.equal(backupData.application, 'jotclipart-board-backup');
    assert(backupData.favorites.includes(record.id));
    assert(backupData.state.entries[record.id].boards.includes(boardId));
    check('Favorite, real board organization and portable legacy-compatible backup');
    const fresh = await guard(
      await browser.newContext({ viewport: report.viewport, acceptDownloads: true }),
    );
    const restored = await fresh.newPage();
    currentPage = restored;
    await navigate(restored, '/favorites/');
    await restored
      .locator('#boards-import-file')
      .setInputFiles({ name: 'boards.json', mimeType: 'application/json', buffer: backup });
    await expect(restored.locator(`[data-board="${boardId}"]`)).toBeVisible();
    await expect(restored.locator('#favorites')).toHaveAttribute('aria-busy', 'false', {
      timeout: 45000,
    });
    assert((await restored.locator(`#favorites [data-id="${record.id}"]`).count()) > 0);
    check('Actual backup file imports into a clean browser context');
    await navigate(restored, '/create/');
    await restored.locator('.uc-editor').scrollIntoViewIfNeeded();
    await expect(restored.locator('.uc-workspace')).not.toHaveAttribute('inert', '', {
      timeout: 60000,
    });
    await restored
      .locator('[data-load]')
      .setInputFiles({ name: 'project.json', mimeType: 'application/json', buffer: project.bytes });
    await expect(restored.locator('[data-status]')).toContainText('Saved project opened');
    const reopened = await saveProject(restored);
    assert.deepEqual(reopened.doc.layers, project.doc.layers);
    check('Actual editable project file restores all accepted layers in a clean context');
    const noJS = await guard(
      await browser.newContext({ viewport: report.viewport, javaScriptEnabled: false }),
    );
    const plain = await noJS.newPage();
    await navigate(plain, pin.sample.canonicalPath, { javascript: false });
    for (const format of ['webp', 'pdf'])
      assert.equal(
        new URL(
          await plain.locator(`[data-download-format="${format}"]`).first().getAttribute('href'),
        ).origin,
        'https://assets.jotclipart.com',
      );
    check('No-JavaScript original file links retain the new independent media origin');
    const after = await release();
    assert.equal(after.verifiedRoot, pin.snapshotRoot);
    assert.equal(report.blockedOldHostRequests.length, 0, 'A critical flow attempted an old host');
    assert.equal(report.unexpectedMutationAttempts.length, 0, 'Unexpected AI/share write attempt');
    assert.equal(report.pageErrors.length, 0, 'Uncaught browser application error');
    assert.equal(
      report.badSoftwareResources.length,
      0,
      'A new site software/image/font resource failed',
    );
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL';
    report.error = error.stack ?? error.message;
    try {
      await currentPage?.screenshot({ path: join(dir, 'failure.png') });
    } catch {}
    process.exitCode = 1;
  } finally {
    report.completedAt = new Date().toISOString();
    report.sourceGETs = sourceGETs;
    report.fullCanonicalHTTPAuditClaim = false;
    report.privateR2InventoryRerunClaim = false;
    writeFileSync(join(dir, 'result.json'), JSON.stringify(report, null, 2));
    for (const context of contexts) await context.close();
    await browser.close();
    console.log(
      JSON.stringify({
        ...report,
        pageErrors: report.pageErrors.length,
        blockedOldHostRequests: report.blockedOldHostRequests.length,
      }),
    );
  }
}
if (mode === 'pin') await pinPreview();
else if (mode === 'browser') await browserFlow();
else throw Error('Choose pin or browser');
