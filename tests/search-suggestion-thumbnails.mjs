import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bootstrapSearch } from '../server/catalog-search/index.mjs';
import { makeStore } from '../server/catalog-search/store.mjs';
import { createSnapshotSearchApi } from '../server/catalog-search/api.mjs';
import { uiProviders } from '../server/catalog-search/ui-metadata.mjs';
import { searchSuggestions } from '../src/lib/search-suggestions.ts';
import { defaults } from '../src/lib/search.ts';
const base = JSON.parse(readFileSync(new URL('../data/art.json', import.meta.url)))[0],
  root = 'c'.repeat(64);
const original = 'https://assets.ultraclipart.com/fixture/capybara.original.webp',
  small = 'https://assets.ultraclipart.com/fixture/capybara.thumbnail.webp';
const record = {
  ...base,
  id: 'fixture-capybara',
  topic: 'fixture',
  title: 'Capybara Beside Reeds',
  alt: 'A synthetic capybara fixture',
  published: true,
  indexable: true,
  sourceType: 'raster',
  webp: original,
  thumb: original,
  originalThumb: small,
};
const objects = new Map(),
  bucket = {
    get: async (k) => {
      const b = objects.get(k);
      return b ? { size: b.length, arrayBuffer: async () => b.slice().buffer } : null;
    },
    put: async (k, b) => {
      objects.set(k, new Uint8Array(b));
      return { etag: 'private-fixture' };
    },
  };
const built = await bootstrapSearch(
  makeStore(bucket, { writable: true }),
  [record],
  [{ slug: 'fixture', keyword: 'Fixture Clipart' }],
  { revision: 'a'.repeat(40), publicSourceSha256: 'b'.repeat(64) },
);
const capture = async () => ({
  rootSHA256: root,
  searchDescriptor: built.descriptor,
  bucket,
  fixture: true,
});
const api = (provider) =>
  createSnapshotSearchApi({
    captureAuthorizedSnapshot: capture,
    allowPrivateFixture: true,
    readMonochromeDirectory: async () => ({
      snapshotSha256: root,
      value: { total: 0, topics: [], collections: [], kinds: [] },
    }),
    readSuggestionThumbnails: provider ?? uiProviders.readSuggestionThumbnails,
  });
const request = (operation) =>
  new Request('https://ultraclipart.com/catalog-search.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schema: 1,
      snapshot: root,
      operation,
      state: { ...defaults, q: 'capybara', size: 8 },
      scope: [],
    }),
  });
test('autocomplete uses the signed source thumbnail while full search, downloads and originals remain exact', async () => {
  const a = api(),
    r = await a.post(request('suggest'));
  assert.equal(r.status, 200);
  const item = (await r.json()).result.items[0];
  assert.equal(item.suggestionThumb, small);
  assert.equal(item.thumb, original);
  assert.equal(item.webp, original);
  assert.equal(item.pdf, record.pdf);
  assert.equal(searchSuggestions('capybara', [item], [])[0].thumb, small);
  const full = (await (await a.post(request('search'))).json()).result.items[0];
  assert.equal(full.suggestionThumb, undefined);
  assert.equal(full.webp, original);
});
test('thumbnail identity, original and snapshot mismatches fail closed', async () => {
  for (const value of [
    { id: 'wrong', webp: original, thumb: small },
    { id: record.id, webp: original + 'wrong', thumb: small },
  ])
    assert.equal(
      (await api(async () => ({ snapshotSha256: root, value: [value] })).post(request('suggest')))
        .status,
      503,
    );
  assert.equal(
    (
      await api(async () => ({ snapshotSha256: 'd'.repeat(64), value: [] })).post(
        request('suggest'),
      )
    ).status,
    503,
  );
});
test('unsupported or foreign thumbnail locations fall back to the original without guessing an address', async () => {
  for (const thumb of [
    'https://evil.invalid/preview.webp',
    'http://assets.ultraclipart.com/preview.webp',
    'https://assets.ultraclipart.com/a.webp?track=1',
    'https://user@assets.ultraclipart.com/a.webp',
    original,
    null,
  ]) {
    const r = await api(async () => ({
      snapshotSha256: root,
      value: [{ id: record.id, webp: original, thumb }],
    })).post(request('suggest'));
    assert.equal(r.status, 200);
    const item = (await r.json()).result.items[0];
    assert.equal(item.suggestionThumb, undefined);
    assert.equal(item.webp, original);
  }
});
test('future Jot-host originals retain their source-bound thumbnail with the same exact-origin guards', async () => {
  const item = {
    ...record,
    webp: original.replace('assets.ultraclipart.com', 'assets.jotclipart.com'),
    thumb: original.replace('assets.ultraclipart.com', 'assets.jotclipart.com'),
    originalThumb: small.replace('assets.ultraclipart.com', 'assets.jotclipart.com'),
  };
  const values = new Map(),
    b = {
      get: async (key) => {
        const bytes = values.get(key);
        return bytes ? { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer } : null;
      },
      put: async (key, bytes) => {
        values.set(key, new Uint8Array(bytes));
        return { etag: 'private-fixture' };
      },
    };
  const next = await bootstrapSearch(
    makeStore(b, { writable: true }),
    [item],
    [{ slug: 'fixture', keyword: 'Fixture Clipart' }],
    { revision: 'a'.repeat(40), publicSourceSha256: 'b'.repeat(64) },
  );
  const create = (provider) =>
    createSnapshotSearchApi({
      captureAuthorizedSnapshot: async () => ({
        rootSHA256: root,
        searchDescriptor: next.descriptor,
        bucket: b,
        fixture: true,
      }),
      allowPrivateFixture: true,
      readSuggestionThumbnails: provider ?? uiProviders.readSuggestionThumbnails,
    });
  const response = await create().post(request('suggest'));
  assert.equal(response.status, 200);
  const row = (await response.json()).result.items[0];
  assert.equal(row.webp, item.webp);
  assert.equal(row.thumb, item.webp);
  assert.equal(row.suggestionThumb, item.originalThumb);
  for (const thumb of [
    'https://assets.jotclipart.com.evil.invalid/preview.webp',
    'http://assets.jotclipart.com/preview.webp',
    'https://assets.jotclipart.com:444/preview.webp',
    'https://user:pass@assets.jotclipart.com/preview.webp',
    item.originalThumb + '?mutable=1',
    item.originalThumb + '#fragment',
  ]) {
    const r = await create(async () => ({
      snapshotSha256: root,
      value: [{ id: item.id, webp: item.webp, thumb }],
    })).post(request('suggest'));
    assert.equal(r.status, 200);
    assert.equal((await r.json()).result.items[0].suggestionThumb, undefined);
  }
});
