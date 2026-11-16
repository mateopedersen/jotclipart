import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createLocalPreview } from './serve-local.mjs';

const root = process.cwd(),
  reportDir = resolve(root, '../../../reports/jotclipart-migration');
const report = {
  at: new Date().toISOString(),
  status: 'RUNNING',
  mode: 'actual independent worker, captured signed production metadata, isolated local edge shim',
  scope:
    'Native HTTP/SSR/API and public output checks only; no browser interaction, real AI, D1 mutation or original-media byte-download claim',
  cases: [],
  failures: [],
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fail = (message) => {
  throw Error(message);
};
const assert = (condition, message) => {
  if (!condition) fail(message);
};
const plain = (html) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#(?:39|x27);/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
const oldHost =
  /^https?:\/\/(?:www\.|assets\.)?ultraclipart\.com(?:\/|$)|^https?:\/\/(?:[\w-]+\.)?ultraclipart\.pages\.dev(?:\/|$)/i;
const networkAttrs = (html) =>
  [
    ...html.matchAll(
      /\b(?:src|href|action|data-original-src|data-image-url)\s*=\s*["']([^"']+)["']/gi,
    ),
  ].map((m) => m[1]);
const urlFields = new Set([
  'url',
  'src',
  'href',
  'canonical',
  'webp',
  'pdf',
  'thumb',
  'originalThumb',
  'preview',
  'suggestionThumb',
  'contentUrl',
  'thumbnailUrl',
  'embedUrl',
  '@id',
]);
const collectURLs = (value, found = [], field = '', parent = '') => {
  if (
    typeof value === 'string' &&
    /^https?:\/\//.test(value) &&
    (urlFields.has(field) || (field === 'source' && parent === 'preview'))
  )
    found.push(value);
  else if (value && typeof value === 'object')
    for (const [key, child] of Object.entries(value))
      collectURLs(child, found, Array.isArray(value) ? field : key, field);
  return found;
};
let preview;
async function caseOf(name, operation) {
  const started = performance.now();
  try {
    const details = await operation();
    report.cases.push({
      name,
      status: 'PASS',
      ms: Math.round(performance.now() - started),
      ...details,
    });
  } catch (error) {
    report.cases.push({
      name,
      status: 'FAIL',
      ms: Math.round(performance.now() - started),
      error: error.message,
    });
    report.failures.push({ name, error: error.message });
  }
}
const request = (path, init = {}) =>
  preview.handle(path, { ...init, headers: { 'accept-encoding': 'identity', ...init.headers } });
const cache = new Map();
async function getHTML(path) {
  const response = await request(path);
  const body = await response.text();
  if (response.status !== 200) fail(`HTTP ${response.status} ${body.slice(0, 110)}`);
  assert(response.headers.get('content-type')?.startsWith('text/html'), 'HTML MIME missing');
  cache.set(path, body);
  return { response, body };
}

try {
  preview = await createLocalPreview({ metadata: process.env.JOTCLIPART_TEST_METADATA });
  let snapshot, artID, artSlug;
  await caseOf('signed production delivery identity', async () => {
    const response = await request('/delivery-release.json'),
      body = await response.json();
    assert(response.status === 200, 'Delivery HTTP ' + response.status);
    assert(body.artworks === 49858, 'Artwork inventory differs');
    assert(body.subjects === 804, 'Topic inventory differs');
    snapshot = body.verifiedRoot;
    assert(/^[a-f0-9]{64}$/.test(snapshot ?? ''), 'Signed root absent');
    return {
      http: response.status,
      artworks: body.artworks,
      topics: body.subjects,
      root: snapshot,
    };
  });
  const pages = [
    '/',
    '/new/',
    '/search/',
    '/black-and-white/',
    '/categories/',
    '/collections/',
    '/library-index/',
    '/create/',
    '/favorites/',
    '/ai-clipart-generator/',
    '/clipart/baby-elephant/',
    '/art/versace-purple-barocco-jumpsuit/',
    '/about/',
    '/contact/',
    '/cookies/',
    '/editorial-process/',
    '/for-teachers/',
    '/print-size/',
    '/guides/',
    '/guides/make-a-classroom-label/',
    '/guides/turn-clipart-into-a-coloring-activity/',
    '/guides/webp-pdf-and-editable-projects/',
    '/license/',
    '/privacy/',
    '/terms/',
    '/faq/',
    '/accessibility/',
    '/copyright/',
  ];
  for (const path of pages)
    await caseOf('page ' + path, async () => {
      const { response, body } = await getHTML(path);
      const title = plain(/<title>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? '');
      const h1 = plain(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(body)?.[1] ?? '');
      assert(title.includes('JotClipart'), 'New brand title missing');
      const visibleCopy = plain(body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ''));
      assert(
        !/UltraClipart(?!@gmail\.com)/i.test(visibleCopy),
        'Old brand remains in visible copy',
      );
      assert(h1.length > 0, 'Heading missing');
      assert(
        ![title, h1].some((value) => /\bFree\s+Free\b|\bClipart\s+Clipart\b/i.test(value)),
        'Repeated editorial suffix/prefix',
      );
      const catalog =
        path === '/' ||
        /^\/(art|clipart|collection)\//.test(path) ||
        ['/new/', '/categories/', '/collections/', '/library-index/', '/black-and-white/'].includes(
          path,
        );
      if (catalog) {
        assert(/^Free\b/i.test(title), 'Catalog title Free missing');
        assert(/^Free\b/i.test(h1), 'Catalog H1 Free missing');
      }
      if (path.startsWith('/art/')) assert(/^Free\b/i.test(h1), 'Artwork H1 Free missing');
      const forbidden = networkAttrs(body).filter((url) => oldHost.test(url));
      assert(!forbidden.length, 'Old public network host ' + forbidden.slice(0, 2).join(', '));
      const canonical = /<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/.exec(body)?.[1];
      assert(canonical === `https://jotclipart.com${path}`, 'Canonical mismatch ' + canonical);
      const csp = response.headers.get('content-security-policy') ?? '';
      assert(csp.includes("script-src 'self'"), 'Script CSP absent');
      assert(!csp.includes("script-src 'self' 'unsafe-inline'"), 'Unsafe inline scripts enabled');
      assert(!csp.includes('assets.ultraclipart.com'), 'Old asset CSP dependency');
      return {
        http: 200,
        title,
        h1,
        bytes: Buffer.byteLength(body),
        sha256: hash(body),
        oldNetworkHosts: forbidden.length,
        cache: response.headers.get('x-uc-html-cache'),
      };
    });
  const collection = /href="(\/collection\/[a-z0-9-]+\/)"/.exec(
    cache.get('/collections/') ?? '',
  )?.[1];
  if (collection)
    await caseOf('curated collection ' + collection, async () => {
      const { body } = await getHTML(collection);
      assert(/<title>Free\b/.test(body), 'Collection Free title missing');
      return { http: 200, bytes: Buffer.byteLength(body) };
    });
  await caseOf('native search + source identity', async () => {
    assert(snapshot, 'Delivery prerequisite failed');
    const response = await request('/catalog-search.json', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://jotclipart.com' },
      body: JSON.stringify({
        schema: 1,
        snapshot,
        operation: 'search',
        state: { q: 'baby elephant', sort: 'relevance', page: 1, size: 8 },
        scope: [],
      }),
    });
    const body = await response.json();
    assert(response.status === 200, 'Search HTTP ' + response.status + ' ' + JSON.stringify(body));
    const rows = body.result?.items;
    assert(Array.isArray(rows) && rows.length > 0, 'Search empty');
    assert(!collectURLs(body).some((url) => oldHost.test(url)), 'Search DTO old URL');
    artID = rows[0].id;
    artSlug = rows[0].publicSlug ?? artID;
    return {
      http: 200,
      items: rows.length,
      total: body.result.total,
      sampleID: artID,
      sampleSlug: artSlug,
    };
  });
  await caseOf('editor detail for exact search ID', async () => {
    assert(artID, 'Search prerequisite failed');
    const { body } = await getHTML('/edit/' + artID + '/');
    assert(!networkAttrs(body).some((u) => oldHost.test(u)), 'Editor source old URL');
    assert(body.includes(artID), 'Editor identity missing');
    return { http: 200, id: artID, bytes: Buffer.byteLength(body) };
  });
  await caseOf('studio search + original asset descriptors', async () => {
    assert(snapshot, 'Delivery prerequisite failed');
    const response = await request('/catalog-search.json', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://jotclipart.com' },
      body: JSON.stringify({
        schema: 1,
        snapshot,
        operation: 'studio',
        state: { q: 'baby elephant', sort: 'relevance', page: 1, size: 4 },
        scope: [],
      }),
    });
    const body = await response.json();
    assert(response.status === 200, 'Studio HTTP ' + response.status + ' ' + JSON.stringify(body));
    assert(body.result?.studioItems?.length > 0, 'Studio original sources missing');
    assert(!collectURLs(body).some((u) => oldHost.test(u)), 'Studio DTO old URL');
    return { http: 200, items: body.result.studioItems.length };
  });
  for (const path of [
    '/search-data/manifest.json',
    '/studio-manifest.json',
    '/studio-featured.json',
    '/category-search/current.json',
    '/collection-feed.json',
    '/catalog-stats.json',
    '/surprise-picks.json',
    '/related-release.json',
  ])
    await caseOf('public JSON ' + path, async () => {
      const response = await request(path, {
          headers: { 'x-uc-catalog-protocol': 'snapshot-search-v1' },
        }),
        body = await response.json();
      assert(response.status === 200, 'JSON HTTP ' + response.status);
      assert(!collectURLs(body).some((u) => oldHost.test(u)), 'JSON has old public URL');
      return { http: 200, bytes: Buffer.byteLength(JSON.stringify(body)) };
    });
  await caseOf('complete sitemap origin projection', async () => {
    const response = await request('/sitemap.xml'),
      body = await response.text();
    assert(response.status === 200, 'Sitemap index HTTP ' + response.status);
    const urls = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    assert(urls.length === 15, 'Sitemap children count ' + urls.length);
    assert(!urls.some((u) => oldHost.test(u)), 'Index contains old domain');
    let artworks = 0,
      topics = 0,
      collections = 0,
      other = 0,
      images = 0;
    for (const url of urls) {
      const path = new URL(url).pathname,
        r = await request(path),
        xml = await r.text();
      assert(r.status === 200, 'Child sitemap HTTP ' + r.status + ' ' + path);
      const locations = [...xml.matchAll(/<(?:loc|image:loc)>([^<]+)<\/(?:loc|image:loc)>/g)].map(
        (m) => m[1],
      );
      assert(!locations.some((u) => oldHost.test(u)), 'Child has old origin ' + path);
      const count = (xml.match(/<url>/g) ?? []).length;
      if (path.includes('-art-')) artworks += count;
      else if (path.includes('-topics')) topics += count;
      else if (path.includes('-collections')) collections += count;
      else if (path.includes('-pages')) other += count;
      else if (path.includes('-images-')) images += (xml.match(/<image:image>/g) ?? []).length;
    }
    assert(
      artworks === 49858 &&
        topics === 804 &&
        collections === 101 &&
        other === 24 &&
        images === 49858,
      'Sitemap inventory mismatch ' +
        JSON.stringify({ artworks, topics, collections, other, images }),
    );
    return { children: urls.length, artworks, topics, collections, other, images };
  });
  await caseOf('wrong snapshot stays conflict', async () => {
    const response = await request('/catalog-search.json', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://jotclipart.com' },
      body: JSON.stringify({ schema: 1, snapshot: '0'.repeat(64), operation: 'items', ids: [] }),
    });
    assert(response.status === 409, 'Expected409 got' + response.status);
    return { http: response.status };
  });
  await caseOf('unknown artwork remains real 404', async () => {
    const response = await request('/art/jotclipart-nonexistent-migration-check/');
    assert(response.status === 404, 'Expected404 got' + response.status);
    return { http: response.status };
  });
  await caseOf('source originals retain no-JS links', async () => {
    const body = cache.get('/art/versace-purple-barocco-jumpsuit/');
    assert(body, 'Artwork prerequisite failed');
    const urls = networkAttrs(body);
    assert(
      urls.some((u) => /^https:\/\/assets\.jotclipart\.com\/.*\.webp(?:[?#]|$)/.test(u)),
      'Original Image URL absent',
    );
    assert(
      urls.some((u) => /^https:\/\/assets\.jotclipart\.com\/.*\.pdf(?:[?#]|$)/.test(u)),
      'Original PDF URL absent',
    );
    return { oldNetworkHosts: urls.filter((u) => oldHost.test(u)).length };
  });
  await caseOf('SSR software/font/icon dependency closure', async () => {
    assert(cache.size, 'No successful page prerequisite');
    const software = new Set();
    for (const body of cache.values())
      for (const url of networkAttrs(body)) {
        if (
          url.startsWith('/') &&
          !url.startsWith('//') &&
          /\.(?:m?js|css|woff2?|ico|svg)(?:[?#]|$)/i.test(url)
        )
          software.add(url);
      }
    assert(software.size > 8, 'Dependency collection incomplete');
    let bytes = 0;
    for (const url of software) {
      const response = await request(url);
      assert(response.status === 200, 'Software dependency HTTP ' + response.status + ' ' + url);
      const body = await response.arrayBuffer();
      assert(body.byteLength > 0, 'Empty software dependency ' + url);
      bytes += body.byteLength;
      assert(
        !response.headers.get('content-type')?.startsWith('text/html'),
        'Software returned HTML ' + url,
      );
    }
    return { requests: software.size, bytes };
  });
  await caseOf('warm snapshot cache, tracking query and conditional request', async () => {
    const first = await request('/');
    assert(first.status === 200, 'Home prerequisite failed');
    await first.arrayBuffer();
    await preview.settled();
    const second = await request('/?utm_source=migration-test');
    assert(second.status === 200, 'Warm response failed');
    const etag = second.headers.get('etag');
    assert(etag, 'Snapshot ETag missing');
    assert(second.headers.get('x-uc-html-cache') === 'HIT', 'Warm response not cached');
    await second.arrayBuffer();
    const conditional = await request('/', { headers: { 'if-none-match': etag } });
    assert(conditional.status === 304, 'Snapshot conditional status ' + conditional.status);
    assert((await conditional.arrayBuffer()).byteLength === 0, '304 body present');
    const head = await request('/', { method: 'HEAD' });
    assert(head.status === 200, 'HEAD response failed');
    assert((await head.arrayBuffer()).byteLength === 0, 'HEAD body present');
    return { warm: 'HIT', conditional: 304, head: 200 };
  });
  await caseOf('foreign search origin rejected', async () => {
    assert(snapshot, 'Delivery prerequisite failed');
    const response = await request('/catalog-search.json', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://untrusted.invalid' },
      body: JSON.stringify({ schema: 1, snapshot, operation: 'items', ids: [] }),
    });
    assert(response.status === 403, 'Foreign origin status ' + response.status);
    return { http: 403 };
  });
  await caseOf('all retained exact topic aliases preserve query on new origin', async () => {
    const text = await readFile('public/_redirects', 'utf8');
    const aliases = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.split(/\s+/))
      .filter(([from]) => !from.includes('*'));
    assert(aliases.length === 16, 'Retained topic redirect fixture incomplete');
    for (const [from, to, status] of aliases) {
      const response = await request(from + '?q=baby%20elephant&format=PDF&utm_source=legacy');
      assert(
        response.status === Number(status),
        'Legacy redirect status ' + from + ' ' + response.status,
      );
      const location = new URL(response.headers.get('location'));
      assert(
        location.origin === 'https://jotclipart.com' && location.pathname === to,
        'Legacy target mismatch ' + from,
      );
      assert(
        location.search === '?q=baby%20elephant&format=PDF&utm_source=legacy',
        'Legacy query lost ' + from,
      );
      assert(
        (await response.arrayBuffer()).byteLength === 0,
        'Redirect body unexpectedly populated',
      );
    }
    return { aliases: aliases.length, origin: 'https://jotclipart.com', queriesPreserved: true };
  });
  await caseOf('legacy download resolves canonical without restoring removed route', async () => {
    const source = '/download/versace-purple-barocco-jumpsuit/?format=pdf&from=legacy';
    const response = await request(source);
    assert(response.status === 301, 'Legacy download status ' + response.status);
    const location = new URL(response.headers.get('location'));
    assert(location.origin === 'https://jotclipart.com', 'Legacy download old origin');
    assert(
      location.pathname === '/art/versace-purple-barocco-jumpsuit/',
      'Legacy download wrong artwork',
    );
    assert(location.search === '?format=pdf&from=legacy', 'Legacy download query lost');
    const missing = await request('/download/jotclipart-nonexistent-migration-check/');
    assert(missing.status === 404, 'Unknown legacy download not404');
    return { known: 301, unknown: 404, queryPreserved: true };
  });
  await preview.settled();
  report.metrics = preview.summary();
  report.nodeProcessMemory = process.memoryUsage();
  report.status = report.failures.length ? 'FAILED' : 'PASS_NATIVE_LOCAL_ONLY';
} catch (error) {
  report.status = 'IMPORT_OR_SETUP_BLOCKED';
  report.failures.push({
    name: 'Worker import or setup',
    error: error.message,
    stack: error.stack?.split('\n').slice(1, 4),
  });
}
report.finishedAt = new Date().toISOString();
report.passed = report.cases.filter((c) => c.status === 'PASS').length;
report.failed = report.failures.length;
await mkdir(reportDir, { recursive: true });
const file = resolve(reportDir, 'local-native-regression.json');
await writeFile(file, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    status: report.status,
    passed: report.passed,
    failed: report.failed,
    failures: report.failures.slice(0, 12),
    missingMetadata: report.metrics?.missingObjects.length,
    report: file,
  }),
);
if (report.failed) process.exitCode = 1;
