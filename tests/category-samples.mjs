import test from 'node:test';
import assert from 'node:assert/strict';
import { categorySamples } from '../src/lib/category-samples.ts';
const snapshot = 'a'.repeat(64),
  id = 'explicit-fixture';
const original = 'https://assets.ultraclipart.com/fixture/original.webp';
const thumb = 'https://assets.ultraclipart.com/fixture/thumbnail.webp';
const asset = {
  id,
  title: 'Explicit Fixture',
  alt: 'Controlled synthetic fixture',
  topic: 'fixture',
  style: 'Color',
  thumb,
  width: 320,
  height: 160,
  webp: { url: original, bytes: 123, sha256: 'b'.repeat(64) },
  pdf: {
    url: 'https://assets.ultraclipart.com/fixture/original.pdf',
    bytes: 234,
    sha256: 'c'.repeat(64),
  },
};
const transport = { protocol: 'snapshot-search-v1', endpoint: '/catalog-search.json', snapshot };
const repository = (
  fallback = async () => {
    throw Error('Unexpected legacy fallback');
  },
) => ({ manifest: async () => ({ transport }), favoriteItems: fallback, clear() {} });
async function withFetch(handler, run) {
  const previous = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    await run();
  } finally {
    globalThis.fetch = previous;
  }
}
test('visible category batch uses one existing pinned source request and preserves the original', async () => {
  let calls = 0;
  await withFetch(
    async (url, init) => {
      calls++;
      assert.equal(url, '/catalog-search.json');
      assert.equal(init.cache, 'no-store');
      assert.deepEqual(JSON.parse(init.body), {
        schema: 1,
        operation: 'studio-items',
        snapshot,
        ids: [id],
      });
      return Response.json({ schema: 1, snapshot, result: [asset] });
    },
    async () => {
      const result = await categorySamples(repository(), [id], new AbortController().signal);
      assert.deepEqual(result, [
        {
          id,
          title: asset.title,
          alt: asset.alt,
          webp: original,
          preview: { source: original, url: thumb },
        },
      ]);
      assert.equal(calls, 1);
    },
  );
});
test('foreign or queried thumbnail URLs never become category loading previews', async () => {
  for (const value of [
    'https://evil.invalid/a.webp',
    thumb + '?tracking=1',
    'http://assets.ultraclipart.com/a.webp',
    original,
  ])
    await withFetch(
      async () => Response.json({ schema: 1, snapshot, result: [{ ...asset, thumb: value }] }),
      async () => {
        const [item] = await categorySamples(repository(), [id], new AbortController().signal);
        assert.equal(item.webp, original);
        assert.equal(item.preview, undefined);
      },
    );
});
test('changed snapshot and replaced identities fail closed without a legacy fallback', async () => {
  for (const body of [
    { schema: 1, snapshot: 'd'.repeat(64), result: [asset] },
    { schema: 1, snapshot, result: [{ ...asset, id: 'wrong-id' }] },
  ])
    await withFetch(
      async () => Response.json(body),
      async () => assert.rejects(categorySamples(repository(), [id], new AbortController().signal)),
    );
});
test('unsupported legacy Studio representation falls back to the same original card', async () => {
  let calls = 0;
  const legacy = { id, title: asset.title, alt: asset.alt, webp: original, thumb: original };
  await withFetch(
    async () => new Response('', { status: 503 }),
    async () => {
      const value = await categorySamples(
        repository(async (ids) => {
          calls++;
          assert.deepEqual(ids, [id]);
          return [legacy];
        }),
        [id],
        new AbortController().signal,
      );
      assert.deepEqual(value, [legacy]);
      assert.equal(calls, 1);
    },
  );
});
test('batch bounds reject duplicates and more than twelve sources before network access', async () => {
  await assert.rejects(categorySamples(repository(), [id, id], new AbortController().signal));
  await assert.rejects(
    categorySamples(
      repository(),
      Array.from({ length: 13 }, (_, i) => 'fixture-' + i),
      new AbortController().signal,
    ),
  );
});
test('obsolete metadata cancellation never starts a fallback request', async () => {
  const controller = new AbortController();
  await withFetch(
    async (url, init) => {
      controller.abort();
      throw new DOMException('Cancelled', 'AbortError');
    },
    async () => {
      await assert.rejects(categorySamples(repository(), [id], controller.signal), {
        name: 'AbortError',
      });
    },
  );
});

test('one explicit stale-root response refreshes the manifest and re-pins once', async () => {
  const next = 'd'.repeat(64);
  let calls = 0,
    clears = 0;
  const repo = {
    ...repository(),
    clear() {
      clears++;
    },
    manifest: async () => ({
      transport: { ...transport, snapshot: clears ? next : rootForTest() },
    }),
  };
  function rootForTest() {
    return snapshot;
  }
  await withFetch(
    async (url, init) => {
      calls++;
      assert.equal(JSON.parse(init.body).snapshot, calls === 1 ? snapshot : next);
      return calls === 1
        ? new Response('', { status: 409 })
        : Response.json({ schema: 1, snapshot: next, result: [asset] });
    },
    async () => {
      const [item] = await categorySamples(repo, [id], new AbortController().signal);
      assert.equal(item.webp, original);
      assert.equal(calls, 2);
      assert.equal(clears, 1);
    },
  );
});
test('a second stale-root response stops instead of retrying indefinitely', async () => {
  let calls = 0,
    clears = 0;
  await withFetch(
    async () => {
      calls++;
      return new Response('', { status: 412 });
    },
    async () => {
      await assert.rejects(
        categorySamples(
          {
            ...repository(),
            clear() {
              clears++;
            },
          },
          [id],
          new AbortController().signal,
        ),
      );
      assert.equal(calls, 2);
      assert.equal(clears, 1);
    },
  );
});
