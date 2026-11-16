import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { chromium, firefox, webkit, expect } from '@playwright/test';

const mode = process.argv[2] ?? 'browser',
  base = process.env.BASE_URL ?? 'https://migration-preview.jotclipart.pages.dev';
const wanted = process.env.EXPECT_REVISION ?? process.env.GITHUB_SHA;
assert(/^[a-f0-9]{40}$/.test(wanted ?? ''), 'A real source commit is required');
const origin = new URL(base).origin;
assert(
  base === origin && /^https:\/\/(?:[a-z0-9-]+\.)?jotclipart\.pages\.dev$/.test(origin),
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
async function get(path) {
  await delay(40);
  sourceGETs++;
  const response = await fetch(origin + path, {
    redirect: 'manual',
    headers: { 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(60000),
  });
  assert.equal(response.status, 200, 'Source GET ' + path);
  return response;
}
async function release() {
  const r = await get('/delivery-release.json');
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
      before = await release();
      break;
    } catch (error) {
      last = error.message;
      console.log(
        JSON.stringify({ phase: 'waiting-for-owner-preview-deployment', expectedCommit: wanted }),
      );
      await delay(15000);
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
  for (const row of baseline) {
    assert(
      families.art.has(row.canonicalPath) && families.images.has(row.canonicalPath),
      'An accepted canonical path disappeared',
    );
    if (exactRoot)
      assert.equal(
        families.images.get(row.canonicalPath),
        row.media.find((m) => m.role === 'webp').objectKey,
        'Unchanged-root artwork points to a different R2 original',
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
    sitemaps,
    baselineCanonicalPathsPresent: baseline.length,
    unchangedRootR2KeysCompared: exactRoot ? baseline.length : 0,
    sameR2BucketEvidence:
      'Existing signed source baseline object keys preserved; no private R2 inventory is rerun by CI.',
    sourceGETs,
    maximumExplicitSourceGETRatePerSecond: 25,
    sample: chosen,
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
      page.on('pageerror', (e) => report.pageErrors.push(e.message));
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
    const choice = p.locator('[data-cookie-choice=necessary]:visible').first();
    if (await choice.count()) await choice.click();
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
  const navigate = async (p, path) => {
    const r = await p.goto(origin + path, { waitUntil: 'domcontentloaded' });
    assert.equal(r.status(), 200, path);
    assert.equal(r.headers()['x-uc-snapshot'], pin.snapshotRoot, 'Mixed snapshot on ' + path);
    await dismiss(p);
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
    await expect(wordmark).toHaveJSProperty('naturalWidth', 1200);
    await expect(wordmark).toHaveJSProperty('naturalHeight', 314);
    const logoSHA = sha(
      Buffer.from(await (await get('/brand/jotclipart-logo-3d.webp')).arrayBuffer()),
    );
    assert.equal(logoSHA, sha(readFileSync('public/brand/jotclipart-logo-3d.webp')));
    await expect(page).toHaveTitle(/Free.*JotClipart/);
    await layout(page);
    await page.screenshot({ path: join(dir, 'home.png') });
    check('Homepage branding, typography load and responsive viewport', { logoSHA256: logoSHA });
    await navigate(page, '/clipart/' + pin.sample.topic + '/');
    await expect(page.locator('h1')).toHaveText(/^Free (?!Free )/);
    assert((await page.locator('.art-card').count()) > 0);
    await layout(page);
    check('Topic gallery and one Free prefix');
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
      const scroll = await page.evaluate(() => scrollY);
      await opener.click();
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
      });
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute('data-download-open')),
        record.id,
      );
      assert(Math.abs((await page.evaluate(() => scrollY)) - scroll) <= 2);
    }
    check(
      'Actual original Image/PDF browser downloads, rapid format switch, Escape/focus/scroll restoration',
    );
    const favorite = page.locator(`[data-favorite="${record.id}"]`).first();
    if ((await favorite.getAttribute('aria-pressed')) !== 'true') await click(favorite);
    await expect(favorite).toHaveAttribute('aria-pressed', 'true');
    await navigate(page, '/search/?q=' + encodeURIComponent(pin.sample.topic) + '&type=artwork');
    await expect(page.locator('#search-results')).toHaveAttribute('aria-busy', 'false');
    assert((await page.locator('#search-results .art-card').count()) > 0);
    await page.locator('#search-query').fill(record.title.replace(/ clipart$/i, ''));
    await expect(page.locator(`#search-results [data-id="${record.id}"]`)).toBeVisible();
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
    await exportDialog.locator('[data-format][value=webp]').check();
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
    await expect(page.locator('#favorites')).toHaveAttribute('aria-busy', 'false');
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
    await expect(page.locator('#favorites')).toHaveAttribute('aria-busy', 'false');
    await click(page.locator('#favorites-select'));
    await click(page.locator(`[data-favorite-select="${record.id}"]`));
    await page.locator('#favorites-bulk-board').selectOption(boardId);
    await click(page.locator('#favorites-bulk-add'));
    const backupPending = page.waitForEvent('download');
    await click(page.locator('#boards-export'));
    const backup = await readDownload(await backupPending, 5_000_000),
      backupData = JSON.parse(backup);
    assert.equal(backupData.application, 'ultraclipart-board-backup');
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
    await expect(restored.locator('#favorites')).toHaveAttribute('aria-busy', 'false');
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
    await navigate(plain, pin.sample.canonicalPath);
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
