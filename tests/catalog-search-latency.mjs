import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStore } from '../server/catalog-search/store.mjs';
import { bootstrapSearch } from '../server/catalog-search/index.mjs';
import { openSearch } from '../server/catalog-search/runtime.mjs';
import { mapFour } from '../server/catalog-search/bounded-map.mjs';

test('request-local parallel reads preserve order, never exceed four and propagate failure', async () => {
  let active = 0,
    peak = 0;
  const result = await mapFour(
    Array.from({ length: 19 }, (_, i) => i),
    async (i) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, (19 - i) % 4));
      active--;
      return i * 2;
    },
  );
  assert.equal(peak, 4);
  assert.deepEqual(
    result,
    Array.from({ length: 19 }, (_, i) => i * 2),
  );
  assert.deepEqual(
    await mapFour([], () => {
      throw Error('Empty input must not run');
    }),
    [],
  );
  await assert.rejects(
    mapFour([1], () => {
      throw Error('Read failed');
    }),
    /Read failed/,
  );
});

// Explicit synthetic search metadata only: no image inspection or publication.
const records = Array.from({ length: 2562 }, (_, n) => {
  const topic = n < 1536 ? 'filler' : n < 2048 ? 'quokka' : n < 2561 ? 'sable' : 'capybara';
  const title =
    topic === 'filler'
      ? 'Alpha Filler'
      : topic === 'quokka'
        ? 'Zebra Quokka'
        : topic === 'sable'
          ? 'Same Sable'
          : 'Unique Capybara';
  return {
    id: 'fixture-' + n,
    topic,
    title,
    alt: title,
    description: title,
    cluster: 'Fixture',
    style: 'Color',
    color: 'Blue',
    formats: ['WEBP'],
    sourceType: 'vector',
    thumb: '/fixture.webp',
    webp: '/fixture.webp',
    published: true,
    indexable: true,
    createdAt: '2026-01-01',
    monochrome: n % 2 === 0,
  };
});
const storage = new Map(),
  bucket = {
    get: async (key) => {
      const body = storage.get(key);
      return body ? { size: body.byteLength, arrayBuffer: async () => body.slice().buffer } : null;
    },
    put: async (key, body) => {
      storage.set(key, new Uint8Array(body));
      return { etag: key };
    },
  };
const fixture = bootstrapSearch(makeStore(bucket, { writable: true }), records, [], {
  revision: 'fixture',
  publicSourceSha256: 'a'.repeat(64),
});
const state = (q, sort = 'relevance', page = 1) => ({
  q,
  sort,
  page,
  size: 8,
  style: '',
  color: '',
  format: '',
  orientation: '',
  background: '',
  type: 'all',
});

test('zero, one, 512 and 513 candidates keep exact result counts, tie order and pagination', async () => {
  const { descriptor } = await fixture;
  for (const [query, count] of [
    ['impossiblenomatch', 0],
    ['capybara', 1],
    ['quokka', 512],
    ['sable', 513],
  ]) {
    for (const sort of ['relevance', 'title', 'newest']) {
      const engine = await openSearch(bucket, descriptor, { allowPrivateFixture: true });
      const result = await engine.search(state(query, sort, 2));
      const rows = records.map((r, n) => ({ ...r, n })).filter((r) => r.topic === query);
      if (sort === 'newest') rows.reverse();
      const page = Math.min(Math.max(1, Math.ceil(rows.length / 8)), 2);
      assert.equal(result.total, count);
      assert.equal(result.page, page);
      assert.deepEqual(
        result.items.map((r) => r.id),
        rows.slice((page - 1) * 8, page * 8).map((r) => r.id),
      );
      assert(engine.metrics().peakPendingR2 <= 4);
      if (query === 'quokka' && sort !== 'newest')
        assert(
          engine.metrics().forwardBlocks > 0,
          'Sparse end-of-alphabet matches use only their candidate blocks',
        );
      if (query === 'sable')
        assert.equal(
          engine.metrics().forwardBlocks,
          0,
          'Broad matches retain the ordered streaming index',
        );
    }
  }
});

test('monochrome, multiword and fuzzy queries retain matching identities under bounded parallel reads', async () => {
  const { descriptor } = await fixture;
  for (const [query, scope, count] of [
    ['quokka', ['print/monochrome'], 256],
    ['zebra quokka', [], 512],
    ['quokkaa', [], 512],
  ]) {
    const engine = await openSearch(bucket, descriptor, { allowPrivateFixture: true });
    const result = await engine.search(state(query), scope);
    assert.equal(result.total, count);
    assert(result.items.every((r) => r.title === 'Zebra Quokka'));
    if (scope.length) assert(result.items.every((r) => Number(r.id.split('-')[1]) % 2 === 0));
    if (query === 'quokkaa') assert.equal(result.hasFuzzyMatches, true);
    assert(engine.metrics().peakPendingR2 <= 4);
  }
});

test('parallel candidate loading still rejects corrupt immutable forward bytes', async () => {
  const { descriptor } = await fixture;
  const corrupt = {
    get: async (key) => {
      const value = await bucket.get(key);
      if (!value) return null;
      const bytes = new Uint8Array(await value.arrayBuffer());
      if (JSON.parse(new TextDecoder().decode(bytes)).type === 'search-forward')
        bytes[bytes.length - 2] ^= 1;
      return { size: bytes.length, arrayBuffer: async () => bytes.buffer };
    },
  };
  const engine = await openSearch(corrupt, descriptor, { allowPrivateFixture: true });
  await assert.rejects(engine.search(state('quokka')), /Corrupt search object/);
});

test('cold no-match spelling lookups overlap while the whole request stays bounded to four reads', async () => {
  const { descriptor } = await fixture;
  let editsInFlight = 0,
    peakEdits = 0;
  const delayed = {
    get: async (key) => {
      const value = await bucket.get(key);
      if (!value) return null;
      const body = JSON.parse(new TextDecoder().decode(await value.arrayBuffer()));
      if (body.kind === 'edits') {
        editsInFlight++;
        peakEdits = Math.max(peakEdits, editsInFlight);
        await new Promise((resolve) => setTimeout(resolve, 4));
        editsInFlight--;
      }
      return value;
    },
  };
  const engine = await openSearch(delayed, descriptor, { allowPrivateFixture: true });
  const result = await engine.search(state('zzzxqvjmtnpkhbgfdsyw'), ['print/monochrome']);
  assert.equal(result.total, 0);
  assert.deepEqual(result.items, []);
  assert.equal(result.hasFuzzyMatches, false);
  assert(peakEdits > 1, 'Independent edit-signature reads must not form a serial network chain');
  assert(engine.metrics().peakPendingR2 <= 4);
});

test('narrow exact queries do not walk unrelated alphabetical pages', async () => {
  const { descriptor } = await fixture;
  let orderedTitleReads = 0;
  const observed = {
    get: async (key) => {
      const value = await bucket.get(key);
      if (value) {
        const body = JSON.parse(new TextDecoder().decode(await value.arrayBuffer()));
        if (body.type.startsWith('ledger-order-') && body.kind === 'title') orderedTitleReads++;
      }
      return value;
    },
  };
  const engine = await openSearch(observed, descriptor, { allowPrivateFixture: true });
  const result = await engine.search(state('capybara'));
  assert.equal(result.items[0].id, 'fixture-2561');
  assert.equal(orderedTitleReads, 0);
  assert.equal(engine.metrics().forwardBlocks, 1);
});

test('first filtered page reads only its membership shards and keeps the exact total and order', async () => {
  const { descriptor } = await fixture;
  for (const sort of ['title', 'newest']) {
    let facetReads = 0;
    const observed = {
      get: async (key) => {
        const object = await bucket.get(key);
        if (object) {
          const body = JSON.parse(new TextDecoder().decode(await object.arrayBuffer()));
          if (body.type === 'search-facet-ids') facetReads++;
        }
        return object;
      },
    };
    const engine = await openSearch(observed, descriptor, { allowPrivateFixture: true });
    const result = await engine.search(state('', sort), ['print/monochrome']);
    const rows = records.filter((row) => row.monochrome);
    if (sort === 'newest') rows.reverse();
    else rows.sort((a, b) => a.title.localeCompare(b.title, 'en'));
    assert.equal(result.total, rows.length);
    assert.deepEqual(
      result.items.map((row) => row.id),
      rows.slice(0, 8).map((row) => row.id),
    );
    assert(facetReads <= 2, 'Only the leading ranked rows’ facet ranges are needed');
    assert(engine.metrics().peakPendingR2 <= 4);
  }
});
