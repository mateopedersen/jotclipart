import { observeCatalogRequests, settleBeforeDirectNavigation } from './browser-readiness.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { inflateRawSync } from 'node:zlib';
import { chromium, firefox, webkit, expect } from '@playwright/test';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { readBackup, fingerprint } from '../../public/move-your-work/transfer.js';

// This runner launches isolated CI browser contexts only. It never attaches to a
// desktop browser, imports a real visitor's storage, or calls AI/share writes.
const engine = process.env.UC_BROWSER ?? 'chromium';
const width = Number(process.env.VIEWPORT_WIDTH ?? 1440);
const base = process.env.BASE_URL ?? 'https://preview.jotclipart.com';
const revision = process.env.EXPECT_REVISION ?? process.env.GITHUB_SHA;
const origin = new URL(base).origin;
assert(['chromium', 'firefox', 'webkit'].includes(engine));
assert([320, 390, 768, 1440].includes(width));
assert.equal(base, origin);
assert(
  origin === 'https://preview.jotclipart.com' ||
    /^https:\/\/(?:[a-z0-9-]+\.)?jotclipart\.pages\.dev$/.test(origin),
);
assert(/^[a-f0-9]{40}$/.test(revision ?? ''), 'A real expected source revision is required');
const out = resolve('reports/jotclipart-native-browser', `${engine}-${width}`);
mkdirSync(out, { recursive: true });
const pin = JSON.parse(readFileSync('reports/jotclipart-native-browser/preview-pin.json'));
assert.equal(pin.sourceCommit, revision);
assert.equal(pin.url, origin);
assert(/^[a-f0-9]{64}$/.test(pin.snapshotRoot));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const workbenchSource = stripTypeScriptTypes(
  readFileSync('src/editor/workbench/catalog.ts', 'utf8'),
  { mode: 'transform' },
);
const { workbenchCommands } = await import(
  'data:text/javascript;base64,' + Buffer.from(workbenchSource).toString('base64')
);
assert.equal(workbenchCommands.length, 100);
const commandNames = new Map(workbenchCommands.map(([id, name]) => [id, name]));
const report = {
  status: 'RUNNING',
  at: new Date().toISOString(),
  engine,
  viewport: { width, height: width < 768 ? 844 : 1000 },
  origin,
  sourceCommit: revision,
  snapshotRoot: pin.snapshotRoot,
  scope:
    'Real independent preview browser actions and downloaded bytes; synthetic private storage exists only in isolated test contexts. Cross-origin portability serves the exact deployed helper bytes on two ephemeral loopback origins. No owner browser or production data writes.',
  checks: [],
  downloads: [],
  failures: [],
  pageErrors: [],
  oldHostRequests: [],
  unexpectedWrites: [],
  readOnlyCatalogPOSTs: {},
  actualAIInference: false,
  actualPublicShareMutation: false,
  ownerPrivateDataRead: false,
};
const oldHost = (host) =>
  /(^|\.)ultraclipart\.(?:com|pages\.dev)$/.test(host) ||
  (/ultraclipart/i.test(host) && host.endsWith('.workers.dev'));
let browser;
const temporaryProfiles = new Map();
const contexts = [],
  servers = [];
let currentPage;
async function release() {
  const response = await fetch(origin + '/delivery-release.json', {
    signal: AbortSignal.timeout(60000),
    headers: { 'Cache-Control': 'no-cache' },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.controlRevision, revision);
  assert.equal(body.verifiedRoot, pin.snapshotRoot);
  return body;
}
async function context(options = {}, binaryTransfer = false) {
  const settings = { viewport: report.viewport, acceptDownloads: true, ...options };
  let value;
  if (binaryTransfer && engine === 'webkit') {
    // WebKit ephemeral contexts cannot store Blob objects in IndexedDB. Use an
    // isolated disposable profile, preserving the full Blob/ArrayBuffer test.
    const profile = mkdtempSync(join(tmpdir(), 'jotclipart-transfer-test-'));
    value = await webkit.launchPersistentContext(profile, { headless: true, ...settings });
    temporaryProfiles.set(value, profile);
  } else value = await browser.newContext(settings);
  value.setDefaultNavigationTimeout(60000);
  contexts.push(value);
  let starts = [];
  await value.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (oldHost(url.hostname)) {
      report.oldHostRequests.push(url.origin + url.pathname);
      return route.abort();
    }
    let readOnlyCatalogPOST = false;
    if (
      request.method() === 'POST' &&
      url.origin === origin &&
      url.pathname === '/catalog-search.json' &&
      !url.search
    ) {
      // The native catalog uses bounded POST queries for read-only snapshot
      // lookup/search. This does not authorize AI, shares or other mutations.
      try {
        const bytes = request.postData() ?? '';
        if (Buffer.byteLength(bytes) <= 65536) {
          const body = JSON.parse(bytes);
          readOnlyCatalogPOST =
            body.schema === 1 &&
            body.snapshot === pin.snapshotRoot &&
            ['search', 'suggest', 'items', 'site', 'studio'].includes(body.operation);
          if (readOnlyCatalogPOST)
            report.readOnlyCatalogPOSTs[body.operation] =
              (report.readOnlyCatalogPOSTs[body.operation] ?? 0) + 1;
        }
      } catch {
        /* Invalid or unknown POSTs remain blocked below. */
      }
    }
    if (
      request.method() !== 'GET' &&
      request.method() !== 'HEAD' &&
      url.origin === origin &&
      !readOnlyCatalogPOST
    ) {
      report.unexpectedWrites.push({
        method: request.method(),
        path: url.pathname,
      });
      return route.abort();
    }
    if (url.origin === origin && ['document', 'fetch', 'xhr'].includes(request.resourceType())) {
      const now = Date.now();
      starts = starts.filter((time) => time > now - 1000);
      if (starts.length >= 25) await delay(Math.max(0, 1000 - (now - starts[0])));
      starts.push(Date.now());
    }
    return route.continue();
  });
  value.on('page', (page) => {
    observeCatalogRequests(page, origin);
    page.on('pageerror', (error) => report.pageErrors.push(error.message));
  });
  return value;
}
async function pageFor(path, options) {
  const ctx = await context(options),
    page = await ctx.newPage();
  currentPage = page;
  await navigate(page, path);
  return { ctx, page };
}
async function navigate(page, path) {
  await settleBeforeDirectNavigation(page);
  const response = await page.goto(origin + path, {
    waitUntil: 'domcontentloaded',
  });
  assert.equal(response.status(), 200, path);
  assert.equal(response.headers()['x-uc-snapshot'], pin.snapshotRoot, 'Mixed signed catalog root');
  await dismissCookies(page);
  return response;
}
async function dismissCookies(page) {
  await page.waitForFunction(() => typeof window.__ucCookieNoticeReady?.then === 'function', null, {
    timeout: 10000,
  });
  await page.evaluate(async () => {
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
  const choice = page.locator('#cookie-notice [data-cookie-choice=necessary]:visible').first();
  if (await choice.count()) await choice.click();
  await expect(page.locator('#cookie-notice')).not.toBeVisible();
}
async function click(locator) {
  await locator.scrollIntoViewIfNeeded();
  await locator.click();
}
async function downloadBytes(download, limit = 32 * 1024 * 1024) {
  const stream = await download.createReadStream();
  assert(stream);
  let size = 0;
  const chunks = [];
  for await (const part of stream) {
    size += part.length;
    assert(size <= limit);
    chunks.push(part);
  }
  assert.equal(await download.failure(), null);
  return Buffer.concat(chunks);
}
async function saveProject(page) {
  const menu = page.locator('.wb-file-menu');
  if ((await menu.getAttribute('open')) === null) await click(menu.locator('summary'));
  const waiting = page.waitForEvent('download');
  await click(menu.locator('[data-action=save]'));
  const download = await waiting,
    bytes = await downloadBytes(download, 8 * 1024 * 1024),
    doc = JSON.parse(bytes);
  assert(Array.isArray(doc.layers));
  assert(!('_ucRecovery' in doc));
  return { bytes, doc, name: download.suggestedFilename() };
}
async function editorReady(page) {
  await dismissCookies(page);
  await page.locator('.uc-editor').scrollIntoViewIfNeeded();
  await expect(page.locator('.uc-editor')).not.toHaveAttribute('aria-busy', 'true', {
    timeout: 60000,
  });
  await expect(page.locator('.uc-workspace')).not.toHaveAttribute('inert', '', {
    timeout: 60000,
  });
}
async function openProject(page, doc) {
  await page.locator('[data-load]').setInputFiles({
    name: 'legacy-project.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  await expect(page.locator('[data-status]')).toContainText('Saved project opened');
}
async function runCommand(page, id, value = '24') {
  await page.keyboard.press('Control+k');
  const palette = page.locator('[data-wb-palette]');
  await expect(palette).toBeVisible();
  await click(palette.locator('[data-wb-list=all]'));
  await palette.locator('[data-wb-category]').selectOption('all');
  await palette.locator('[data-wb-search]').fill(commandNames.get(id));
  await click(palette.locator(`[data-wb-run="${id}"]`));
  const param = page.locator('[data-wb-parameter-dialog]');
  if (await param.isVisible()) {
    if (await param.locator('[data-wb-value]').isVisible())
      await param.locator('[data-wb-value]').fill(value);
    if (id === 'text-replace') await param.locator('[data-wb-second]').fill('REPLACED');
    if (['restore-checkpoint', 'delete-checkpoint'].includes(id))
      await param.locator('[data-wb-checkpoint]').selectOption({ index: 0 });
    await click(param.locator('button[type=submit]'));
    await expect(param).not.toBeVisible();
  }
  await expect(page.locator('[data-status]')).not.toHaveAttribute('data-error', 'true');
}
async function check(id, operation) {
  const row = { id, status: 'RUNNING' },
    start = Date.now(),
    contextStart = contexts.length;
  try {
    Object.assign(row, await operation());
    row.status = 'PASS';
  } catch (error) {
    row.status = 'FAIL';
    row.error = error.stack ?? String(error);
    report.failures.push({ id, message: error.message });
    try {
      await currentPage?.screenshot({
        path: join(out, `feature-failure-${id}.png`),
      });
    } catch {}
  }
  for (const value of contexts.slice(contextStart)) await value.close().catch(() => {});
  row.elapsedMs = Date.now() - start;
  report.checks.push(row);
  writeFileSync(join(out, 'feature-result.json'), JSON.stringify(report, null, 2));
}
function zipEntries(bytes) {
  const entries = new Map();
  let cursor = 0;
  while (cursor + 30 <= bytes.length && bytes.readUInt32LE(cursor) === 0x04034b50) {
    assert(!(bytes.readUInt16LE(cursor + 6) & 8), 'Unsupported data-descriptor ZIP');
    const method = bytes.readUInt16LE(cursor + 8),
      size = bytes.readUInt32LE(cursor + 18),
      nameSize = bytes.readUInt16LE(cursor + 26),
      extraSize = bytes.readUInt16LE(cursor + 28);
    const name = bytes.subarray(cursor + 30, cursor + 30 + nameSize).toString();
    const start = cursor + 30 + nameSize + extraSize,
      raw = bytes.subarray(start, start + size);
    assert(start + size <= bytes.length && !entries.has(name));
    assert([0, 8].includes(method));
    entries.set(name, method === 0 ? raw : inflateRawSync(raw));
    cursor = start + size;
  }
  assert(entries.size >= 6);
  return entries;
}
const png = await sharp({
  create: {
    width: 32,
    height: 32,
    channels: 4,
    background: { r: 30, g: 90, b: 190, alpha: 1 },
  },
})
  .png()
  .toBuffer();
const rasterSHA = sha(png),
  localID = 'local-' + rasterSHA;
const vector = (id, x, y, extra = {}) => ({
  id,
  kind: 'vector',
  label: id,
  markup: '<rect width="120" height="80" fill="#1464d4" stroke="#203040" stroke-width="3"/>',
  x,
  y,
  scaleX: 1,
  scaleY: 1,
  angle: 0,
  visible: true,
  locked: false,
  opacity: 1,
  ...extra,
});
const fixture = {
  version: 2,
  artId: 'my-clipart',
  title: 'Çiçek & Yıldız 2026',
  width: 800,
  height: 600,
  background: 'transparent',
  crop: null,
  print: { paper: 'a4', orientation: 'landscape', margin: 0.5, scale: 'fit' },
  localSources: [
    {
      id: localID,
      sha256: rasterSHA,
      data: 'data:image/png;base64,' + png.toString('base64'),
    },
  ],
  layers: [
    vector('blue-card', 320, 180),
    vector('second-card', 60, 60, {
      markup:
        '<ellipse cx="75" cy="50" rx="75" ry="50" fill="#db536b" stroke="#552233" stroke-width="2"/>',
      opacity: 0.7,
      angle: 12,
    }),
    vector('hidden-card', 10, 10, { visible: false }),
    vector('locked-card', 630, 490, { locked: true }),
    vector('outside-card', 950, 100),
    {
      id: 'heading',
      kind: 'text',
      label: 'Heading',
      text: '  HELLO   world\nnew LINE ',
      size: 32,
      color: '#153250',
      bold: true,
      align: 'start',
      x: 90,
      y: 360,
      scaleX: 1,
      scaleY: 1,
      angle: 0,
      visible: true,
      locked: false,
      opacity: 1,
    },
    {
      id: 'caption',
      kind: 'text',
      label: 'Caption',
      text: 'Second line\nfirst line',
      size: 24,
      color: '#552233',
      bold: false,
      align: 'start',
      x: 420,
      y: 420,
      scaleX: 1,
      scaleY: 1,
      angle: 0,
      visible: true,
      locked: false,
      opacity: 0.8,
    },
    {
      id: 'empty-text',
      kind: 'text',
      label: 'Empty',
      text: '',
      size: 20,
      color: '#1464d4',
      bold: false,
      align: 'start',
      x: 50,
      y: 100,
      scaleX: 1,
      scaleY: 1,
      angle: 0,
      visible: true,
      locked: false,
      opacity: 1,
    },
    {
      id: 'fixture-image',
      kind: 'raster',
      label: 'Synthetic image',
      assetId: localID,
      sourceSha256: rasterSHA,
      width: 32,
      height: 32,
      x: 420,
      y: 80,
      scaleX: 5,
      scaleY: 5,
      angle: 0,
      visible: true,
      locked: false,
      opacity: 1,
    },
  ],
};

async function exportFormats() {
  const { page } = await pageFor('/create/');
  await page.evaluate(() => {
    window.__featureDownloadNames = [];
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node instanceof HTMLAnchorElement && node.download)
            window.__featureDownloadNames.push(node.download);
    }).observe(document.body, { childList: true, subtree: true });
  });
  await editorReady(page);
  await openProject(page, fixture);
  await click(page.locator('[data-action=export]'));
  const dialog = page.locator('[data-export-dialog]');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-format]')).toHaveCount(6);
  await dialog.locator('[data-filename]').fill(fixture.title);
  await dialog.locator('[data-filename]').press('Tab');
  const formats = [];
  for (const format of ['png', 'jpg', 'webp', 'svg', 'pdf', 'docx']) {
    await click(dialog.locator(`label:has([data-format][value="${format}"])`));
    await expect(dialog.locator(`[data-format][value="${format}"]`)).toBeChecked();
    if (['png', 'jpg', 'webp'].includes(format))
      await dialog.locator('[data-size]').selectOption('1024');
    if (format === 'pdf') await dialog.locator('[data-allow-large-pdf]').check();
    const waiting = page.waitForEvent('download', { timeout: 120000 });
    await click(dialog.locator('[data-action=download]'));
    const download = await waiting,
      bytes = await downloadBytes(download),
      name = download.suggestedFilename();
    await expect
      .poll(() => page.evaluate(() => window.__featureDownloadNames.at(-1)))
      .toBe(`${fixture.title}.${format}`);
    // The browser may replace spaces in its native suggested filename on Linux
    // WebKit. The exact requested name is checked independently before download.
    assert(
      [
        `${fixture.title}.${format}`,
        ...(engine === 'webkit' ? [`${fixture.title.replaceAll(' ', '_')}.${format}`] : []),
      ].includes(name.normalize('NFC')),
    );
    const evidence = { format, bytes: bytes.length, sha256: sha(bytes), name };
    if (['png', 'jpg', 'webp'].includes(format)) {
      const metadata = await sharp(bytes).metadata();
      assert.equal(metadata.width, 1024);
      assert.equal(metadata.height, 768);
      assert.equal(metadata.format, format === 'jpg' ? 'jpeg' : format);
      const pixel = await sharp(bytes)
        .extract({ left: 0, top: 0, width: 1, height: 1 })
        .ensureAlpha()
        .raw()
        .toBuffer();
      assert.equal(pixel[3], format === 'jpg' ? 255 : 0);
      Object.assign(evidence, {
        width: metadata.width,
        height: metadata.height,
        cornerAlpha: pixel[3],
      });
    } else if (format === 'pdf') {
      assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
      const doc = await PDFDocument.load(bytes);
      assert.equal(doc.getPageCount(), 1);
      assert.equal(doc.getTitle(), fixture.title);
      const size = doc.getPage(0).getSize();
      assert(size.width > size.height);
      Object.assign(evidence, { pages: 1, title: doc.getTitle() });
    } else if (format === 'svg') {
      const svg = bytes.toString();
      assert(svg.includes('<svg'));
      assert(svg.includes('data:image/png;base64,'));
      assert(!svg.includes('blob:'));
      assert(svg.includes('Çiçek &amp; Yıldız 2026'));
    } else {
      const entries = zipEntries(bytes),
        xml = entries.get('word/document.xml').toString();
      assert(xml.includes('w:orient="landscape"'));
      assert(
        entries
          .get('word/_rels/document.xml.rels')
          .toString()
          .includes('Target="media/artwork.png"'),
      );
      assert(
        !entries.get('word/_rels/document.xml.rels').toString().includes('TargetMode="External"'),
      );
      assert.equal((await sharp(entries.get('word/media/artwork.png')).metadata()).format, 'png');
    }
    formats.push(evidence);
    report.downloads.push({ kind: 'Studio-generated', ...evidence });
  }
  await dialog.locator('[data-filename]').fill('');
  await click(dialog.locator('[data-action=download]'));
  await expect(page.locator('[data-status]')).toContainText('Enter a project name');
  await dialog.locator('[data-filename]').fill('Safe / filename : 2026.png');
  await click(dialog.locator('label:has([data-format][value=png])'));
  await expect(dialog.locator('[data-format][value=png]')).toBeChecked();
  const waiting = page.waitForEvent('download');
  await click(dialog.locator('[data-action=download]'));
  const safe = await waiting;
  await expect
    .poll(() => page.evaluate(() => window.__featureDownloadNames.at(-1)))
    .toBe('Safe filename 2026.png');
  assert(
    ['Safe filename 2026.png', ...(engine === 'webkit' ? ['Safe_filename_2026.png'] : [])].includes(
      safe.suggestedFilename().normalize('NFC'),
    ),
  );
  await downloadBytes(safe);
  await click(dialog.locator('[data-action=close-export]'));
  await expect(dialog).not.toBeVisible();
  return {
    formats,
    emptyNameRejected: true,
    unsafeFilenameNormalized: true,
    actualPrintDialogClaim: false,
  };
}

async function recoveryAndProject() {
  const { page } = await pageFor('/create/');
  await editorReady(page);
  await openProject(page, fixture);
  const first = await saveProject(page);
  assert.equal(first.doc.artId, 'my-clipart');
  assert.equal(first.doc.title, fixture.title);
  assert(
    first.doc.localSources.some((source) => source.id === localID && source.sha256 === rasterSHA),
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await editorReady(page);
  assert.deepEqual((await saveProject(page)).doc.layers, first.doc.layers);
  const newerTitle = 'Newer IndexedDB recovery fixture';
  await page.evaluate(async (title) => {
    const key = 'ultraclipart:editor:v1:my-clipart',
      older = JSON.parse(localStorage.getItem(key));
    if (!older?._ucRecovery) throw Error('Real recovery stamp was not saved');
    const newer = structuredClone(older);
    newer.title = title;
    newer._ucRecovery.revision += 10000;
    await new Promise((done, fail) => {
      const opening = indexedDB.open('ultraclipart-studio');
      opening.onerror = () => fail(opening.error);
      opening.onsuccess = () => {
        const db = opening.result,
          tx = db.transaction('projects', 'readwrite');
        tx.objectStore('projects').put(newer, key);
        tx.oncomplete = () => {
          db.close();
          done();
        };
        tx.onerror = () => {
          db.close();
          fail(tx.error);
        };
      };
    });
  }, newerTitle);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await editorReady(page);
  const recovered = await saveProject(page);
  assert.equal(recovered.doc.title, newerTitle);
  assert.deepEqual(recovered.doc.layers, first.doc.layers);
  const { page: clean } = await pageFor('/create/');
  await editorReady(clean);
  await openProject(clean, first.doc);
  const reopened = await saveProject(clean);
  assert.deepEqual(reopened.doc.layers, first.doc.layers);
  assert.deepEqual(reopened.doc.localSources, first.doc.localSources);
  await click(clean.locator('[data-panel=create]'));
  await click(clean.locator('[data-shape=heart]'));
  const edited = await saveProject(clean);
  assert.equal(edited.doc.layers.length, first.doc.layers.length + 1);
  await click(clean.locator('[data-action=undo]'));
  assert.deepEqual((await saveProject(clean)).doc.layers, first.doc.layers);
  await click(clean.locator('[data-action=redo]'));
  assert.deepEqual((await saveProject(clean)).doc.layers, edited.doc.layers);
  return {
    realReloadRecovery: true,
    newestIndexedDBWins: true,
    legacyLayerAndSourceChecksumsPreserved: true,
    cleanContextReopenEditSave: true,
    undoRedo: true,
    concurrentWriteRaceClaim: false,
  };
}

async function signedProjectCompatibility() {
  const { page } = await pageFor('/edit/' + pin.sample.id + '/');
  await editorReady(page);
  const descriptor = JSON.parse(
    await page.locator('.uc-editor').getAttribute('data-raster-source'),
  );
  assert.equal(new URL(descriptor.webp.url).origin, 'https://assets.jotclipart.com');
  const expected = pin.sample.media.find((media) => media.role === 'webp');
  if (pin.exactBaselineMetadataRequired) {
    assert.equal(descriptor.webp.sha256, expected.sha256);
    assert.equal(descriptor.webp.bytes, expected.bytes);
  }
  const original = await saveProject(page);
  assert.equal(original.doc.artId, pin.sample.id);
  const layer = original.doc.layers.find(
    (item) => item.kind === 'raster' && item.sourceSha256 === descriptor.webp.sha256,
  );
  assert(layer && layer.assetId, 'A stable source-bound original layer must exist');
  const { page: clean } = await pageFor('/edit/' + pin.sample.id + '/');
  await editorReady(clean);
  await openProject(clean, original.doc);
  const reopened = await saveProject(clean);
  assert.equal(reopened.doc.artId, original.doc.artId);
  assert.deepEqual(reopened.doc.layers, original.doc.layers);
  await click(clean.locator('[data-panel=create]'));
  await click(clean.locator('[data-shape=heart]'));
  const edited = await saveProject(clean);
  const same = edited.doc.layers.find((item) => item.id === layer.id);
  assert.equal(same.assetId, layer.assetId);
  assert.equal(same.sourceSha256, layer.sourceSha256);
  assert.equal(edited.doc.layers.length, original.doc.layers.length + 1);
  return {
    artId: original.doc.artId,
    sourceAssetId: layer.assetId,
    originalSourceSHA256: layer.sourceSha256,
    originalFileBytes: descriptor.webp.bytes,
    cleanContextOldFormatOpenEditSave: true,
    oldNetworkHostUsed: false,
  };
}

async function workbench() {
  const { page } = await pageFor('/create/');
  await editorReady(page);
  await openProject(page, fixture);
  await page.keyboard.press('Control+k');
  const palette = page.locator('[data-wb-palette]');
  await expect(palette).toBeVisible();
  await click(palette.locator('[data-wb-list=all]'));
  await palette.locator('[data-wb-category]').selectOption('all');
  await palette.locator('[data-wb-search]').fill('');
  const found = new Set();
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    for (const id of await palette
      .locator('[data-wb-run]')
      .evaluateAll((buttons) => buttons.map((button) => button.dataset.wbRun)))
      found.add(id);
    if (await palette.locator('[data-wb-more]').isDisabled()) break;
    await click(palette.locator('[data-wb-more]'));
  }
  assert.deepEqual([...found].sort(), [...commandNames.keys()].sort());
  await page.keyboard.press('Escape');
  const prefs = [];
  for (const [id, key] of [
    ['show-grid', 'grid'],
    ['show-rulers', 'rulers'],
    ['center-guides', 'center'],
    ['safe-guides', 'safe'],
    ['snap-grid', 'snap'],
    ['cursor-coordinates', 'cursor'],
  ]) {
    const before = await page.evaluate(
      (key) =>
        JSON.parse(localStorage.getItem('ultraclipart:studio:workbench:v1') || '{}')[key] ?? false,
      key,
    );
    await runCommand(page, id);
    const after = await page.evaluate(
      (key) => JSON.parse(localStorage.getItem('ultraclipart:studio:workbench:v1'))[key],
      key,
    );
    assert.equal(after, !before);
    prefs.push(id);
  }
  await runCommand(page, 'rename-project', 'Renamed native fixture');
  assert.equal((await saveProject(page)).doc.title, 'Renamed native fixture');
  await runCommand(page, 'save-checkpoint', 'Before extra heart');
  const checkpoint = await saveProject(page);
  await click(page.locator('[data-panel=create]'));
  await click(page.locator('[data-shape=heart]'));
  assert.equal((await saveProject(page)).doc.layers.length, checkpoint.doc.layers.length + 1);
  await runCommand(page, 'restore-checkpoint');
  assert.deepEqual((await saveProject(page)).doc.layers, checkpoint.doc.layers);
  await runCommand(page, 'select-text');
  await runCommand(page, 'text-upper');
  assert.equal(
    (await saveProject(page)).doc.layers.find((layer) => layer.id === 'heading').text,
    fixture.layers.find((layer) => layer.id === 'heading').text.toUpperCase(),
  );
  await runCommand(page, 'select-vector');
  await runCommand(page, 'full-opacity');
  assert(
    (await saveProject(page)).doc.layers
      .filter((layer) => layer.kind === 'vector' && layer.visible && !layer.locked)
      .every((layer) => layer.opacity === 1),
  );
  return {
    directoryCommands: found.size,
    actualExecuted: [
      ...prefs,
      'rename-project',
      'save-checkpoint',
      'restore-checkpoint',
      'select-text',
      'text-upper',
      'select-vector',
      'full-opacity',
    ],
    exhaustive100CommandExecutionClaim: false,
  };
}

async function allWorkbenchCommands() {
  const ctx = await context();
  // Isolated CI clipboard sink: verify the exact browser API handoff, without
  // claiming an operating-system clipboard or changing the owner's clipboard.
  await ctx.addInitScript(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.__featureCopiedText = text;
        },
        write: async (items) => {
          window.__featureCopiedImages = items.map((item) => item.types);
        },
      },
    }),
  );
  const page = await ctx.newPage();
  currentPage = page;
  await navigate(page, '/create/');
  await editorReady(page);
  const readState = () =>
    page.evaluate(() => {
      const value = JSON.parse(localStorage.getItem('ultraclipart:editor:v1:my-clipart'));
      if (value) delete value._ucRecovery;
      return value;
    });
  const closeDialogs = async () => {
    for (const dialog of await page.locator('.uc-editor dialog[open]').all()) {
      const close = dialog.locator('[data-wb-close]').first();
      if (await close.count()) await click(close);
      else await page.keyboard.press('Escape');
    }
  };
  const select = async (ids) => {
    const mobileInspector = await page.evaluate(
      () => matchMedia('(max-width: 800px), (pointer: coarse) and (max-height: 600px)').matches,
    );
    const viewCanvas = page.locator('.uc-properties [data-inspector-canvas]');
    if (mobileInspector && (await viewCanvas.isVisible())) {
      // Follow the responsive inspector's real exit control before reaching a
      // toolbar behind it. Opening a project does not reset the current panel.
      await click(viewCanvas);
      await expect(page.locator('.uc-editor')).toHaveAttribute('data-properties-collapsed', 'true');
    }
    await click(page.locator('.uc-tools [data-panel=layers]'));
    for (const [index, id] of ids.entries()) {
      const layer = page.locator(`[data-select="${id}"]`);
      await layer.scrollIntoViewIfNeeded();
      await layer.click({ modifiers: index ? ['Shift'] : [] });
    }
  };
  const mutating = new Set([
    'match-width',
    'match-height',
    'match-size',
    'match-rotation',
    'match-opacity',
    'swap-positions',
    'stack-horizontal',
    'stack-vertical',
    'reading-order',
    'reverse-order',
    'pack-rows',
    'pack-columns',
    'fit-safe',
    'mirror-layout-x',
    'mirror-layout-y',
    'lock-selection',
    'unlock-all',
    'hide-selection',
    'show-all',
    'solo-selection',
    'prefix-names',
    'number-names',
    'label-from-text',
    'delete-hidden',
    'delete-empty-text',
    'delete-outside',
    'text-upper',
    'text-lower',
    'text-title',
    'text-sentence',
    'text-trim',
    'text-join',
    'text-bullets',
    'text-numbers',
    'text-sequence',
    'text-replace',
    'text-sort-lines',
    'text-reverse-lines',
    'paste-style',
    'swap-paints',
    'remove-fill',
    'remove-stroke',
    'round-joins',
    'square-joins',
    'dashed-strokes',
    'full-opacity',
    'cut-selection',
    'paste-selection',
    'paste-in-place',
    'rename-project',
  ]);
  const executed = [],
    outputs = [];
  for (const [id, name, group] of workbenchCommands) {
    await closeDialogs();
    if (id !== 'end-solo') {
      await openProject(page, fixture);
      // Before comparing command effects, wait for the imported fixture's actual
      // recovery document. A read-only re-open of an identical original need not
      // create any recovery entry, so this wait belongs only to this edit fixture.
      await expect
        .poll(
          async () => {
            const actual = await readState();
            return (
              actual && {
                title: actual.title,
                width: actual.width,
                height: actual.height,
                layers: actual.layers,
              }
            );
          },
          { timeout: 10000 },
        )
        .toEqual({
          title: fixture.title,
          width: fixture.width,
          height: fixture.height,
          layers: fixture.layers,
        });
    }
    const text = id.startsWith('text-') || id === 'label-from-text';
    await select(
      text
        ? ['heading', 'caption']
        : id === 'paste-style'
          ? ['second-card']
          : ['blue-card', 'second-card'],
    );
    const before = JSON.stringify(await readState()),
      downloads = [],
      onDownload = (download) => downloads.push(download);
    page.on('download', onDownload);
    await runCommand(
      page,
      id,
      {
        'dock-width': '320',
        'grid-size': '32',
        'safe-size': '30',
        'select-name': 'card',
        'prefix-names': 'Project',
        'text-replace': 'HELLO',
        'save-checkpoint': 'Before changes',
        'rename-project': 'My New Project',
      }[id] ?? '24',
    );
    if (id === 'fullscreen' && (await page.evaluate(() => !!document.fullscreenElement)))
      await page.evaluate(() => document.exitFullscreen());
    if (id === 'space-pan') {
      await page.locator('.uc-stage').focus();
      await page.keyboard.down('Space');
      await page.keyboard.up('Space');
    }
    if (id.startsWith('command-')) await expect(page.locator('[data-wb-palette]')).toBeVisible();
    if (id === 'shortcut-guide')
      await expect(page.locator('[data-wb-output]')).toContainText('Command K');
    if (id === 'select-raster')
      await expect(page.locator('[data-select=fixture-image]')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    if (id === 'select-locked')
      await expect(page.locator('[data-select=locked-card]')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    if (id === 'select-hidden')
      await expect(page.locator('[data-select=hidden-card]')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    if (/^export-(?:svg|selected-svg|png|jpeg|selected-png|inventory|palette|text)$/.test(id)) {
      await expect.poll(() => downloads.length, { timeout: 60000 }).toBe(1);
      const download = downloads[0],
        bytes = await downloadBytes(download),
        name = download.suggestedFilename();
      assert(bytes.length > 10);
      if (name.endsWith('.svg')) assert(bytes.toString().includes('<svg'));
      if (name.endsWith('.png')) assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
      if (name.endsWith('.jpg')) assert.equal(bytes.readUInt16BE(0), 0xffd8);
      outputs.push({
        command: id,
        name,
        bytes: bytes.length,
        sha256: sha(bytes),
      });
    }
    if (id === 'copy-png')
      await expect
        .poll(() => page.evaluate(() => window.__featureCopiedImages?.[0]?.includes('image/png')), {
          timeout: 30000,
        })
        .toBe(true);
    if (id === 'copy-svg')
      await expect
        .poll(() => page.evaluate(() => window.__featureCopiedText ?? ''))
        .toContain('<svg');
    if (mutating.has(id))
      await expect
        .poll(async () => JSON.stringify(await readState()) !== before, {
          timeout: 15000,
          message: 'The actual document must change after ' + id,
        })
        .toBe(true);
    if (id === 'delete-outside') {
      const after = await readState();
      assert(!after.layers.some((layer) => layer.id === 'outside-card'));
      assert.equal(after.layers.length, fixture.layers.length - 1);
      assert(after.layers.some((layer) => layer.id === 'blue-card'));
    }
    page.off('download', onDownload);
    executed.push({ id, name, group });
  }
  assert.equal(executed.length, 100);
  return {
    commandsActivated: executed,
    exportedFiles: outputs,
    clipboardScope:
      'Browser write/writeText API handoff captured by an isolated fixture sink; no OS clipboard claim',
    mathematicalCorrectnessScope:
      'Actual browser activation/state-change guards plus separate source command unit tests; not fresh pixel evidence for every transformation',
  };
}

async function downloadControls() {
  const { ctx, page } = await pageFor(pin.sample.canonicalPath);
  const record = await page
    .locator('script[data-download-record]')
    .evaluate((node) => JSON.parse(node.textContent));
  assert.equal(record.id, pin.sample.id);
  const opener = page
    .locator(`[data-download-open="${record.id}"][data-download-format=webp]`)
    .first();
  await opener.scrollIntoViewIfNeeded();
  const scroll = await page.evaluate(() => scrollY),
    originalURL = page.url();
  await click(opener);
  const dialog = page.locator('#download-dialog');
  await expect(dialog).toBeVisible();
  assert.equal(page.url(), originalURL);
  let failures = 1,
    holding = false,
    heldResolve,
    releaseHold;
  const seen = [],
    handler = (download) => seen.push(download);
  page.on('download', handler);
  try {
    await ctx.route(record.webp, async (route) => {
      if (route.request().resourceType() !== 'fetch') return route.continue();
      if (failures-- > 0) return route.abort('failed');
      if (holding) {
        heldResolve();
        await new Promise((done) => {
          releaseHold = done;
        });
        return route.abort('aborted').catch(() => {});
      }
      return route.continue();
    });
    await click(dialog.locator('[data-download-save]'));
    await expect(dialog.locator('[data-download-status]')).toContainText('couldn’t verify');
    assert.equal(seen.length, 0);
    const retry = page.waitForEvent('download');
    await click(dialog.locator('[data-download-save]'));
    const webp = await retry,
      image = await downloadBytes(webp);
    assert.equal(sha(image), record.download.files.webp.sha256);
    assert.equal(image.length, record.download.files.webp.bytes);
    assert.equal(webp.suggestedFilename(), `${record.id}.webp`);
    holding = true;
    const held = new Promise((done) => {
      heldResolve = done;
    });
    await click(dialog.locator('[data-download-save]'));
    await Promise.race([
      held,
      delay(15000).then(() => {
        throw Error('The isolated pending download request did not start');
      }),
    ]);
    await click(dialog.locator('[data-download-select=pdf]'));
    releaseHold();
    holding = false;
    await expect(dialog.locator('[data-download-save]')).toHaveAttribute(
      'download',
      `${record.id}.pdf`,
    );
    await expect(dialog.locator('[data-download-save]')).not.toHaveAttribute('aria-busy', 'true');
    const next = page.waitForEvent('download');
    await click(dialog.locator('[data-download-save]'));
    const pdf = await next,
      pdfBytes = await downloadBytes(pdf);
    assert.equal(pdf.suggestedFilename(), `${record.id}.pdf`);
    assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');
    assert.equal(sha(pdfBytes), record.download.files.pdf.sha256);
    assert.equal(seen.length, 2);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute('data-download-open')),
      record.id,
    );
    assert(Math.abs((await page.evaluate(() => scrollY)) - scroll) <= 2);
    const actual = [
      { format: 'webp', bytes: image.length, sha256: sha(image) },
      { format: 'pdf', bytes: pdfBytes.length, sha256: sha(pdfBytes) },
    ];
    report.downloads.push(
      ...actual.map((row) => ({
        kind: 'signed-original-retry-switch',
        id: record.id,
        ...row,
      })),
    );
    return {
      injectedFailure: 'One bounded isolated fetch abort, then unchanged real origin bytes',
      realDownloads: actual,
      retry: true,
      pendingFormatChangeCancelsOldTransfer: true,
      staleDownloadEvents: 0,
      EscapeFocusAndScroll: true,
    };
  } finally {
    holding = false;
    releaseHold?.();
    page.off('download', handler);
    await ctx.unroute(record.webp).catch(() => {});
  }
}

async function artworkRelated() {
  const { page } = await pageFor(pin.sample.canonicalPath);
  const colors = await page
    .locator('.art-preview-controls [data-bg]')
    .evaluateAll((buttons) => buttons.map((button) => button.dataset.bg));
  assert(colors.length >= 4);
  for (const color of colors) {
    await click(page.locator(`.art-preview-controls [data-bg="${color}"]`));
    await expect(page.locator(`.art-preview-controls [data-bg="${color}"]`)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  }
  await expect(page.locator('[data-related-root]')).toBeVisible();
  const modes = await page
    .locator('[data-related-mode]')
    .evaluateAll((buttons) => buttons.map((button) => button.dataset.relatedMode));
  const results = [];
  for (const mode of modes) {
    const button = page.locator(`[data-related-mode="${mode}"]`);
    await button.scrollIntoViewIfNeeded();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await expect(page.locator('[data-related-root]')).not.toHaveAttribute('aria-busy', 'true', {
      timeout: 15000,
    });
    await button.click();
    // Best may already be pressed while its fresh-snapshot request is pending.
    // Wait for that real request to finish before the next filter activation.
    await expect(page.locator('[data-related-root]')).not.toHaveAttribute('aria-busy', 'true', {
      timeout: 15000,
    });
    await expect(page.locator(`[data-related-mode="${mode}"]`)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const ids = await page
      .locator('[data-related-id]:visible')
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.relatedId));
    assert.equal(new Set(ids).size, ids.length);
    assert(!ids.includes(pin.sample.id));
    for (const href of await page
      .locator('[data-related-id]:visible a[href^="/art/"]')
      .evaluateAll((links) => links.map((link) => link.getAttribute('href'))))
      assert(/^\/art\/[a-z0-9-]+\/$/.test(href));
    results.push({ mode, rendered: ids.length });
  }
  return {
    backgroundChoices: colors.length,
    relatedModes: results,
    sourceNotRepeated: true,
    duplicateIDs: 0,
  };
}

async function discoveryTools() {
  const { page } = await pageFor('/black-and-white/');
  const ready = async () => {
    await expect(page.locator('#bw-results')).toHaveAttribute('aria-busy', 'false', {
      timeout: 45000,
    });
    await expect(page.locator('#bw-error')).toBeHidden();
    await expect(page.locator('#bw-results')).toHaveJSProperty('hidden', false);
  };
  await ready();
  const queries = [];
  for (const query of ['sunflower', 'bunnies', 'elephant line drawing', 'sunflwer']) {
    await page.locator('#bw-query').fill(query);
    await click(page.locator('#bw-form button[type=submit]'));
    await ready();
    const count = await page.locator('#bw-results .art-card').count();
    assert(count > 0, `Black-and-white alias query: ${query}`);
    queries.push({ query, count });
  }
  await page.locator('#bw-sort').selectOption('newest');
  await ready();
  await page.reload();
  await ready();
  await expect(page.locator('#bw-sort')).toHaveValue('newest');
  await page.locator('#bw-query').fill('zzzz-impossible-native-fixture');
  await click(page.locator('#bw-form button[type=submit]'));
  await ready();
  await expect(page.locator('#bw-empty')).toBeVisible();
  await click(page.locator('#bw-show-all'));
  await ready();
  assert((await page.locator('#bw-results .art-card').count()) > 0);
  await navigate(page, '/print-size/');
  for (const [name, value] of [
    ['pixelsWide', '3000'],
    ['pixelsHigh', '2400'],
    ['printWidth', '10'],
  ])
    await page.locator(`[name="${name}"]`).fill(value);
  await page.locator('[name=units]').selectOption('in');
  await click(page.locator('#print-calculator-form button[type=submit]'));
  await expect(page.locator('#print-result')).toContainText('300');
  await expect(page.locator('#print-linked-value')).toContainText('8');
  await expect(page.locator('#print-error')).not.toBeVisible();
  await page.locator('[name=units]').selectOption('cm');
  await expect(page.locator('#print-linked-value')).toContainText('20.32');
  return {
    blackAndWhiteQueries: queries,
    sortPersisted: true,
    emptyAndReset: true,
    printKnown300PPI: true,
    unitsPreservePhysicalSize: true,
  };
}

async function searchFilters() {
  const { page } = await pageFor('/search/?q=bunnies&type=artwork');
  const ready = async () => {
    await expect(page.locator('#search-results')).toHaveAttribute('aria-busy', 'false', {
      timeout: 45000,
    });
    await expect(page.locator('#search-error')).toBeHidden();
    await expect(page.locator('#search-results')).toHaveJSProperty('hidden', false);
  };
  await ready();
  assert(
    (await page.locator('#search-results .art-card').count()) > 0,
    'Bunnies alias must resolve',
  );
  await page.locator('#filter-format').selectOption('pdf');
  await ready();
  await expect(page.locator('#filter-format')).toHaveValue('pdf');
  assert((await page.locator('#search-results .art-card').count()) > 0);
  await click(page.locator('#clear-filters'));
  await ready();
  await expect(page.locator('#filter-format')).toHaveValue('');
  await page.locator('#search-query').fill('');
  await page.locator('#search-query').press('Enter');
  await ready();
  await page.locator('#search-sort').selectOption('newest');
  await ready();
  const firstPage = await page
    .locator('#search-results .art-card')
    .evaluateAll((nodes) => nodes.map((node) => node.dataset.id));
  assert(firstPage.length > 0);
  await click(page.locator('#next-page'));
  await ready();
  await expect(page.locator('#page-position')).toHaveText(/^Page 2 of /);
  const nextPage = await page
    .locator('#search-results .art-card')
    .evaluateAll((nodes) => nodes.map((node) => node.dataset.id));
  assert(nextPage.length > 0);
  assert.notEqual(firstPage[0], nextPage[0]);
  assert(
    nextPage.every((id) => !firstPage.includes(id)),
    'Page boundaries must not repeat identities',
  );
  await click(page.locator('#previous-page'));
  await ready();
  await expect(page.locator('#search-results .art-card').first()).toHaveAttribute(
    'data-id',
    firstPage[0],
  );
  return {
    aliasQuery: 'bunnies',
    PDFfilterAndClear: true,
    sortNewest: true,
    nextPrevious: true,
    duplicateIDsAcrossPages: 0,
  };
}

async function helperServer(html, js, headers) {
  const server = createServer((request, response) => {
    if (request.url === '/move-your-work/transfer.js')
      return response.writeHead(200, { 'content-type': 'text/javascript' }).end(js);
    if (request.url === '/move-your-work/') return response.writeHead(200, headers).end(html);
    return response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${server.address().port}`;
}
async function seedStorage(page, data) {
  await page.evaluate(async ({ doc, favorite, note, binary, stamp }) => {
    localStorage.setItem('unrelated-private-fixture', 'DO NOT EXPORT SYNTHETIC VALUE');
    localStorage.setItem('ultraclipart-favorites', JSON.stringify(favorite));
    localStorage.setItem(
      'ultraclipart-favorite-boards-v1',
      JSON.stringify({
        schema: 1,
        boards: [
          {
            id: 'classroom',
            title: 'Classroom',
            description: note,
            color: 'sage',
            createdAt: stamp,
            updatedAt: stamp,
          },
        ],
        entries: {
          'my-clipart': { note, boards: ['classroom'], tags: ['Fixture'] },
        },
      }),
    );
    localStorage.setItem('ultraclipart:editor:v1:my-clipart', JSON.stringify(doc));
    async function put(name, store, keyPath, key, value) {
      await new Promise((done, fail) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore(store, keyPath ? { keyPath } : undefined);
        request.onerror = () => fail(request.error);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction(store, 'readwrite');
          keyPath ? tx.objectStore(store).put(value) : tx.objectStore(store).put(value, key);
          tx.oncomplete = () => {
            db.close();
            done();
          };
          tx.onerror = () => {
            db.close();
            fail(tx.error);
          };
        };
      });
    }
    await put('ultraclipart-studio', 'projects', null, 'ultraclipart:editor:v1:my-clipart', doc);
    if (binary) {
      const bytes = Uint8Array.from(atob(binary), (character) => character.charCodeAt(0));
      for (const [id, original] of [
        ['11111111-1111-4111-8111-111111111111', new Blob([bytes], { type: 'image/png' })],
        ['22222222-2222-4222-8222-222222222222', bytes.buffer],
      ]) {
        await put('ultraclipart-ai-history', 'images', 'id', id, {
          id,
          prompt: 'Synthetic test fixture; no AI inference',
          createdAt: stamp,
          original,
          originalType: 'image/png',
          model: 'fixture',
          style: 'fixture',
          width: 32,
          height: 32,
        });
      }
    }
  }, data);
}
async function helperExport(page) {
  const waiting = page.waitForEvent('download');
  await click(page.locator('#export'));
  const download = await waiting,
    bytes = await downloadBytes(download, 4 * 1024 * 1024);
  await expect(page.locator('#status')).toContainText('Backup checked and saved');
  return { bytes, parsed: await readBackup(bytes.toString()) };
}
async function helperImport(page, bytes) {
  await page.locator('#file').setInputFiles({
    name: 'synthetic-private-backup.json',
    mimeType: 'application/json',
    buffer: bytes,
  });
  await click(page.locator('#restore'));
  await expect(page.locator('#status')).toContainText('Restore checked');
}
async function portability() {
  const htmlResponse = await fetch(origin + '/move-your-work/', {
      signal: AbortSignal.timeout(60000),
    }),
    jsResponse = await fetch(origin + '/move-your-work/transfer.js', {
      signal: AbortSignal.timeout(60000),
    });
  assert.equal(htmlResponse.status, 200);
  assert.equal(jsResponse.status, 200);
  const html = Buffer.from(await htmlResponse.arrayBuffer()),
    js = Buffer.from(await jsResponse.arrayBuffer());
  assert.equal(sha(html), sha(readFileSync('public/move-your-work/index.html')));
  assert.equal(sha(js), sha(readFileSync('public/move-your-work/transfer.js')));
  const headers = {
    'content-type': 'text/html;charset=utf-8',
    'content-security-policy': htmlResponse.headers.get('content-security-policy'),
    'cache-control': 'private,no-store',
    'referrer-policy': 'no-referrer',
  };
  assert.match(headers['content-security-policy'], /connect-src 'none'/);
  const source = await helperServer(html, js, headers),
    destination = await helperServer(html, js, headers);
  assert.notEqual(source, destination);
  const ctx = await context({}, true),
    page = await ctx.newPage();
  currentPage = page;
  await page.goto(source + '/move-your-work/');
  await expect(page.locator('#status')).toContainText('No browser data has been read');
  await expect(page.locator('#shares')).not.toBeChecked();
  const stamp = new Date().toISOString();
  await seedStorage(page, {
    doc: fixture,
    favorite: ['my-clipart', pin.sample.id],
    note: 'Source note preserved literally',
    binary: png.toString('base64'),
    stamp,
  });
  const before = await helperExport(page);
  assert(!before.bytes.includes('DO NOT EXPORT'));
  assert(!before.parsed.records.some((record) => record.key === 'uc-public-shares-v1'));
  const sourceBinaries = before.parsed.records.filter(
    (record) => record.name === 'ultraclipart-ai-history',
  );
  assert.equal(sourceBinaries.length, 2);
  assert(sourceBinaries.some((record) => record.value.original instanceof Blob));
  assert(sourceBinaries.some((record) => record.value.original instanceof ArrayBuffer));
  for (const record of sourceBinaries) {
    const binary = record.value.original;
    assert.equal(
      sha(Buffer.from(binary instanceof Blob ? await binary.arrayBuffer() : binary)),
      rasterSHA,
    );
  }
  await page.goto(destination + '/move-your-work/');
  await expect(page.locator('#status')).toContainText('No browser data has been read');
  const destinationDoc = structuredClone(fixture);
  destinationDoc.title = 'Existing destination project must survive';
  await seedStorage(page, {
    doc: destinationDoc,
    favorite: ['destination-only'],
    note: 'Destination note must survive',
    stamp,
  });
  const old = await helperExport(page),
    invalid = Buffer.from(before.bytes.toString().replace('Source note', 'Edited note'));
  await page.locator('#file').setInputFiles({
    name: 'tampered.json',
    mimeType: 'application/json',
    buffer: invalid,
  });
  await click(page.locator('#restore'));
  await expect(page.locator('#status')).toContainText('Backup checksum failed');
  assert.equal(
    await fingerprint((await helperExport(page)).parsed.records),
    await fingerprint(old.parsed.records),
  );
  await helperImport(page, before.bytes);
  const merged = await helperExport(page);
  const local = new Map(
    merged.parsed.records
      .filter((record) => record.kind === 'local')
      .map((record) => [record.key, record.value]),
  );
  assert.deepEqual(JSON.parse(local.get('ultraclipart-favorites')), [
    'destination-only',
    'my-clipart',
    pin.sample.id,
  ]);
  assert.equal(
    JSON.parse(local.get('ultraclipart:editor:v1:my-clipart')).title,
    destinationDoc.title,
  );
  assert.equal(
    JSON.parse(local.get('ultraclipart-favorite-boards-v1')).entries['my-clipart'].note,
    'Destination note must survive',
  );
  const ai = merged.parsed.records.filter((record) => record.name === 'ultraclipart-ai-history');
  assert.equal(ai.length, 2);
  for (const record of ai)
    assert.equal(
      await fingerprint(record.value),
      await fingerprint(sourceBinaries.find((item) => item.key === record.key).value),
    );
  const conflictsWaiting = page.waitForEvent('download');
  await click(page.locator('#conflicts'));
  const conflicts = JSON.parse((await downloadBytes(await conflictsWaiting)).toString());
  assert.equal(conflicts.format, 'jotclipart-conflicting-versions-v1');
  assert(conflicts.records.length >= 2);
  await helperImport(page, before.bytes);
  const repeated = await helperExport(page);
  assert.equal(
    await fingerprint(merged.parsed.records),
    await fingerprint(repeated.parsed.records),
  );
  const conflictsAgain = page.waitForEvent('download');
  await click(page.locator('#conflicts'));
  const duplicateConflicts = JSON.parse((await downloadBytes(await conflictsAgain)).toString());
  assert.equal(duplicateConflicts.records.length, conflicts.records.length);
  await page.goto(source + '/move-your-work/');
  const sourceAfter = await helperExport(page);
  assert.equal(
    await fingerprint(sourceAfter.parsed.records),
    await fingerprint(before.parsed.records),
  );
  return {
    exactDeployedHelperSHA: sha(html),
    exactDeployedJavaScriptSHA: sha(js),
    sourceRecords: before.parsed.records.length,
    destinationRecords: merged.parsed.records.length,
    BlobAndArrayBufferFullSHA: true,
    checksumFailureBeforeWrites: true,
    existingDestinationKept: true,
    conflictRecords: conflicts.records.length,
    repeatedImportDedupe: true,
    sourceUnchanged: true,
    cookieOrSessionDump: false,
    realOwnerDataTransferredClaim: false,
  };
}

try {
  await release();
  browser = await { chromium, firefox, webkit }[engine].launch({
    headless: true,
  });
  for (const [id, operation] of [
    ['studio-six-formats', exportFormats],
    ['project-open-recovery', recoveryAndProject],
    ['signed-source-project-compatibility', signedProjectCompatibility],
    ['workbench-controls', workbench],
    ['all-100-workbench-commands', allWorkbenchCommands],
    ['download-retry-cancel-switch', downloadControls],
    ['art-background-related-modes', artworkRelated],
    ['discovery-and-print-tools', discoveryTools],
    ['search-filters-pagination', searchFilters],
    ['cross-origin-private-portability', portability],
  ])
    await check(id, operation);
  await release();
  assert.equal(report.oldHostRequests.length, 0, 'Old host dependency attempted');
  assert.equal(report.unexpectedWrites.length, 0, 'Unexpected live write attempted');
  assert.equal(report.pageErrors.length, 0, 'Uncaught application errors');
  report.status = report.failures.length ? 'FAIL' : 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.failures.push({
    id: 'runner-or-safety-gate',
    message: error.stack ?? String(error),
  });
} finally {
  for (const ctx of contexts) await ctx.close().catch(() => {});
  await browser?.close();
  for (const [context, profile] of temporaryProfiles) {
    try {
      await context.close();
      rmSync(profile, { recursive: true, force: true });
    } catch {
      report.retainedFixtureProfiles ??= [];
      report.retainedFixtureProfiles.push(profile);
    }
  }
  for (const server of servers) await new Promise((done) => server.close(done));
  report.completedAt = new Date().toISOString();
  writeFileSync(join(out, 'feature-result.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      status: report.status,
      engine,
      width,
      passed: report.checks.filter((row) => row.status === 'PASS').length,
      failed: report.failures.length,
      report: join(out, 'feature-result.json'),
    }),
  );
  if (report.status !== 'PASS') process.exitCode = 1;
}
