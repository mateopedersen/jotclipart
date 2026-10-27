import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAssetWithRetry } from '../server/delivery/asset-retry.mjs';

test('static origin 5xx is retried once, after its body is closed, preserving the request', async () => {
  for (const status of [500, 502, 503, 504]) {
    const order = [],
      seen = [],
      original = new Request('https://ultraclipart.com/previews/p1/source-960.webp?v=1', {
        headers: { Range: 'bytes=0-63', 'If-None-Match': 'expected-file' },
      }),
      expected = new Response('verified bytes', {
        status: 206,
        headers: { 'Content-Type': 'image/webp', ETag: 'actual-file' },
      });
    const assets = {
      async fetch(request) {
        seen.push(request);
        order.push('fetch');
        return seen.length === 1
          ? new Response(new ReadableStream({ cancel: () => order.push('cancel') }), { status })
          : expected;
      },
    };
    const actual = await fetchAssetWithRetry(original, assets, {
      wait: async (ms) => order.push(`wait:${ms}`),
    });
    assert.equal(actual, expected);
    assert.equal(await actual.text(), 'verified bytes');
    assert.deepEqual(order, ['fetch', 'cancel', 'wait:250', 'fetch']);
    assert.equal(seen[1].url, original.url);
    assert.equal(seen[1].method, 'GET');
    assert.equal(seen[1].headers.get('range'), 'bytes=0-63');
    assert.equal(seen[1].headers.get('if-none-match'), 'expected-file');
    assert.equal(actual.headers.get('etag'), 'actual-file');
  }
});

test('a second failure remains the actual failure without an unbounded retry', async () => {
  let calls = 0;
  const second = new Response('origin unavailable', { status: 503 });
  const actual = await fetchAssetWithRetry(
    new Request('https://ultraclipart.com/'),
    { fetch: async () => (++calls === 1 ? new Response(null, { status: 500 }) : second) },
    { wait: async () => {} },
  );
  assert.equal(calls, 2);
  assert.equal(actual, second);
  assert.equal(actual.status, 503);
  assert.equal(await actual.text(), 'origin unavailable');
});

test('ordinary responses, redirects, auth failures, rate limits and 404s are not retried', async () => {
  for (const status of [200, 204, 206, 301, 304, 400, 401, 403, 404, 408, 409, 429, 501]) {
    let calls = 0;
    const expected = new Response(null, { status });
    const actual = await fetchAssetWithRetry(new Request('https://ultraclipart.com/'), {
      fetch: async () => {
        calls++;
        return expected;
      },
    });
    assert.equal(calls, 1);
    assert.equal(actual, expected);
  }
});

test('POST, PUT, PATCH, DELETE and OPTIONS are never replayed', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    let calls = 0;
    const first = new Response('unchanged failure', { status: 500 });
    const actual = await fetchAssetWithRetry(new Request('https://ultraclipart.com/', { method }), {
      fetch: async () => {
        calls++;
        return first;
      },
    });
    assert.equal(calls, 1);
    assert.equal(actual, first);
    assert.equal(await actual.text(), 'unchanged failure');
  }
});

test('HEAD retries once without requiring a body', async () => {
  let calls = 0;
  const actual = await fetchAssetWithRetry(
    new Request('https://ultraclipart.com/favicon-96.png', { method: 'HEAD' }),
    {
      fetch: async (request) => {
        assert.equal(request.method, 'HEAD');
        return new Response(null, { status: ++calls === 1 ? 502 : 200 });
      },
    },
    { wait: async () => {} },
  );
  assert.equal(calls, 2);
  assert.equal(actual.status, 200);
});

test('a request aborted before the first response does not make another origin request', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const first = new Response('original failure', { status: 500 });
  const actual = await fetchAssetWithRetry(
    new Request('https://ultraclipart.com/', { signal: controller.signal }),
    {
      fetch: async () => {
        calls++;
        return first;
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(actual, first);
});

test('abort during the short wait prevents the second request', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    fetchAssetWithRetry(
      new Request('https://ultraclipart.com/', { signal: controller.signal }),
      { fetch: async () => (calls++, new Response(null, { status: 500 })) },
      { wait: async () => controller.abort() },
    ),
    { name: 'AbortError' },
  );
  assert.equal(calls, 1);
});

test('network exceptions and an invalid delay are not disguised as successful responses', async () => {
  const failure = new Error('origin connection failed');
  let calls = 0;
  const binding = { fetch: async () => (calls++, Promise.reject(failure)) };
  await assert.rejects(
    fetchAssetWithRetry(new Request('https://ultraclipart.com/'), binding),
    failure,
  );
  assert.equal(calls, 1);
  for (const delayMs of [-1, 1001, NaN, 0.5])
    await assert.rejects(
      fetchAssetWithRetry(new Request('https://ultraclipart.com/'), binding, { delayMs }),
      RangeError,
    );
  assert.equal(calls, 1);
});
