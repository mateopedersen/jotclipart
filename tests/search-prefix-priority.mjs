// Explicit synthetic metadata regression for the observed public mang -> man mismatch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, searchArtwork } from '../src/lib/search.ts';
import { SearchRepository, SearchHttpError } from '../src/lib/search-remote.ts';
import { buildSearchIndex } from '../src/lib/search-index.ts';
import { bootstrapSearch } from '../server/catalog-search/index.mjs';
import { makeStore } from '../server/catalog-search/store.mjs';
import { openSearch } from '../server/catalog-search/runtime.mjs';
import { searchNavigationEntries } from '../src/lib/site-search.ts';
const records = [
  { id: 'fruit-leaf', topic: 'mango', title: 'Green Mango With a Leaf', color: 'Green' },
  { id: 'forest-roots', topic: 'mangrove', title: 'Mangrove Roots', color: 'Brown' },
  { id: 'person-portrait', topic: 'people', title: 'A Man Reading', color: 'Green' },
  { id: 'fruit-plate', topic: 'mango', title: 'Yellow Mango on a Plate', color: 'Yellow' },
  { id: 'cat-play', topic: 'cat', title: 'Zebra Cat Playing', color: 'Blue' },
  { id: 'flag-scene', topic: 'flag', title: 'Alpha Flag With a Cat', color: 'Red' },
].map((item) => ({
  ...item,
  alt: item.title,
  description: item.title,
  style: 'Color',
  formats: ['WEBP', 'PDF'],
  orientation: 'Square',
  alpha: true,
  published: true,
  indexable: true,
  sourceType: 'vector',
  createdAt: '2026-01-01',
  thumb: '/fixture.webp',
  webp: '/fixture.webp',
}));
const topics = [...new Set(records.map((r) => r.topic))].map((slug) => ({
  slug,
  keyword: slug,
  cluster: 'Fixture',
}));
const storage = new Map(),
  bucket = {
    get: async (key) => {
      const bytes = storage.get(key);
      return bytes
        ? { size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer }
        : null;
    },
    put: async (key, body) => {
      storage.set(key, new Uint8Array(body));
      return { etag: key };
    },
  };
const native = bootstrapSearch(makeStore(bucket, { writable: true }), records, topics, {
  revision: 'fixture-prefix',
  publicSourceSha256: 'a'.repeat(64),
});
const build = buildSearchIndex(records, topics, 'prefix-fixture'),
  requests = [];
const repo = new SearchRepository(async (path) => {
  requests.push(path);
  const key = path.replace(/^\/search-data\//, '').replace(/\.json$/, '');
  if (!build.files.has(key)) throw new SearchHttpError(404);
  return structuredClone(build.files.get(key));
});
const engines = {
  memory: async (state) => searchArtwork(records, state),
  sharded: (state) => repo.search(state),
  snapshot: async (state) => {
    const engine = await openSearch(bucket, (await native).descriptor, {
      allowPrivateFixture: true,
    });
    const result = await engine.search(state);
    assert(engine.metrics().peakPendingR2 <= 4);
    return result;
  },
};
for (const [name, search] of Object.entries(engines)) {
  test(
    name + ': an exact subject ranks its own artwork first without hiding cross-topic matches',
    async () => {
      const result = await search({ ...defaults, q: 'cat' });
      assert.equal(result.total, 2);
      assert.deepEqual(
        result.items.map((row) => row.id),
        ['cat-play', 'flag-scene'],
      );
      const alphabetic = await search({ ...defaults, q: 'cat', sort: 'title' });
      assert.deepEqual(
        alphabetic.items.map((row) => row.id),
        ['flag-scene', 'cat-play'],
      );
      const red = await search({ ...defaults, q: 'cat', color: 'red' });
      assert.equal(red.total, 1);
      assert.equal(red.items[0].id, 'flag-scene', 'a preference must never bypass a filter');
    },
  );
  test(
    name +
      ': literal final-word prefixes exclude neighboring misspellings and preserve every constraint',
    async () => {
      for (const [query, ids, fuzzy] of [
        ['mang', ['fruit-leaf', 'forest-roots', 'fruit-plate'], false],
        ['green mang', ['fruit-leaf'], false],
        ['man', ['person-portrait'], false],
        ['mngo', ['fruit-leaf', 'fruit-plate'], true],
        ['Green Mango With a Leaf', ['fruit-leaf'], false],
        ['purple mang', [], false],
      ]) {
        const found = await search({ ...defaults, q: query, size: 8 });
        assert.deepEqual(found.items.map((x) => x.id).sort(), ids.sort(), query);
        assert.equal(found.total, ids.length, query);
        assert.equal(found.hasFuzzyMatches, fuzzy, query);
      }
    },
  );
  test(name + ': prefix filters, alphabetical sort and pagination remain exact', async () => {
    const found = await search({ ...defaults, q: 'mang', sort: 'title', page: 2, size: 1 });
    assert.equal(found.total, 3);
    assert.equal(found.page, 2);
    assert.equal(found.items[0].id, 'forest-roots');
    const filtered = await search({ ...defaults, q: 'mang', color: 'green' });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.items[0].id, 'fruit-leaf');
  });
}
test('a successful prefix does not fetch spelling lexicons in the sharded client', async () => {
  requests.length = 0;
  repo.clear();
  const found = await repo.search({ ...defaults, q: 'mang' });
  assert.equal(found.total, 3);
  assert(!requests.some((path) => path.includes('/lexicon/')));
});
test('the actual AI Builder navigation label finds its Generator destination without promoting incidental copy', () => {
  const tool = {
    id: 'page:/ai-clipart-generator/',
    kind: 'tool',
    title: 'AI Clipart Generator: Create, Edit & Download',
    href: '/ai-clipart-generator/',
    description: '',
    text: '',
  };
  const policy = {
    id: 'about',
    kind: 'page',
    title: 'About',
    href: '/about/',
    description: 'AI Clipart Builder',
    text: 'AI Clipart Builder',
  };
  for (const q of ['AI Clipart Builder', 'AI build', 'AI Clipart Generator'])
    assert.deepEqual(
      searchNavigationEntries([tool, policy], q).map((x) => x.entry.id),
      [tool.id],
    );
  tool.href = '/some-other-tool/';
  assert.equal(
    searchNavigationEntries([tool], 'AI Clipart Builder').length,
    0,
    'a changed destination invalidates its old alias',
  );
});
