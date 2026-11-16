import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  localNavigationHeaders,
  createLocalPreview,
  serveLocal,
} from '../scripts/jotclipart/serve-local.mjs';

test('local Surprise canonical redirects preserve the preview origin, status and every query parameter', () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const response = new Response(null, {
      status,
      headers: {
        location: 'https://jotclipart.com/art/a-real-canonical/?q=rose%20heart&page=2#image',
        'x-uc-snapshot': 'fixture-root',
      },
    });
    const headers = localNavigationHeaders(response, 'http://127.0.0.1:8797');
    assert.equal(
      headers.get('location'),
      'http://127.0.0.1:8797/art/a-real-canonical/?q=rose%20heart&page=2#image',
    );
    assert.equal(headers.get('x-uc-snapshot'), 'fixture-root');
    assert.equal(
      response.headers.get('location'),
      'https://jotclipart.com/art/a-real-canonical/?q=rose%20heart&page=2#image',
    );
    assert.equal(response.status, status);
  }
});
test('old/external hosts, credentials, ports and nonredirect responses are never remapped', () => {
  for (const location of [
    'https://ultraclipart.com/art/example/',
    'https://example.com/a',
    'https://jotclipart.com:444/a',
    'https://user:private@jotclipart.com/a',
    'https://jotclipart.com.evil.test/a',
  ]) {
    const response = new Response(null, { status: 301, headers: { location } });
    assert.equal(
      localNavigationHeaders(response, 'http://localhost:8797').get('location'),
      location,
    );
  }
  const response = new Response('same bytes', {
    headers: {
      location: 'https://jotclipart.com/a',
      'content-encoding': 'gzip',
      'cache-control': 'private, no-store',
    },
  });
  assert.deepEqual(
    [...localNavigationHeaders(response, 'http://localhost:8797')],
    [...response.headers],
  );
  for (const origin of ['https://jotclipart.com', 'http://evil.test:8797', 'http://127.0.0.1:0'])
    assert.throws(() => localNavigationHeaders(response, origin));
});

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const previewKey = 'delivery/previews/p1/' + 'ab'.repeat(12) + '-960.webp';
const compressed = gzipSync(Buffer.from('Genuine gzip representation: image, PDF, edit.'));

// An isolated, read-only worker exercises the actual Node HTTP and bucket adapter.
// It has no cloud bindings, signature bypass, write methods, or application state.
async function adapterFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'jotclipart-local-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'dist'));
  await mkdir(join(root, 'metadata'));
  await writeFile(
    join(root, 'dist', '_worker.js'),
    `export default { async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === '/redirect') return new Response(
        Uint8Array.from(atob(${JSON.stringify(compressed.toString('base64'))}), c => c.charCodeAt(0)),
        {status:301, headers:{
          location:'https://jotclipart.com/art/local-canonical/?q=rose%20heart&tag=a%2Bb#image',
          'content-type':'text/plain', 'content-encoding':'gzip',
          'content-length':${JSON.stringify(String(compressed.length))},
          'cache-control':'private, no-store', 'vary':'Accept-Encoding',
          'x-uc-snapshot':'fixture-root', 'x-test-header':'unchanged'
        }});
      if (url.pathname === '/origin') return Response.json({
        origin:request.headers.get('origin'), method:request.method,
        url:request.url, body:await request.text()
      });
      const object = await env.CATALOG_PAGES.get(url.searchParams.get('key'));
      if (!object) return new Response(null,{status:404});
      return new Response(await object.arrayBuffer(),{
        headers:{'content-type':object.httpMetadata.contentType,
                 'x-fixture-size':String(object.size)}
      });
    }};`,
  );
  const previousCaches = globalThis.caches;
  t.after(() => {
    if (previousCaches === undefined) delete globalThis.caches;
    else globalThis.caches = previousCaches;
  });
  return { root, metadata: join(root, 'metadata'), cache: false };
}
const bucketRequest = (key) => '/bucket?key=' + encodeURIComponent(key);
function rawHTTP(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }),
      );
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('only syntactically valid explicit loopback origins and public canonical destinations are admitted', () => {
  const response = new Response(null, {
    status: 308,
    headers: { location: '/art/canonical/?plus=a%2Bb&empty=#view' },
  });
  for (const origin of [
    'https://localhost:8797',
    'http://user:pass@localhost:8797',
    'http://127.0.0.1.evil.test:8797',
    'http://127.0.0.2:8797',
    'http://[::1]:8797',
    'http://localhost:65536',
    'http://localhost:00001',
    'http://localhost:8797/',
    'http://localhost:8797?x=1',
    'http://localhost:8797#part',
    ' http://localhost:8797',
    'http://localhost',
  ])
    assert.throws(() => localNavigationHeaders(response, origin), origin);
  assert.equal(
    localNavigationHeaders(response, 'http://localhost:65535').get('location'),
    'http://localhost:65535/art/canonical/?plus=a%2Bb&empty=#view',
  );
  for (const location of [
    'http://jotclipart.com/a',
    'https://www.jotclipart.com/a',
    '//evil.test/art/a',
    'https://jotclipart.com:8443/a',
    'https://name@jotclipart.com/a',
    'https://jotclipart.com@evil.test/a',
  ]) {
    const input = new Response(null, { status: 302, headers: { location } });
    assert.equal(localNavigationHeaders(input, 'http://127.0.0.1:8797').get('location'), location);
  }
});

test('real local HTTP 301 GET and HEAD retain gzip bytes and representation headers while preserving canonical query', async (t) => {
  const options = await adapterFixture(t);
  const { server, url } = await serveLocal({ ...options, port: 0 });
  t.after(() => new Promise((done) => server.close(done)));
  for (const method of ['GET', 'HEAD']) {
    const response = await rawHTTP(url + '/redirect', { method });
    assert.equal(response.status, 301);
    assert.equal(
      response.headers.location,
      url + '/art/local-canonical/?q=rose%20heart&tag=a%2Bb#image',
    );
    assert.equal(response.headers['content-encoding'], 'gzip');
    assert.equal(response.headers['content-length'], String(compressed.length));
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.equal(response.headers.vary, 'Accept-Encoding');
    assert.equal(response.headers['x-uc-snapshot'], 'fixture-root');
    assert.equal(response.headers['x-test-header'], 'unchanged');
    assert.deepEqual(response.body, method === 'HEAD' ? Buffer.alloc(0) : compressed);
    if (method === 'GET')
      assert.equal(
        gunzipSync(response.body).toString(),
        'Genuine gzip representation: image, PDF, edit.',
      );
  }
  const port = new URL(url).port;
  assert.match(
    (await rawHTTP(url + '/redirect', { headers: { host: 'localhost:' + port } })).headers.location,
    new RegExp('^http://localhost:' + port + '/art/local-canonical/'),
  );
});

test('the actual HTTP adapter rewrites only its own two browser origins and preserves foreign CSRF origins and request bytes', async (t) => {
  const options = await adapterFixture(t);
  const { server, url } = await serveLocal({ ...options, port: 0 });
  t.after(() => new Promise((done) => server.close(done)));
  const port = new URL(url).port;
  for (const [origin, expected] of [
    [url, 'https://jotclipart.com'],
    ['http://localhost:' + port, 'https://jotclipart.com'],
    ['http://localhost:1', 'http://localhost:1'],
    ['https://foreign.test', 'https://foreign.test'],
    ['null', 'null'],
    ['http://localhost:' + port + '.evil.test', 'http://localhost:' + port + '.evil.test'],
  ]) {
    const response = await rawHTTP(url + '/origin?q=a%2Bb', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: '{"literal":"a+b %20"}',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), {
      origin: expected,
      method: 'POST',
      url: 'https://jotclipart.com/origin?q=a%2Bb',
      body: '{"literal":"a+b %20"}',
    });
  }
  assert.equal(JSON.parse((await rawHTTP(url + '/origin')).body).origin, null);
});

test('public preview-byte fallback is opt-in and refuses every nonexact origin before filesystem or network access', async () => {
  for (const previewBodyOrigin of [
    'http://preview.jotclipart.com',
    'https://preview.jotclipart.com/',
    'https://preview.jotclipart.com:443',
    'https://preview.jotclipart.com.evil.test',
    'https://user:private@preview.jotclipart.com',
    'https://assets.ultraclipart.com',
    'https://jotclipart.com?proxy=https://evil.test',
  ])
    await assert.rejects(
      createLocalPreview({ root: '/nonexistent-local-adapter-fixture', previewBodyOrigin }),
      /Exact public JotClipart preview-body origin required/,
    );
});

test('exact preview-byte keys read only the selected public host with no caller headers, credentials, redirects or extra paths', async (t) => {
  const options = await adapterFixture(t);
  const calls = [];
  const bytes = Buffer.from(
    'opaque adapter bytes; the real runtime separately verifies full SHA and WebP',
  );
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    return new Response(bytes, { headers: { 'content-type': 'image/webp' } });
  });
  for (const previewBodyOrigin of ['https://jotclipart.com', 'https://preview.jotclipart.com']) {
    const preview = await createLocalPreview({ ...options, previewBodyOrigin });
    const response = await preview.handle(bucketRequest(previewKey), {
      headers: { authorization: 'private-fixture-token', cookie: 'private-fixture-cookie' },
    });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.equal(response.headers.get('x-fixture-size'), String(bytes.length));
    assert.equal(preview.summary().publicPreviewBodyReads, 1);
    assert.equal(preview.summary().publicPreviewBodyBytes, bytes.length);
  }
  assert.equal(calls.length, 2);
  for (const [index, call] of calls.entries()) {
    assert.equal(
      call.url,
      ['https://jotclipart.com', 'https://preview.jotclipart.com'][index] + previewKey.slice(8),
    );
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.credentials, 'omit');
    assert.equal(call.init.headers, undefined);
    assert.equal(call.init.method, undefined);
    assert(call.init.signal instanceof AbortSignal);
    assert.equal(call.init.signal.aborted, false);
  }
  const preview = await createLocalPreview({
    ...options,
    previewBodyOrigin: 'https://preview.jotclipart.com',
  });
  for (const key of [
    previewKey.replace('-960', '-440'),
    previewKey.replace('ab', 'AB'),
    previewKey + '?proxy=1',
    'delivery/previews/p1/../private.json',
    'delivery//previews/p1/' + 'ab'.repeat(12) + '-960.webp',
    'delivery/originals/private.webp',
  ])
    await assert.rejects(preview.handle(bucketRequest(key)), /Local catalog scope rejected/);
  const noFallback = await createLocalPreview(options);
  await assert.rejects(
    noFallback.handle(bucketRequest(previewKey)),
    /Local catalog scope rejected/,
  );
  assert.equal(calls.length, 2, 'Rejected and non-opt-in paths never reach the public network');
});

test('public preview bodies fail closed for MIME, redirects, outages and oversized streams; the exact 1 MiB bound is accepted', async (t) => {
  const options = await adapterFixture(t);
  const preview = await createLocalPreview({
    ...options,
    previewBodyOrigin: 'https://preview.jotclipart.com',
  });
  let next = () => new Response(null, { status: 404 });
  t.mock.method(globalThis, 'fetch', async () => next());
  assert.equal((await preview.handle(bucketRequest(previewKey))).status, 404);
  for (const make of [
    () => new Response('not WebP', { headers: { 'content-type': 'text/html' } }),
    () => new Response('missing MIME'),
    () => new Response('error', { status: 503, headers: { 'content-type': 'image/webp' } }),
    () =>
      new Response(null, {
        status: 302,
        headers: { 'content-type': 'image/webp', location: 'https://foreign.test/a' },
      }),
  ]) {
    next = make;
    await assert.rejects(
      preview.handle(bucketRequest(previewKey)),
      /Verified local editor preview unavailable/,
    );
  }
  next = () => {
    throw Error('Fixture network unavailable');
  };
  await assert.rejects(preview.handle(bucketRequest(previewKey)), /Fixture network unavailable/);
  let cancelled = false;
  next = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024));
          controller.enqueue(new Uint8Array(1));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'content-type': 'image/webp' } },
    );
  await assert.rejects(
    preview.handle(bucketRequest(previewKey)),
    /Local editor preview exceeds bound/,
  );
  assert.equal(cancelled, true);
  assert.equal(preview.summary().publicPreviewBodyReads, 0);
  next = () =>
    new Response(new Uint8Array(1024 * 1024), { headers: { 'content-type': 'image/webp' } });
  assert.equal(
    (await (await preview.handle(bucketRequest(previewKey))).arrayBuffer()).byteLength,
    1024 * 1024,
  );
  assert.equal(preview.summary().publicPreviewBodyReads, 1);
});

test('the adapter retains exact captured-metadata hashes and rejects corruption or arbitrary local keys without network fallback', async (t) => {
  const options = await adapterFixture(t);
  let networkCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    networkCalls++;
    throw Error('Network forbidden');
  });
  const bytes = Buffer.from('{"schema":1,"fixture":"captured-only"}');
  const hash = sha(bytes);
  const key = 'catalog/objects/artworks/' + hash + '.json';
  await writeFile(join(options.metadata, hash + '.json'), bytes);
  const preview = await createLocalPreview(options);
  assert.deepEqual(
    Buffer.from(await (await preview.handle(bucketRequest(key))).arrayBuffer()),
    bytes,
  );
  await writeFile(
    join(options.metadata, hash + '.json'),
    Buffer.from('{"schema":1,"fixture":"corrupted"}'),
  );
  await assert.rejects(preview.handle(bucketRequest(key)), /Local catalog checksum mismatch/);
  for (const key of [
    'catalog/objects/artworks/' + 'f'.repeat(64) + '.json',
    'catalog/jotclipart/active.json',
  ])
    assert.equal((await preview.handle(bucketRequest(key))).status, 404);
  for (const key of [
    '../secret.json',
    'catalog/objects/unknown/' + hash + '.json',
    'catalog/ultraclipart/active.json',
  ])
    await assert.rejects(preview.handle(bucketRequest(key)), /Local catalog scope rejected/);
  assert.equal(networkCalls, 0);
});
