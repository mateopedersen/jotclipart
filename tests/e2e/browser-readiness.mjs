// Private loopback browser regression. No public catalog, AI, shares or uploads.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium, firefox, webkit } from '@playwright/test';
import {
  observeCatalogRequests,
  settleBeforeDirectNavigation,
} from '../../scripts/jotclipart/browser-readiness.mjs';

const engine = process.env.UC_BROWSER ?? 'chromium';
const width = Number(process.env.VIEWPORT_WIDTH ?? 768);
assert(['chromium', 'firefox', 'webkit'].includes(engine));
let catalogResponse, streamResponse;
let catalogSeen, streamSeen;
const heldCatalog = new Promise((done) => {
  catalogSeen = done;
});
const heldStream = new Promise((done) => {
  streamSeen = done;
});
const server = createServer((request, response) => {
  if (request.url === '/catalog-search.json') {
    catalogResponse = response;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"ok":');
    catalogSeen();
  } else if (request.url === '/telemetry-stream') {
    streamResponse = response;
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.write('started');
    streamSeen();
  } else {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>Private readiness fixture</title><h1>Fixture</h1>');
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = 'http://127.0.0.1:' + server.address().port;
const output = `reports/jotclipart-native-browser/${engine}-${width}`;
mkdirSync(output, { recursive: true });
const report = {
  engine,
  width,
  fixtureScope: true,
  actualPublicPageClaim: false,
  checks: [],
  status: 'RUNNING',
};
let browser;
try {
  const executablePath =
    engine === 'chromium' ? process.env.READINESS_CHROMIUM_EXECUTABLE : undefined;
  browser = await { chromium, firefox, webkit }[engine].launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  observeCatalogRequests(page, origin);
  await page.goto(origin);
  await page.evaluate(() => {
    void fetch('/catalog-search.json')
      .then(async (response) => {
        document.body.dataset.headersReceived = 'true';
        await response.json();
        document.body.dataset.catalogComplete = 'true';
      })
      .catch(() => {
        document.body.dataset.catalogFailed = 'true';
      });
  });
  await heldCatalog;
  await page.waitForFunction(() => document.body.dataset.headersReceived === 'true');
  let settled = false;
  const pending = settleBeforeDirectNavigation(page).then(() => {
    settled = true;
  });
  await new Promise((done) => setTimeout(done, 100));
  assert.equal(settled, false, 'Response headers must not be mistaken for completed catalog bytes');
  catalogResponse.end('true}');
  await pending;
  assert.equal(await page.evaluate(() => document.body.dataset.catalogComplete), 'true');
  await page.goto(origin + '/next');
  assert.deepEqual(errors, []);
  report.checks.push({
    name: 'Wait for the complete real metadata body before an artificial navigation',
    status: 'PASS',
  });

  const visibleError = page.waitForEvent('pageerror');
  await page.evaluate(() =>
    setTimeout(() => {
      throw Error('deliberate readiness fixture error');
    }, 0),
  );
  await visibleError;
  await settleBeforeDirectNavigation(page);
  assert(errors.some((message) => message.includes('deliberate readiness fixture error')));
  report.checks.push({
    name: 'Preserve genuine uncaught errors instead of hiding or filtering them',
    status: 'PASS',
  });

  await page.evaluate(() => {
    void fetch('/telemetry-stream')
      .then((response) => response.text())
      .then(() => {
        document.body.dataset.telemetryComplete = 'true';
      })
      .catch(() => {});
  });
  await heldStream;
  await settleBeforeDirectNavigation(page);
  assert.equal(await page.evaluate(() => document.body.dataset.telemetryComplete), undefined);
  streamResponse.end(' finished');
  await page.waitForFunction(() => document.body.dataset.telemetryComplete === 'true');
  report.checks.push({
    name: 'Unrelated ongoing streams do not turn readiness into a network-idle wait',
    status: 'PASS',
  });
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  catalogResponse?.end();
  streamResponse?.end();
  await browser?.close();
  await new Promise((done) => server.close(done));
  writeFileSync(output + '/readiness-result.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
