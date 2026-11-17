// Private protocol tests. Fake authorization here is not a production receipt.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createSnapshotSearchApi } from '../server/catalog-search/api.mjs';
import { bootstrapSearch } from '../server/catalog-search/index.mjs';
import { makeStore } from '../server/catalog-search/store.mjs';
import { attachUiMetadata, uiProviders } from '../server/catalog-search/ui-metadata.mjs';
import { defaults } from '../src/lib/search.ts';
const source = JSON.parse(readFileSync(new URL('../data/art.json', import.meta.url))).filter(
    (a) => a.published && a.indexable,
  ),
  records = source.slice(0, 32),
  topics = [...new Set(records.map((a) => a.topic))].map((slug) => ({
    slug,
    keyword: slug + ' clipart',
  })),
  map = new Map();
const bucket = {
    async get(key) {
      const b = map.get(key);
      return b ? { size: b.length, arrayBuffer: async () => b.slice().buffer } : null;
    },
    async put(key, body) {
      map.set(key, new Uint8Array(body));
      return { etag: 'local-only' };
    },
  },
  store = makeStore(bucket, { writable: true });
const base = await bootstrapSearch(store, records, topics, {
    revision: 'a'.repeat(40),
    publicSourceSha256: 'b'.repeat(64),
  }),
  mono = records.filter((a) => a.monochrome),
  kinds = [...new Set(mono.map((a) => a.monochromeKind))].map((slug) => ({
    slug,
    label: slug,
    count: mono.filter((a) => a.monochromeKind === slug).length,
  }));
const bound = await attachUiMetadata(store, base.descriptor, {
  site: [
    {
      id: 'camera',
      kind: 'topic',
      title: 'Camera Clipart',
      description: 'Source-specific camera artwork.',
      text: 'Camera',
      href: '/clipart/camera/',
    },
    {
      id: 'page:/contact/',
      kind: 'page',
      title: 'Contact UltraClipart',
      description: 'Write to ultraclipart@gmail.com at ultraclipart.com.',
      text: 'Contact UltraClipart for download help.',
      href: '/contact/',
    },
  ],
  categories: [],
  featuredIds: records.slice(0, 4).map((a) => a.id),
  monochrome: { total: mono.length, topics: [], collections: [], kinds },
});
let captures = 0;
const root = 'c'.repeat(64),
  capture = async () => {
    captures++;
    return {
      rootSHA256: root,
      searchDescriptor: bound.descriptor,
      bucket,
      fixture: true,
      authorizationVerified: true,
    };
  };
const api = createSnapshotSearchApi({
    captureAuthorizedSnapshot: capture,
    allowPrivateFixture: true,
    ...uiProviders,
  }),
  req = (body) =>
    new Request('https://ultraclipart.com/catalog-search.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://ultraclipart.com' },
      body: JSON.stringify({ schema: 1, snapshot: root, ...body }),
    }),
  rows = [];
async function test(name, fn) {
  await fn();
  rows.push({ name, passed: true });
}
await test('Manifest and directory share exact root; uncached response', async () => {
  const r = await api.manifest(new Request('https://ultraclipart.com/search-data/manifest.json'));
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control'), /no-store/);
  assert(!r.headers.has('set-cookie'));
  const b = await r.json();
  assert.equal(b.version, root);
  assert.equal(b.total, 32);
  assert.equal(b.monochrome.total, mono.length);
});
await test('Studio and B&W sizes 4/6/24 preserved; capture once per request', async () => {
  for (const size of [4, 6, 24, 32]) {
    const before = captures,
      r = await api.post(req({ operation: 'search', state: { ...defaults, size } }));
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(b.snapshot, root);
    assert.equal(b.result.items.length, size);
    assert.equal(captures - before, 1);
  }
});
await test('Favorites ID lookup preserves order and true missing null', async () => {
  const ids = [records[2].id, 'not-a-catalog-id', records[0].id],
    r = await api.post(req({ operation: 'items', ids })),
    b = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual(
    b.result.map((x) => x?.id ?? null),
    [ids[0], null, ids[2]],
  );
});
await test('Studio sources carry original checksum/URL facts from same root', async () => {
  const r = await api.post(
      req({ operation: 'studio', state: { ...defaults, size: 6 }, scope: ['source/raster'] }),
    ),
    b = await r.json();
  assert.equal(r.status, 200);
  assert.equal(b.result.studioItems.length, 6);
  for (const a of b.result.studioItems) {
    const original = records.find((x) => x.id === a.id);
    assert.deepEqual(a.webp, { url: original.webp, ...original.files.webp });
    assert.equal(a.title, original.title);
  }
});
await test('Site entry links retain same root', async () => {
  const r = await api.post(req({ operation: 'site' })),
    b = await r.json();
  assert.equal(r.status, 200);
  assert.equal(b.result[0].href, '/clipart/camera/');
});
await test('Private fixture rejected even when fake authorization flag is true', async () => {
  const a = createSnapshotSearchApi({
    captureAuthorizedSnapshot: async () => ({ ...(await capture()), fixture: true }),
  });
  assert.equal((await a.post(req({ operation: 'items', ids: [] }))).status, 503);
});
await test('Missing authorization never reads a public result', async () => {
  const a = createSnapshotSearchApi({
    captureAuthorizedSnapshot: async () => ({
      ...(await capture()),
      fixture: false,
      authorizationVerified: false,
    }),
  });
  assert.equal((await a.post(req({ operation: 'items', ids: [] }))).status, 503);
});
await test('Changed root returns conflict without mixed items', async () => {
  const r = await api.post(req({ snapshot: 'd'.repeat(64), operation: 'items', ids: [] }));
  assert.equal(r.status, 409);
  assert(!Object.hasOwn(await r.json(), 'result'));
});
await test('Unconfigured site/Studio fail explicitly; wrong provider root fails closed', async () => {
  const a = createSnapshotSearchApi({
    captureAuthorizedSnapshot: capture,
    allowPrivateFixture: true,
  });
  for (const body of [{ operation: 'site' }, { operation: 'studio-items', ids: [] }])
    assert.equal((await a.post(req(body))).status, 501);
  const b = createSnapshotSearchApi({
    captureAuthorizedSnapshot: capture,
    allowPrivateFixture: true,
    readSiteEntries: async () => ({ snapshotSha256: 'd'.repeat(64), value: [] }),
  });
  assert.equal((await b.post(req({ operation: 'site' }))).status, 503);
});
await test('Oversize IDs/body, foreign origin and bad states are rejected', async () => {
  assert.equal(
    (await api.post(req({ operation: 'items', ids: Array(129).fill(records[0].id) }))).status,
    400,
  );
  assert.equal(
    (await api.post(req({ operation: 'items', ids: [], unused: 'x'.repeat(33000) }))).status,
    413,
  );
  const foreign = req({ operation: 'items', ids: [] });
  foreign.headers.set('Origin', 'https://evil.invalid');
  assert.equal((await api.post(foreign)).status, 403);
  for (const size of [0, 33, 1.5])
    assert.equal(
      (await api.post(req({ operation: 'search', state: { ...defaults, size } }))).status,
      400,
    );
});
await test('Corrupt immutable source fails 503 rather than deleting favorites', async () => {
  const saved = map.get(bound.descriptor.key);
  map.set(bound.descriptor.key, new Uint8Array(saved.length));
  const r = await api.post(req({ operation: 'items', ids: [records[0].id] }));
  assert.equal(r.status, 503);
  assert(!Object.hasOwn(await r.json(), 'result'));
  map.set(bound.descriptor.key, saved);
});
await test('Studio reads overlap within four slots and preserve exact IDs including missing positions', async () => {
  let active = 0,
    peak = 0;
  const delayed = {
      ...store,
      get: async (d) => {
        active++;
        peak = Math.max(peak, active);
        try {
          await new Promise((r) => setTimeout(r, d.bytes % 3));
          return await store.get(d);
        } finally {
          active--;
        }
      },
    },
    ids = [...records.map((a) => a.id), 'not-a-catalog-id'],
    found = await uiProviders.readStudioItems(
      { snapshotSha256: root },
      { store: delayed, manifest: bound.manifest, ids },
    );
  assert.deepEqual(
    found.value.map((a) => a?.id ?? null),
    [...records.map((a) => a.id), null],
  );
  assert(peak > 1);
  assert(peak <= 4);
  const repeated = await uiProviders.readStudioItems(
    { snapshotSha256: root },
    { store, manifest: bound.manifest, ids: [ids[0], ids[0]] },
  );
  assert.deepEqual(
    repeated.value.map((a) => a.id),
    [ids[0], ids[0]],
  );
  await assert.rejects(
    uiProviders.readStudioItems(
      { snapshotSha256: root },
      { store, manifest: bound.manifest, ids: Array(501).fill(ids[0]) },
    ),
  );
});
await test('Public directory is root-addressed, cacheable and identical to the private compatibility operation', async () => {
  const values = new Map(),
    cache = {
      match: async (r) => values.get(r.url)?.clone(),
      put: async (r, v) => {
        values.set(r.url, v.clone());
      },
      delete: async (r) => values.delete(r.url),
    },
    a = createSnapshotSearchApi({
      captureAuthorizedSnapshot: capture,
      allowPrivateFixture: true,
      ...uiProviders,
      directoryCache: cache,
    }),
    url = 'https://ultraclipart.com/search-data/' + root + '/site.json',
    first = await a.siteDirectory(new Request(url), root),
    value = await first.json();
  assert.equal(first.status, 200);
  assert.match(first.headers.get('cache-control'), /immutable/);
  assert.equal(value.snapshot, root);
  assert.deepEqual(
    value.result,
    (await (await api.post(req({ operation: 'site' }))).json()).result,
  );
  const before = captures,
    next = await a.siteDirectory(new Request(url), root);
  assert.equal(captures - before, 1);
  assert.deepEqual(await next.json(), value);
  assert.equal(values.size, 1);
  const conditional = await a.siteDirectory(
    new Request(url, { headers: { 'if-none-match': first.headers.get('etag') } }),
    root,
  );
  assert.equal(conditional.status, 304);
});
await test('A cached directory cannot bypass authorization or a current-root mismatch', async () => {
  for (const captured of [
    { ...(await capture()), fixture: false, authorizationVerified: false },
    { ...(await capture()), rootSHA256: 'd'.repeat(64) },
  ]) {
    const a = createSnapshotSearchApi({
      captureAuthorizedSnapshot: async () => captured,
      allowPrivateFixture: true,
      ...uiProviders,
    });
    const r = await a.siteDirectory(
      new Request('https://ultraclipart.com/search-data/' + root + '/site.json'),
      root,
    );
    assert.equal(r.status, captured.authorizationVerified === false ? 503 : 409);
    assert.match(r.headers.get('cache-control'), /no-store/);
    assert(!Object.hasOwn(await r.json(), 'result'));
  }
});
await test('Public directory rejects query inputs, non-read methods and wrong source identity', async () => {
  for (const request of [
    new Request('https://ultraclipart.com/search-data/' + root + '/site.json?q=private'),
    new Request('https://ultraclipart.com/search-data/' + root + '/site.json', { method: 'POST' }),
  ])
    assert.equal((await api.siteDirectory(request, root)).status, 400);
  const a = createSnapshotSearchApi({
    captureAuthorizedSnapshot: capture,
    allowPrivateFixture: true,
    readSiteEntries: async () => ({ snapshotSha256: 'd'.repeat(64), value: [] }),
  });
  assert.equal(
    (
      await a.siteDirectory(
        new Request('https://ultraclipart.com/search-data/' + root + '/site.json'),
        root,
      )
    ).status,
    503,
  );
});
await test('Compact suggestions preserve exact artwork ranking without reading full UI directories', async () => {
  let directoryReads = 0;
  const a = createSnapshotSearchApi({
      captureAuthorizedSnapshot: capture,
      allowPrivateFixture: true,
      ...uiProviders,
      readMonochromeDirectory: async () => {
        directoryReads++;
        throw Error('Suggestions must not load the full UI directory');
      },
    }),
    state = { ...defaults, q: records[0].title, size: 8 };
  const expected = await (await api.post(req({ operation: 'search', state }))).json(),
    response = await a.post(req({ operation: 'suggest', state })),
    value = await response.json();
  assert.equal(response.status, 200);
  assert.equal(directoryReads, 0);
  assert.deepEqual(value.result.items, expected.result.items);
  assert.equal(value.result.total, expected.result.total);
  assert.deepEqual(value.result.manifest.topics, []);
  assert.match(response.headers.get('cache-control'), /private, no-store/);
  assert.match(response.headers.get('server-timing'), /catalog_search/);
  for (const state of [
    { ...defaults, size: 9 },
    { ...defaults, size: 8, page: 2 },
  ])
    assert.equal((await a.post(req({ operation: 'suggest', state }))).status, 400);
});
await test('Navigation projection retains verified destinations, excludes Studio elements and cannot poison full directory', async () => {
  const values = new Map(),
    cache = {
      match: async (r) => values.get(r.url)?.clone(),
      put: async (r, v) => values.set(r.url, v.clone()),
      delete: async (r) => values.delete(r.url),
    },
    entries = [
      {
        id: 'topic:camera',
        kind: 'topic',
        title: 'Camera Clipart',
        href: '/clipart/camera/',
        description: 'Verbose body',
        text: 'policy camera',
      },
      {
        id: 'studio:camera',
        kind: 'studio',
        title: 'Camera Element',
        href: '/create/',
        description: 'Studio body',
        text: 'element',
      },
    ],
    a = createSnapshotSearchApi({
      captureAuthorizedSnapshot: capture,
      allowPrivateFixture: true,
      directoryCache: cache,
      readSiteEntries: async () => ({ snapshotSha256: root, value: entries }),
    });
  const url = 'https://ultraclipart.com/search-data/' + root + '/';
  for (let round = 0; round < 2; round++) {
    const nav = await a.siteDirectory(new Request(url + 'navigation.json'), root),
      full = await a.siteDirectory(new Request(url + 'site.json'), root);
    assert.equal(nav.status, 200);
    assert.deepEqual((await nav.json()).result, [{ ...entries[0], description: '', text: '' }]);
    assert.deepEqual((await full.json()).result, entries);
    assert.equal(nav.headers.get('x-uc-directory-cache'), round ? 'HIT' : 'MISS');
  }
  assert.equal(values.size, 2);
  assert.equal(
    (await a.siteDirectory(new Request(url + 'navigation.json?q=secret'), root)).status,
    400,
  );
});
await test('Exact named subject suggestions prefer its own artwork without narrowing detailed or full searches', async () => {
  const isolated = new Map(),
    b = {
      async get(key) {
        const bytes = isolated.get(key);
        return bytes ? { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer } : null;
      },
      async put(key, bytes) {
        isolated.set(key, new Uint8Array(bytes));
        return { etag: 'fixture-only' };
      },
    },
    items = [
      {
        ...records[0],
        id: 'fixture-primary-cat',
        topic: 'cat',
        color: 'Blue',
        title: 'Z Sitting Cat',
        alt: 'A sitting cat',
        description: 'A sitting cat',
      },
      {
        ...records[0],
        id: 'fixture-incidental-cat',
        topic: 'flag',
        color: 'Red',
        title: 'A Cat Beside a Flag',
        alt: 'A cat beside a flag',
        description: 'A cat beside a flag',
      },
    ],
    built = await bootstrapSearch(
      makeStore(b, { writable: true }),
      items,
      [
        { slug: 'cat', keyword: 'Cat Clipart' },
        { slug: 'flag', keyword: 'Flag Clipart' },
      ],
      { revision: 'a'.repeat(40), publicSourceSha256: 'e'.repeat(64) },
    ),
    a = createSnapshotSearchApi({
      captureAuthorizedSnapshot: async () => ({
        rootSHA256: root,
        searchDescriptor: built.descriptor,
        bucket: b,
        fixture: true,
      }),
      allowPrivateFixture: true,
    }),
    read = async (operation, q) =>
      (await (await a.post(req({ operation, state: { ...defaults, q, size: 8 } }))).json()).result;
  const full = await read('search', 'cat'),
    suggest = await read('suggest', 'cat'),
    detail = await read('suggest', 'cat flag');
  assert.equal(full.total, 2);
  assert.equal(full.items[0].id, 'fixture-primary-cat');
  assert.deepEqual(
    new Set(full.items.map((item) => item.id)),
    new Set(items.map((item) => item.id)),
  );
  assert.equal(suggest.total, 1);
  assert.equal(suggest.items[0].id, 'fixture-primary-cat');
  assert.equal(detail.items[0].id, 'fixture-incidental-cat');
  const filtered = (
    await (
      await a.post(
        req({ operation: 'suggest', state: { ...defaults, q: 'cat', color: 'red', size: 8 } }),
      )
    ).json()
  ).result;
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].id, 'fixture-incidental-cat');
});
await test('Fresh public search directories use the current brand on verified page entries', async () => {
  const dir = `https://ultraclipart.com/search-data/${root}/`;
  const read = async (name) =>
    (await (await api.siteDirectory(new Request(dir + name), root)).json()).result;
  const full = await read('site-v2.json');
  const navigation = await read('navigation-v2.json');
  assert.deepEqual(await read('site.json'), full);
  assert.deepEqual(
    full.find((entry) => entry.id === 'camera'),
    {
      id: 'camera',
      kind: 'topic',
      title: 'Camera Clipart',
      href: '/clipart/camera/',
      description: 'Source-specific camera artwork.',
      text: 'Camera',
    },
  );
  assert.deepEqual(
    full.find((entry) => entry.id === 'page:/contact/'),
    {
      id: 'page:/contact/',
      kind: 'page',
      title: 'Contact JotClipart',
      href: '/contact/',
      description: 'Write to jotclipart@gmail.com at jotclipart.com.',
      text: 'Contact JotClipart for download help.',
    },
  );
  assert.deepEqual(
    navigation.find((entry) => entry.id === 'page:/contact/'),
    {
      id: 'page:/contact/',
      kind: 'page',
      title: 'Contact JotClipart',
      href: '/contact/',
      description: '',
      text: '',
    },
  );
});
assert.equal(rows.length, 19);
console.log(JSON.stringify({ passed: true, cases: rows.length }));
