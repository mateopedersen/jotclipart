import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotHTMLResponse } from '../../server/catalog-snapshot/snapshot-html-cache.mjs';
const rendererSHA256 = 'a'.repeat(64),
  one = { rootSHA256: 'b'.repeat(64), snapshot: { revision: '1'.repeat(40) } },
  two = { rootSHA256: 'c'.repeat(64), snapshot: { revision: '2'.repeat(40) } },
  url = 'https://jotclipart.com/art/example/';
function memory() {
  const values = new Map();
  return {
    values,
    match: async (key) => values.get(key.url)?.clone(),
    put: async (key, response) => values.set(key.url, response.clone()),
  };
}
const html = (text) =>
  new Response(`<html><title>${text}</title><h1>${text}</h1></html>`, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
test('a slow edge write does not delay the HTML response when execution deferral is provided', async () => {
  let release;
  const gate = new Promise((r) => (release = r)),
    tasks = [];
  const cache = { match: async () => undefined, put: async () => gate };
  const result = await snapshotHTMLResponse({
    context: one,
    rendererSHA256,
    cache,
    request: new Request(url),
    render: () => html('ready'),
    defer: (task) => tasks.push(task),
  });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('x-uc-html-cache'), 'MISS');
  assert.match(await result.text(), /ready/);
  assert.equal(tasks.length, 1);
  release();
  await Promise.all(tasks);
});
test('edge cache write failure never replaces a successful public page', async () => {
  const result = await snapshotHTMLResponse({
    context: one,
    rendererSHA256,
    cache: {
      match: async () => undefined,
      put: async () => {
        throw Error('Unavailable cache');
      },
    },
    request: new Request(url),
    render: () => html('ready'),
  });
  assert.equal(result.status, 200);
  assert.match(await result.text(), /ready/);
});
test('new requests use current root while captured in-flight root remains stable', async () => {
  const cache = memory();
  let renders = 0;
  const render = () => {
    renders++;
    return html('complete server HTML');
  };
  const first = await snapshotHTMLResponse({
    request: new Request(url),
    context: one,
    rendererSHA256,
    cache,
    render,
  });
  assert.match(await first.text(), /<h1>complete server HTML/);
  const oldTag = first.headers.get('etag');
  const cached = await snapshotHTMLResponse({
    request: new Request(url),
    context: one,
    rendererSHA256,
    cache,
    render,
  });
  assert.equal(cached.headers.get('etag'), oldTag);
  assert.equal(renders, 1);
  const changed = await snapshotHTMLResponse({
    request: new Request(url, { headers: { 'if-none-match': oldTag } }),
    context: two,
    rendererSHA256,
    cache,
    render: () => html('new content'),
  });
  assert.equal(changed.status, 200);
  assert.match(await changed.text(), /new content/);
  assert.equal(changed.headers.get('cache-control'), 'no-cache');
  const same = await snapshotHTMLResponse({
    request: new Request(url, { headers: { 'if-none-match': changed.headers.get('etag') } }),
    context: two,
    rendererSHA256,
    cache,
    render,
  });
  assert.equal(same.status, 304);
  assert.equal(await same.text(), '');
  assert.equal(cache.values.size, 2);
});
test('HEAD keeps representation metadata and failed render never enters cache', async () => {
  const cache = memory(),
    options = { context: one, rendererSHA256, cache, render: () => html('head') };
  const head = await snapshotHTMLResponse({
    ...options,
    request: new Request(url, { method: 'HEAD' }),
  });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const get = await snapshotHTMLResponse({ ...options, request: new Request(url) });
  assert.match(await get.text(), /<title>head/);
  const empty = memory();
  const fail = await snapshotHTMLResponse({
    ...options,
    cache: empty,
    request: new Request(url),
    render: () => new Response('broken', { status: 503 }),
  });
  assert.equal(fail.status, 503);
  assert.equal(empty.values.size, 0);
  assert.equal(fail.headers.get('etag'), null);
});
test('cache rejects foreign origin, unsafe route and changed metadata binding', async () => {
  const cache = memory(),
    options = { context: one, rendererSHA256, cache, render: () => html('safe') };
  await assert.rejects(
    snapshotHTMLResponse({
      ...options,
      request: new Request('https://attacker.test/art/example/'),
    }),
  );
  await assert.rejects(
    snapshotHTMLResponse({ ...options, request: new Request('https://jotclipart.com/admin/') }),
  );
  await snapshotHTMLResponse({ ...options, request: new Request(url) });
  const [key, response] = [...cache.values][0];
  const headers = new Headers(response.headers);
  headers.set('x-uc-revision', two.snapshot.revision);
  cache.values.set(key, new Response('modified', { headers }));
  await assert.rejects(snapshotHTMLResponse({ ...options, request: new Request(url) }));
});
test('catalog shells share one root-bound cache representation across tracking queries', async () => {
  const cache = memory();
  let renders = 0;
  for (const path of [
    '/',
    '/new/',
    '/search/',
    '/black-and-white/',
    '/categories/',
    '/collections/',
    '/library-index/',
    '/create/',
    '/favorites/',
    '/collection/flags-countries/',
  ]) {
    const options = {
      context: one,
      rendererSHA256,
      cache,
      render: () => {
        renders++;
        return html(path);
      },
    };
    await snapshotHTMLResponse({
      ...options,
      request: new Request('https://jotclipart.com' + path + '?utm_source=one'),
    });
    await snapshotHTMLResponse({
      ...options,
      request: new Request('https://jotclipart.com' + path + '?q=second'),
    });
  }
  assert.equal(renders, 10);
  assert.equal(cache.values.size, 10);
});
test('approved project origins render with separate origin/root-bound representations', async () => {
  const cache = memory();
  let renders = 0;
  const etags = new Set();
  for (const origin of [
    'https://jotclipart.com',
    'https://preview.jotclipart.com',
    'https://jotclipart.pages.dev',
    'https://31312903.jotclipart.pages.dev',
    'https://catalog-snapshot-ba3582a.jotclipart.pages.dev',
  ]) {
    const response = await snapshotHTMLResponse({
      context: one,
      rendererSHA256,
      cache,
      request: new Request(origin + '/clipart/qatar-flag/'),
      render: () => {
        renders++;
        return html('Qatar Flag Clipart ' + origin);
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-uc-html-cache'), 'MISS');
    assert((await response.text()).includes(origin));
    etags.add(response.headers.get('etag'));
    const cached = await snapshotHTMLResponse({
      context: one,
      rendererSHA256,
      cache,
      request: new Request(origin + '/clipart/qatar-flag/?utm_source=repeat'),
      render: () => {
        throw Error('A same-origin warm request must reuse its representation');
      },
    });
    assert.equal(cached.headers.get('x-uc-html-cache'), 'HIT');
    assert((await cached.text()).includes(origin));
  }
  assert.equal(renders, 5);
  assert.equal(cache.values.size, 5);
  assert.equal(etags.size, 5);
});
test('custom preview GET/HEAD/conditional responses never reuse production bytes or validators', async () => {
  const cache = memory();
  const request = async (origin, init) =>
    snapshotHTMLResponse({
      context: one,
      rendererSHA256,
      cache,
      request: new Request(origin + '/?q=visitor', init),
      render: () => html(origin),
    });
  const production = await request('https://jotclipart.com');
  const tag = production.headers.get('etag');
  const preview = await request('https://preview.jotclipart.com', {
    headers: { 'if-none-match': tag },
  });
  assert.equal(preview.status, 200);
  assert.notEqual(preview.headers.get('etag'), tag);
  assert((await preview.text()).includes('https://preview.jotclipart.com'));
  const head = await request('https://preview.jotclipart.com', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('x-uc-html-cache'), 'HIT');
  const unchanged = await request('https://preview.jotclipart.com', {
    headers: { 'if-none-match': head.headers.get('etag') },
  });
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), '');
  assert.equal(cache.values.size, 2);
});
test('simultaneous production and preview renders have distinct single-flight keys', async () => {
  const cache = memory();
  let renders = 0;
  const values = await Promise.all(
    ['https://jotclipart.com', 'https://preview.jotclipart.com'].map((origin) =>
      snapshotHTMLResponse({
        context: one,
        rendererSHA256,
        cache,
        request: new Request(origin + '/'),
        render: async () => {
          renders++;
          await Promise.resolve();
          return html(origin);
        },
      }),
    ),
  );
  assert.equal(renders, 2);
  assert.notEqual(await values[0].text(), await values[1].text());
  assert.equal(cache.values.size, 2);
});
test('preview allowance never admits another project, nested domain, port or plaintext', async () => {
  for (const origin of [
    'https://other.pages.dev',
    'https://jotclipart.pages.dev.attacker.test',
    'https://nested.preview.jotclipart.pages.dev',
    'https://unapproved.jotclipart.com',
    'https://nested.preview.jotclipart.com',
    'https://preview.jotclipart.com.attacker.test',
    'https://jotclipart.com:444',
    'https://preview.jotclipart.com:444',
    'http://jotclipart.com',
    'http://preview.jotclipart.com',
    'http://31312903.jotclipart.pages.dev',
    'https://ultraclipart.com',
  ])
    await assert.rejects(
      snapshotHTMLResponse({
        context: one,
        rendererSHA256,
        cache: memory(),
        request: new Request(origin + '/'),
        render: () => html('forbidden'),
      }),
      /Invalid cache route/,
    );
});
test('custom preview keeps request-size and authenticated renderer/root guards', async () => {
  const options = { context: one, rendererSHA256, cache: memory(), render: () => html('guarded') };
  await assert.rejects(
    snapshotHTMLResponse({
      ...options,
      request: new Request('https://preview.jotclipart.com/?q=' + 'x'.repeat(4096)),
    }),
    /Invalid cache route/,
  );
  for (const context of [
    { ...one, rootSHA256: '' },
    { ...one, rootSHA256: 'b'.repeat(63) },
  ]) {
    await assert.rejects(
      snapshotHTMLResponse({
        ...options,
        context,
        request: new Request('https://preview.jotclipart.com/'),
      }),
      /Captured snapshot and renderer binding required/,
    );
  }
  await assert.rejects(
    snapshotHTMLResponse({
      ...options,
      rendererSHA256: 'invalid',
      request: new Request('https://preview.jotclipart.com/'),
    }),
    /Captured snapshot and renderer binding required/,
  );
});
