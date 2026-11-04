// Native Chrome navigation mechanism with delayed synthetic HTML/image bytes.
// These timings are not measurements of the public website or real R2 assets.
import { createServer } from 'node:http';
import { expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { navigationRulesResponse } from '../../server/catalog-snapshot/navigation-speculation.mjs';
const image = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#1e6be3' } })
  .webp()
  .toBuffer();
let origin,
  ready = false,
  prerenderRequests = 0,
  excludedRequests = 0,
  pageRequests = 0,
  activated;
const server = createServer(async (req, res) => {
  const rules = navigationRulesResponse(new Request(origin + req.url));
  if (rules) {
    res.writeHead(rules.status, Object.fromEntries(rules.headers));
    return res.end(await rules.text());
  }
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'",
  );
  if (req.url === '/ready.js') {
    res.setHeader('Content-Type', 'text/javascript');
    return res.end(
      "const i=document.getElementById('hero');function ready(){if(document.prerendering&&i.complete&&i.naturalWidth>0)fetch('/ready')};function active(){if(!document.prerendering&&i.complete&&i.naturalWidth===64)requestAnimationFrame(()=>requestAnimationFrame(()=>fetch('/activated?start='+performance.getEntriesByType('navigation')[0].activationStart+'&full='+(i.complete&&i.naturalWidth===64))))};i.addEventListener('load',()=>{ready();active()});document.addEventListener('prerenderingchange',active);ready();active();",
    );
  }
  if (req.url.startsWith('/activated?')) {
    const p = new URL(req.url, origin);
    activated = {
      at: Date.now(),
      activationStart: Number(p.searchParams.get('start')),
      fullImageReady: p.searchParams.get('full') === 'true',
    };
    return res.end('ok');
  }
  if (req.url === '/ready') {
    ready = true;
    return res.end('ok');
  }
  if (req.url === '/original.webp') {
    await new Promise((r) => setTimeout(r, 300));
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'public,max-age=31536000,immutable');
    return res.end(image);
  }
  if (req.url === '/art/alpha/') {
    pageRequests++;
    if (req.headers['sec-purpose']?.includes('prerender')) prerenderRequests++;
    await new Promise((r) => setTimeout(r, 450));
    res.setHeader('Content-Type', 'text/html');
    return res.end(
      '<!doctype html><h1>Explicit synthetic destination</h1><img id="hero" src="/original.webp" width="64" height="64" alt="Synthetic blue square"><script src="/ready.js" defer></script>',
    );
  }
  if (req.url.startsWith('/edit/') || req.url.startsWith('/download/')) excludedRequests++;
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Speculation-Rules', '"/navigation-rules.json"');
  res.end(
    '<!doctype html><meta name="viewport" content="width=device-width"><h1>Native navigation fixture</h1><a style="display:block;padding:20px" id="next" href="/art/alpha/">Next public artwork</a><a style="display:block;padding:20px" id="editor" href="/edit/alpha/">Excluded editor</a><a style="display:block;padding:20px" id="download" download href="/download/alpha/">Excluded download</a>',
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
origin = 'http://127.0.0.1:' + server.address().port;
const profile = mkdtempSync(resolve(tmpdir(), 'uc-native-prerender-'));
const child = spawn(
  process.env.UC_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  [
    '--headless=new',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
const endpoint = await new Promise((yes, no) => {
  let log = '';
  const timer = setTimeout(() => no(Error('Test browser did not start')), 10000);
  child.stderr.on('data', (b) => {
    log += b.toString();
    const m = log.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (m) {
      clearTimeout(timer);
      yes(m[1]);
    }
  });
  child.once('error', no);
});
const ws = new WebSocket(endpoint);
await new Promise((yes, no) => {
  ws.addEventListener('open', yes, { once: true });
  ws.addEventListener('error', no, { once: true });
});
let sequence = 0;
const pending = new Map(),
  events = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.no(Error(m.error.message));
    else p.yes(m.result);
  } else if (m.method?.startsWith('Preload.')) events.push(m);
});
const send = (method, params = {}, sessionId) =>
  new Promise((yes, no) => {
    const id = ++sequence;
    pending.set(id, { yes, no });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
const pageTarget = (await send('Target.getTargets')).targetInfos.find((t) => t.type === 'page');
const { sessionId } = await send('Target.attachToTarget', {
  targetId: pageTarget.targetId,
  flatten: true,
});
const command = (m, p = {}) => send(m, p, sessionId);
const evaluate = async (expression) =>
  (await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))
    .result.value;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const hover = async (id) => {
  const point = await evaluate(
    `(()=>{const r=document.getElementById('${id}').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  return point;
};
const report = {
  scope:
    'Native Chrome Speculation-Rules response header, strict self-only script CSP, synthetic delayed 450ms HTML + 300ms image. Successful activation is not a live-site performance result.',
  passed: false,
  errors: [],
};
try {
  report.automationNote =
    'Isolated fresh-profile Chrome, direct CDP session. The documented test-only Page.setPrerenderingAllowed restores eligibility suppressed by a debugger; user Chrome/settings are unchanged.';
  await command('Page.enable');
  await command('Preload.enable');
  await command('Page.setPrerenderingAllowed', { isAllowed: true });
  await command('Page.navigate', { url: origin });
  await expect
    .poll(() => evaluate("document.readyState==='complete'"), { timeout: 10000 })
    .toBe(true);
  await command('Page.setPrerenderingAllowed', { isAllowed: true });
  await hover('editor');
  await pause(400);
  await hover('download');
  await pause(400);
  assert.equal(excludedRequests, 0);
  const point = await hover('next');
  await expect
    .poll(
      () =>
        ready ||
        events.some(
          (e) => e.method === 'Preload.prefetchStatusUpdated' && e.params.status === 'Ready',
        ),
      { timeout: 12000 },
    )
    .toBe(true);
  assert.equal(prerenderRequests, 1);
  const start = Date.now();
  await command('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...point,
    button: 'left',
    clickCount: 1,
  });
  await command('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    ...point,
    button: 'left',
    clickCount: 1,
  });
  await expect.poll(() => Boolean(activated), { timeout: 10000 }).toBe(true);
  report.clickToPaintMs = activated.at - start;
  report.activationStart = activated.activationStart;
  report.fullImageReady = activated.fullImageReady;
  report.prerenderRequests = prerenderRequests;
  report.excludedRequests = excludedRequests;
  report.nativeMode = report.activationStart > 0 ? 'prerender-activation' : 'native-prefetch-reuse';
  report.documentRequests = pageRequests;
  assert.equal(pageRequests, 1, 'Navigation must reuse the prepared document');
  assert(report.fullImageReady);
  assert(report.clickToPaintMs < 1000);
  report.passed = true;
} finally {
  report.ready = ready;
  report.prerenderRequests = prerenderRequests;
  report.nativeEvents = events;
  ws.close();
  child.kill('SIGTERM');
  await Promise.race([new Promise((r) => child.once('exit', r)), pause(3000)]);
  rmSync(profile, { recursive: true, force: true });
  await new Promise((r) => server.close(r));
  const out = resolve(process.env.UC_PRERENDER_REPORT ?? 'reports/navigation-prerender');
  mkdirSync(out, { recursive: true });
  writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report));
