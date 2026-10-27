import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createPublicFileHandler } from '../server/delivery/public-files.mjs';
import { stagingWorker } from '../scripts/delivery/staging-worker.mjs';
import { merkle, digest } from '../scripts/delivery/manifest.mjs';
const revision = 'a'.repeat(40),
  body = '<!doctype html><title>Reviewed scene</title>',
  imagePath = '/previews/p1/' + 'b'.repeat(24) + '-440.webp';
function fixture() {
  const objects = new Map([
    [`delivery/${revision}/art/scene/index.html`, body],
    [`delivery/${revision}/edit/scene/index.html`, body],
    [`delivery${imagePath}`, 'image-bytes'],
    ['delivery/assets/_astro/a.js', 'code'],
  ]);
  const calls = [];
  const entry = (key, options) => {
    calls.push([key, options]);
    const value = objects.get(key);
    if (value === undefined) return null;
    const bytes = new TextEncoder().encode(value),
      data = options?.range
        ? bytes.slice(options.range.offset, options.range.offset + options.range.length)
        : bytes;
    return {
      size: bytes.length,
      httpEtag: '"checked"',
      httpMetadata: { contentType: key.endsWith('.html') ? 'text/html' : 'image/webp' },
      body: new Response(data).body,
    };
  };
  const env = { CATALOG_PAGES: { get: async (k, o) => entry(k, o), head: async (k) => entry(k) } };
  const fallback = { fetch: async () => new Response('missing', { status: 404 }) };
  const options = {
    revision,
    ids: ['scene', 'withdrawn'],
    withdrawnIds: ['withdrawn'],
    pageHeaders: { 'Content-Security-Policy': "default-src 'self'" },
    editorHeaders: { 'Content-Security-Policy': "default-src 'self'; frame-src 'self'" },
  };
  const handle = createPublicFileHandler(options);
  const run = (path, init, cache) =>
    handle(
      new Request('https://ultraclipart.com' + path, init),
      env,
      { waitUntil: () => {} },
      fallback,
      cache,
    );
  return { run, objects, calls, env };
}
test('R2 detail/editor responses retain full HTML, headers, noindex and URL identity', async () => {
  const { run, calls } = fixture();
  const response = await run('/art/scene/?utm=visit');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), body);
  assert.equal(response.headers.get('Content-Security-Policy'), "default-src 'self'");
  assert.match(response.headers.get('X-UC-Delivery'), /r2/);
  const editor = await run('/edit/scene/');
  assert.equal(editor.headers.get('X-Robots-Tag'), 'noindex');
  assert.match(editor.headers.get('Content-Security-Policy'), /frame-src/);
  assert.equal(calls.length, 2);
});
test('canonical redirects, unknown/withdrawn routes and immutable paths remain bounded', async () => {
  const { run, calls } = fixture();
  assert.equal(
    (await run('/art/scene?x=y')).headers.get('Location'),
    'https://ultraclipart.com/art/scene/?x=y',
  );
  for (const path of [
    '/art/unknown/',
    '/art/withdrawn/',
    '/api/ai/run',
    '/previews/p1/not-valid.webp',
  ])
    assert.equal((await run(path)).status, 404);
  assert.equal(calls.length, 0);
  assert.equal((await run('/art/scene/', { method: 'POST' })).status, 405);
  assert.equal((await run(imagePath)).status, 200);
  assert.equal((await run('/_astro/a.js')).status, 200);
});
test('missing binding/object and R2 errors are honest uncacheable outages', async () => {
  const { run, objects, env } = fixture();
  objects.clear();
  assert.equal((await run('/art/scene/')).status, 503);
  env.CATALOG_PAGES.get = async () => {
    throw Error('outage');
  };
  const response = await run(imagePath);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});
test('HEAD, ETag, partial and invalid ranges use the correct object bounds', async () => {
  const { run } = fixture();
  const head = await run(imagePath, { method: 'HEAD' });
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('Content-Length'), '11');
  assert.equal((await run(imagePath, { headers: { 'If-None-Match': '"checked"' } })).status, 304);
  const partial = await run(imagePath, { headers: { Range: 'bytes=1-3' } });
  assert.equal(partial.status, 206);
  assert.equal(await partial.text(), 'mag');
  assert.equal(partial.headers.get('Content-Range'), 'bytes 1-3/11');
  assert.equal((await run(imagePath, { headers: { Range: 'bytes=100-200' } })).status, 416);
  const full = await run(imagePath, { headers: { Range: 'bytes=1-3', 'If-Range': '"old"' } });
  assert.equal(full.status, 200);
  assert.equal(await full.text(), 'image-bytes');
});
test('release cache is shared across tracking queries and a failed cache uses R2', async () => {
  const { run, calls } = fixture();
  let key;
  const cache = {
    match: async (request) => {
      key = request.url;
      return new Response(body, {
        headers: { ETag: '"checked"', 'Cache-Control': 'public,max-age=300' },
      });
    },
  };
  assert.equal((await run('/art/scene/?utm=a', undefined, cache)).status, 200);
  assert(key.includes('__uc_release=' + revision));
  assert(!key.includes('utm'));
  assert.equal(calls.length, 0);
  const failure = {
    match: async () => {
      throw Error('cache unavailable');
    },
    put: async () => {},
  };
  assert.equal((await run('/art/scene/', undefined, failure)).status, 200);
  assert.equal(calls.length, 1);
});
const secret = 'a'.repeat(64),
  accountId = 'b'.repeat(32),
  record = {
    path: imagePath,
    key: `delivery${imagePath}`,
    bytes: 3,
    sha256: digest(Buffer.from('abc')),
    mime: 'image/webp',
  };
const tree = merkle([record]);
const job = {
  root: tree.root,
  revision,
  accountId,
  bucket: 'ultraclipart-pages',
  secret,
  sourceOrigin: 'https://ultraclipart.com',
};
function stageBody() {
  const lease = {
    root: tree.root,
    accountId,
    bucket: job.bucket,
    projectedBytes: 1000,
    observedAt: Date.now(),
  };
  return {
    lease,
    signature: createHmac('sha256', Buffer.from(secret, 'hex'))
      .update(JSON.stringify(lease))
      .digest('hex'),
    records: [{ record, proof: tree.proof(0) }],
    blobs: { [imagePath]: Buffer.from('abc').toString('base64') },
  };
}
const req = (b) =>
  new Request('https://private.example/stage', { method: 'POST', body: JSON.stringify(b) });
test('private staging requires fresh signed storage reservation and exact manifest proof', async () => {
  let writes = 0;
  const worker = stagingWorker(job),
    env = { TARGET: { get: async () => null, put: async () => writes++ } };
  const expired = stageBody();
  expired.lease.observedAt -= 60_000;
  assert.equal((await worker.fetch(req(expired), env)).status, 409);
  const invalid = stageBody();
  invalid.signature = '0'.repeat(64);
  assert.equal((await worker.fetch(req(invalid), env)).status, 403);
  const other = stageBody();
  other.records[0] = { record: { ...record, key: 'unrelated/private' }, proof: [] };
  assert.equal((await worker.fetch(req(other), env)).status, 403);
  assert.equal(writes, 0);
});
test('private staging reads back actual stored bytes and never accepts conflicting content', async () => {
  let bytes,
    puts = 0;
  const env = {
    TARGET: {
      get: async () =>
        bytes
          ? {
              size: bytes.length,
              httpMetadata: { contentType: record.mime },
              etag: 'etag',
              arrayBuffer: async () => bytes,
            }
          : null,
      put: async (key, value, options) => {
        assert.equal(key, record.key);
        assert.equal(options.onlyIf.etagDoesNotMatch, '*');
        bytes = Buffer.from(value);
        puts++;
      },
    },
  };
  const worker = stagingWorker(job);
  const response = await worker.fetch(req(stageBody()), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).verified[0].sha256, record.sha256);
  await worker.fetch(req(stageBody()), env);
  assert.equal(puts, 1);
  bytes = Buffer.from('bad');
  await assert.rejects(worker.fetch(req(stageBody()), env), /Remote checksum mismatch/);
});
test('bad local bytes cannot become an R2 object', async () => {
  let writes = 0;
  const env = { TARGET: { get: async () => null, put: async () => writes++ } },
    b = stageBody();
  b.blobs[imagePath] = Buffer.from('bad').toString('base64');
  await assert.rejects(stagingWorker(job).fetch(req(b), env), /Source checksum mismatch/);
  assert.equal(writes, 0);
});
test('private inventory enumerates bounded pages without exposing any write operation', async () => {
  const inventoryJob = {
    ...job,
    inventoryBuckets: [
      { bucket: 'ultraclipart-pages', jurisdiction: 'default', binding: 'TARGET' },
    ],
  };
  let pages = 0;
  const env = {
    TARGET: {
      list: async ({ cursor, limit }) => {
        assert.equal(limit, 1000);
        pages++;
        return cursor
          ? { objects: [{ key: 'z', size: 7 }], truncated: false }
          : { objects: [{ key: 'a', size: 5 }], truncated: true, cursor: 'next' };
      },
      put: async () => {
        throw Error('Inventory must not write');
      },
    },
  };
  const command = {
    action: 'list',
    bucket: 'ultraclipart-pages',
    jurisdiction: 'default',
    at: Date.now(),
  };
  const signed = (c) => ({
    command: c,
    signature: createHmac('sha256', Buffer.from(secret, 'hex'))
      .update(JSON.stringify(c))
      .digest('hex'),
  });
  const call = (c) =>
    stagingWorker(inventoryJob).fetch(
      new Request('https://private.example/inventory', {
        method: 'POST',
        body: JSON.stringify(signed(c)),
      }),
      env,
    );
  const response = await call(command),
    actual = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(actual.Contents, [{ Key: 'a', Size: 5 }]);
  assert.equal(actual.IsTruncated, true);
  assert.equal(pages, 1);
  assert.equal((await call({ ...command, bucket: 'outside' })).status, 404);
  assert.equal((await call({ ...command, at: Date.now() - 60_000 })).status, 409);
});
test('gzip is only a bounded transport; stored bytes and their independent SHA stay exact', async () => {
  const { gzipSync } = await import('node:zlib');
  const body = stageBody();
  let stored;
  const worker = stagingWorker(job);
  const response = await worker.fetch(
    new Request('https://private.example/stage', {
      method: 'POST',
      headers: { 'X-UC-Body-Encoding': 'gzip' },
      body: gzipSync(Buffer.from(JSON.stringify(body))),
    }),
    {
      TARGET: {
        get: async () =>
          stored
            ? {
                size: stored.length,
                httpMetadata: { contentType: record.mime },
                etag: 'actual',
                arrayBuffer: async () => stored,
              }
            : null,
        put: async (key, bytes, options) => {
          assert.equal(options.httpMetadata.contentType, record.mime);
          stored = Buffer.from(bytes);
        },
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(stored.toString(), 'abc');
  assert.equal((await response.json()).verified[0].sha256, record.sha256);
});
