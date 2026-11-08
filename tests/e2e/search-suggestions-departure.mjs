// Real controller with an explicitly synthetic delayed repository. Native link
// navigation is covered separately; this isolates work left behind by a click.
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const out = resolve(process.env.EVIDENCE_DIR ?? 'reports/suggestion-departure');
mkdirSync(out, { recursive: true });
const root = 'a'.repeat(64);
const stub = `const root=${JSON.stringify(root)};
window.departureMetrics={started:0,aborted:0};
export class SearchRepository {
 clear(){} async sourceDirectory(){return [{kind:'topic',id:'topic:cat',title:'Cat Clipart',href:'/clipart/cat/',text:'cat clipart',description:'Explicit test fixture'}]}
 async searchAtSnapshot(_root,_state,signal){
  window.departureMetrics.started++;
  return new Promise((resolve,reject)=>{
   const abort=()=>{clearTimeout(timer);window.departureMetrics.aborted++;reject(new DOMException('Cancelled','AbortError'))};
   const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve({manifest:{version:root},items:[]})},1000);
   if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
  });
 }
}`;
const bundle = await build({ stdin: { contents: `import{initSearchSuggestions}from'./src/scripts/search-suggestions.ts';initSearchSuggestions();`, resolveDir: resolve('.') }, bundle: true, format: 'esm', write: false, plugins: [{ name: 'delayed-fixture', setup(b) { b.onResolve({ filter: /search-remote$/ }, () => ({ path: 'repository', namespace: 'fixture' })); b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: stub, loader: 'js' })); } }] });
const server = createServer((req, res) => {
 if (req.url === '/controller.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].text); return; }
 res.setHeader('Content-Type', 'text/html');
 res.end(`<!doctype html><meta name="catalog-snapshot" content="${root}"><form action="/search/"><input name="q"></form><script type="module" src="/controller.js"></script>`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const report = { scope: 'Actual controller, synthetic delayed repository; debounce and in-flight cancellation when a native destination is chosen or the page leaves', passed: false, cases: [] };
try {
 for (const [engine, type] of Object.entries({ chromium, webkit })) {
  const browser = await type.launch(engine === 'chromium' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {});
  try { for (const width of [390, 1440]) {
   const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width === 390 });
   try { for (const scenario of ['pending-click', 'in-flight-click', 'pagehide']) {
    await page.goto('http://127.0.0.1:' + server.address().port);
    await expect(page.locator('form')).toHaveAttribute('data-suggestions-ready', 'true');
    await page.locator('input').fill('cat');
    const option = page.locator('a[href="/clipart/cat/"]');
    await expect(option).toBeVisible();
    if (scenario !== 'pending-click') await expect.poll(() => page.evaluate(() => window.departureMetrics.started)).toBe(1);
    if (scenario === 'pagehide') await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    else await option.evaluate(link => { link.addEventListener('click', event => event.preventDefault(), { once: true }); link.click(); });
    const atChoice = await page.evaluate(() => ({ ...window.departureMetrics }));
    await page.waitForTimeout(160);
    const after = await page.evaluate(() => ({ ...window.departureMetrics }));
    assert.equal(after.started, atChoice.started, 'A destination choice must not start delayed search work');
    assert.equal(after.aborted, after.started, 'An outgoing page must cancel its in-flight search');
    report.cases.push({ engine, width, scenario, metrics: after, passed: true });
   } } finally { await page.close(); }
  } } finally { await browser.close(); }
 }
 report.passed = true;
} catch (error) { report.failure = String(error); throw error; }
finally { await new Promise(r => server.close(r)); writeFileSync(out + '/report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, failure: report.failure })); }
