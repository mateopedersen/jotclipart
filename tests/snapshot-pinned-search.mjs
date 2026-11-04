import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchRepository, SearchHttpError } from '../src/lib/search-remote.ts';
import { defaults } from '../src/lib/search.ts';
const A = 'a'.repeat(64),
  B = 'b'.repeat(64),
  state = { ...defaults, q: 'camera', size: 8 };
const manifest = (s) => ({
  schema: 1,
  version: s,
  total: 1,
  transport: { protocol: 'snapshot-search-v1', endpoint: '/catalog-search.json', snapshot: s },
});
const result = (s) => ({
  manifest: manifest(s),
  items: [{ id: 'camera', title: 'Camera', thumb: 'https://assets.ultraclipart.com/a.webp' }],
  total: 1,
  pages: 1,
  page: 1,
  hasFuzzyMatches: false,
});
test('SSR-pinned artwork suggestions use one authenticated POST without a preceding manifest GET', async () => {
  const calls = [];
  const r = new SearchRepository(async (path, signal, init) => {
    calls.push(path);
    assert.equal(path, '/catalog-search.json');
    const body = JSON.parse(init.body);
    assert.equal(body.snapshot, A);
    assert.equal(init.cache, 'no-store');
    assert.deepEqual(body.scope, ['topic/camera']);
    return { schema: 1, snapshot: A, result: result(A) };
  });
  assert.equal((await r.searchAtSnapshot(A, state, undefined, ['topic/camera'])).total, 1);
  assert.deepEqual(calls, ['/catalog-search.json']);
});
test('a stale SSR root refreshes the descriptor exactly once and never mixes generations', async () => {
  const calls = [];
  const r = new SearchRepository(async (path, signal, init) => {
    calls.push(path);
    if (path.endsWith('/manifest.json')) return manifest(B);
    const s = JSON.parse(init.body).snapshot;
    if (s === A) throw new SearchHttpError(409);
    return { schema: 1, snapshot: B, result: result(B) };
  });
  assert.equal((await r.searchAtSnapshot(A, state)).manifest.version, B);
  assert.deepEqual(calls, [
    '/catalog-search.json',
    '/search-data/manifest.json',
    '/catalog-search.json',
  ]);
});
test('a second conflict is surfaced instead of creating an automatic retry loop', async () => {
  let calls = 0;
  const r = new SearchRepository(async (path) => {
    calls++;
    if (path.endsWith('/manifest.json')) return manifest(B);
    throw new SearchHttpError(409);
  });
  await assert.rejects(
    () => r.searchAtSnapshot(A, state),
    (e) => e.status === 409,
  );
  assert.equal(calls, 3);
});
test('wrong response roots and malformed artwork cannot fall back to unbound shards', async () => {
  for (const bad of [
    { schema: 1, snapshot: B, result: result(B) },
    { schema: 1, snapshot: A, result: { ...result(A), items: [{ id: 'bad ID' }] } },
    {
      schema: 1,
      snapshot: A,
      result: {
        ...result(A),
        manifest: {
          ...manifest(A),
          transport: { ...manifest(A).transport, endpoint: 'https://outside.invalid/search' },
        },
      },
    },
  ]) {
    let calls = 0;
    const r = new SearchRepository(async () => {
      calls++;
      return bad;
    });
    await assert.rejects(() => r.searchAtSnapshot(A, state));
    assert.equal(calls, 1);
  }
});
test('invalid page roots, backend failure and an already aborted request make no unsafe retries', async () => {
  let calls = 0;
  const r = new SearchRepository(async () => {
    calls++;
    throw new SearchHttpError(503);
  });
  await assert.rejects(() => r.searchAtSnapshot('invalid', state));
  assert.equal(calls, 0);
  await assert.rejects(
    () => r.searchAtSnapshot(A, state),
    (e) => e.status === 503,
  );
  assert.equal(calls, 1);
  const c = new AbortController();
  c.abort();
  await assert.rejects(
    () => r.searchAtSnapshot(A, state, c.signal),
    (e) => e.name === 'AbortError',
  );
  assert.equal(calls, 1);
});
test('a pending old-root response cannot cross a repository clear boundary', async () => {
  let done;
  const r = new SearchRepository(
    async () =>
      new Promise(
        (resolve) => (done = () => resolve({ schema: 1, snapshot: A, result: result(A) })),
      ),
  );
  const pending = r.searchAtSnapshot(A, state);
  await new Promise((r) => setTimeout(r, 0));
  r.clear();
  done();
  await assert.rejects(
    () => pending,
    (e) => e.name === 'AbortError',
  );
});
