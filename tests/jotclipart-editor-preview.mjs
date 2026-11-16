// Private deterministic fixtures, not a production media inventory or signature proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createRequire } from 'node:module';
import { get } from 'node:http';
import { build } from 'esbuild';
import actualManifest from '../config/jotclipart-editor-previews.json' with { type: 'json' };
import { canonical, digest } from '../server/catalog-search/store.mjs';
import { buildHashedRecordDirectory } from '../server/catalog-snapshot/hashed-record-directory-build.mjs';
import {
  createLegacyEditorPreviewService,
  isLegacyEditorPreviewPath,
} from '../server/jotclipart/editor-preview.mjs';
const encode = (value) => new TextEncoder().encode(JSON.stringify(canonical(value)));
let sequence = 0;
const image = new Uint8Array(
  await sharp({ create: { width: 4, height: 3, channels: 4, background: '#52b788' } })
    .webp({ lossless: true })
    .toBuffer(),
);
async function contextFor(rows, changes = {}, decisions = {}) {
  const revision = 'a'.repeat(40),
    objects = new Map(),
    directories = {},
    groups = new Map();
  const put = async (value) => {
    const bytes = encode(value),
      sha256 = await digest(bytes),
      descriptor = {
        key: 'catalog/objects/artworks/' + sha256 + '.json',
        sha256,
        bytes: bytes.length,
      };
    objects.set(descriptor.key, bytes);
    return descriptor;
  };
  const active = rows.flatMap((row) =>
    changes[row.id] === null
      ? []
      : [
          {
            id: row.id,
            topic: 'fixture-topic',
            published: true,
            indexable: true,
            sourceType: 'raster',
            files: { webp: { sha256: row.sourceSHA256 } },
            ...changes[row.id],
          },
        ],
  );
  for (const record of active) {
    const part = (await digest(record.id)).slice(0, 3);
    if (!groups.has(part)) groups.set(part, []);
    groups.get(part).push(record);
  }
  for (const [part, records] of groups) {
    const prefix = part.slice(0, 2);
    directories[prefix] ??= { type: 'artwork-directory', prefix, shards: {} };
    directories[prefix].shards[part] = await put({ schema: 1, shard: part, records });
  }
  for (const prefix of Object.keys(directories))
    directories[prefix] = await put(directories[prefix]);
  const decisionTree = buildHashedRecordDirectory(
    'artworks',
    rows.map((row) => ({
      name: row.id,
      value: {
        schema: 1,
        type: 'editor-source',
        id: row.id,
        sourceSHA256: row.sourceSHA256,
        preview: row.path,
        width: row.width,
        height: row.height,
        ...decisions[row.id],
      },
    })),
  );
  for (const [key, bytes] of decisionTree.created) objects.set(key, bytes);
  const root = await put({
    type: 'artwork-root',
    revision,
    directories,
    editorPreviews: decisionTree.root,
  });
  const read = async (facet, descriptor) => {
    assert.equal(facet, 'artworks');
    const bytes = objects.get(descriptor.key);
    assert.equal(bytes.length, descriptor.bytes);
    assert.equal(await digest(bytes), descriptor.sha256);
    return JSON.parse(new TextDecoder().decode(bytes));
  };
  return {
    snapshot: { revision, fixture: true },
    rootSHA256: 'f'.repeat(64),
    getFacet: () => read('artworks', root),
    read,
    fixtureRoot: root,
    fixtureObjects: Object.fromEntries(
      [...objects].map(([key, bytes]) => [key, Buffer.from(bytes).toString('base64')]),
    ),
  };
}
async function fixture({ prefixes = ['aa'], rowPatch, shardPatch, body = image } = {}) {
  const n = ++sequence,
    rows = [],
    shards = {},
    bodies = new Map(),
    sourceSHA = await digest('fixture-source-' + n);
  for (const prefix of prefixes)
    rows.push({
      id: 'fixture-art-' + n + '-' + prefix,
      sourceSHA256: sourceSHA,
      path:
        '/previews/p1/' +
        prefix +
        (await digest('path-' + n + '-' + prefix)).slice(0, 22) +
        '-960.webp',
      sha256: await digest(body),
      bytes: body.length,
      width: 4,
      height: 3,
      ...rowPatch,
    });
  for (let i = 0; i < 256; i++) {
    const prefix = i.toString(16).padStart(2, '0'),
      selected = rows.filter((row) => row.path.slice(13, 15) === prefix);
    let value = { schema: 1, files: selected };
    if (shardPatch && prefixes.includes(prefix)) value = shardPatch(value);
    const bytes = encode(value);
    bodies.set(prefix, bytes);
    shards[prefix] = { sha256: await digest(bytes), bytes: bytes.length, records: selected.length };
  }
  const manifest = {
    schema: 1,
    source: {
      file: 'data/jotclipart-editor-previews.jsonl.gz',
      sha256: await digest('manifest-source-' + n),
      bytes: 100,
      catalogRoot: 'b'.repeat(64),
      manifestRoot: 'c'.repeat(64),
      manifestSHA256: 'd'.repeat(64),
      manifestBytes: 1000,
    },
    records: rows.length,
    totalPreviewBytes: body.length * rows.length,
    maxPreviewBytes: Math.max(body.length, 1),
    shards,
  };
  manifest.rootSHA256 = await digest(
    JSON.stringify(canonical({ schema: 1, sourceSHA256: manifest.source.sha256, shards })),
  );
  const assetsReads = [],
    bucketReads = [],
    cacheReads = [],
    cacheBodies = new Map();
  const f = {
    rows,
    manifest,
    body,
    bodies,
    assetsReads,
    bucketReads,
    cacheReads,
    cacheBodies,
    objectType: 'image/webp',
    objectSize: body.length,
    objectBody: body,
    assets: {
      async fetch(req) {
        assetsReads.push(req);
        const p = new URL(req.url).pathname.split('/').at(-1).slice(0, 2);
        return new Response(bodies.get(p), { headers: { 'content-type': 'application/json' } });
      },
    },
    bucket: {
      async get(key) {
        bucketReads.push(key);
        if (f.missingBody) return null;
        return {
          size: f.objectSize,
          httpMetadata: { contentType: f.objectType },
          body: new Blob([f.objectBody]).stream(),
        };
      },
    },
    cache: {
      async match(key) {
        cacheReads.push(key.url);
        return cacheBodies.get(key.url)?.clone();
      },
      async put(key, response) {
        cacheBodies.set(key.url, response.clone());
      },
    },
    context: (changes, decisions) => contextFor(rows, changes, decisions),
    request: (headers, init = {}, row = rows[0], origin = 'https://jotclipart.com') =>
      new Request(origin + row.path, { headers, ...init }),
  };
  f.create = (extra = {}) =>
    createLegacyEditorPreviewService({
      assets: f.assets,
      bucket: f.bucket,
      manifest,
      expectedRootSHA256: manifest.rootSHA256,
      allowFixture: true,
      ...extra,
    });
  f.service = f.create();
  return f;
}
test('only exact legacy 960 paths and GET/HEAD are served, and fixture/root/authorization opt-ins fail closed', async () => {
  const f = await fixture(),
    context = await f.context();
  assert(isLegacyEditorPreviewPath(f.rows[0].path));
  for (const path of [
    '/anything.webp',
    '/previews/p1/' + 'a'.repeat(24) + '-440.webp',
    '/previews/p1/' + 'A'.repeat(24) + '-960.webp',
  ]) {
    assert(!isLegacyEditorPreviewPath(path));
    assert.equal(
      (await f.service.response(new Request('https://jotclipart.com' + path), context)).status,
      404,
    );
  }
  assert.equal(
    (await f.service.response(new Request(f.request().url + '?proxy=1'), context)).status,
    404,
  );
  assert.equal((await f.service.response(f.request({}, { method: 'POST' }), context)).status, 405);
  assert.equal(f.assetsReads.length + f.bucketReads.length, 0);
  assert.throws(() => f.create({ allowFixture: false }), /FIXTURE_MANIFEST_FORBIDDEN/);
  assert.throws(() => f.create({ expectedRootSHA256: '0'.repeat(64) }), /EXPECTED_ROOT/);
  await assert.rejects(
    f.service.response(f.request(), { ...context, snapshot: { revision: 'a'.repeat(40) } }),
    /AUTHORIZATION/,
  );
  const production = createLegacyEditorPreviewService({
    assets: f.assets,
    bucket: f.bucket,
    expectedRootSHA256: actualManifest.rootSHA256,
  });
  await assert.rejects(production.response(f.request(), context), /AUTHORIZATION/);
});
test('the real configured source and all 256 descriptor pins validate before any metadata or binary request', async () => {
  const reached = new Error('Validated manifest before the first static read');
  let reads = 0;
  const service = createLegacyEditorPreviewService({
    expectedRootSHA256: actualManifest.rootSHA256,
    assets: {
      fetch() {
        reads++;
        throw reached;
      },
    },
    bucket: {
      get() {
        throw Error('Binary access forbidden in this test');
      },
    },
  });
  // This supplies only the parent-verifier contract marker, not a signature proof.
  await assert.rejects(
    service.response(
      new Request('https://jotclipart.com/previews/p1/' + '00'.repeat(12) + '-960.webp'),
      {
        authorizationVerified: true,
        authorizationKind: 'SIGNED_SOURCE_MEDIA_GRAPH_SNAPSHOT',
      },
    ),
    (error) => error === reached,
  );
  assert.equal(reads, 1);
});
test('the verified static shard and active signed facts bind exact image bytes and never forward user headers', async () => {
  const f = await fixture(),
    context = await f.context(),
    response = await f.service.response(
      f.request({ Cookie: 'private=1', Authorization: 'secret', Range: 'bytes=0-3' }),
      context,
    );
  assert.equal(response.status, 206);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), image.subarray(0, 4));
  assert.equal(f.assetsReads.length, 1);
  assert.equal(f.assetsReads[0].method, 'GET');
  assert.equal(f.assetsReads[0].redirect, 'manual');
  assert.equal(
    f.assetsReads[0].url,
    `https://jotclipart.com/__editor-preview-index/${f.manifest.rootSHA256}/aa.json`,
  );
  assert.deepEqual([...f.assetsReads[0].headers], [['accept', 'application/json']]);
  assert.deepEqual(f.bucketReads, ['delivery' + f.rows[0].path]);
  assert.equal(response.headers.get('content-type'), 'image/webp');
  assert.equal(response.headers.get('etag'), '"' + f.rows[0].sha256 + '"');
  assert.match(response.headers.get('cache-control'), /immutable, no-transform/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex');
});
test('GET HEAD 304 single ranges If-Range and 416 preserve the exact immutable representation', async () => {
  const f = await fixture(),
    context = await f.context(),
    options = { cache: f.cache },
    etag = '"' + f.rows[0].sha256 + '"';
  const full = await f.service.response(f.request(), context, options);
  assert.deepEqual(new Uint8Array(await full.arrayBuffer()), image);
  const head = await f.service.response(f.request({}, { method: 'HEAD' }), context, options);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(image.length));
  assert.equal(await head.text(), '');
  for (const tag of [etag, 'W/' + etag, '*', '"other", ' + etag]) {
    const output = await f.service.response(f.request({ 'If-None-Match': tag }), context, options);
    assert.equal(output.status, 304);
    assert.equal(await output.text(), '');
  }
  for (const [range, start, end] of [
    ['bytes=0-3', 0, 3],
    ['bytes=3-', 3, image.length - 1],
    ['bytes=-4', image.length - 4, image.length - 1],
    ['bytes=0-999999', 0, image.length - 1],
  ]) {
    const output = await f.service.response(
      f.request({ Range: range, 'If-Range': etag }),
      context,
      options,
    );
    assert.equal(output.status, 206);
    assert.equal(output.headers.get('content-range'), `bytes ${start}-${end}/${image.length}`);
    assert.deepEqual(new Uint8Array(await output.arrayBuffer()), image.subarray(start, end + 1));
  }
  for (const range of [
    'bytes=999999-',
    'bytes=-0',
    'bytes=5-2',
    'bytes=0-1,3-4',
    'bytes=999999999999999999999-',
  ])
    assert.equal(
      (await f.service.response(f.request({ Range: range }), context, options)).status,
      416,
    );
  const changed = await f.service.response(
    f.request({ Range: 'bytes=0-3', 'If-Range': 'W/' + etag }),
    context,
    options,
  );
  assert.equal(changed.status, 200);
  assert.deepEqual(new Uint8Array(await changed.arrayBuffer()), image);
  assert.equal(
    f.bucketReads.length,
    1,
    'Only the verified full body is cached, never a partial range',
  );
});
test('withdrawal source replacement and changed signed preview decisions reject warmed image caches', async () => {
  const f = await fixture(),
    row = f.rows[0];
  await f.service.response(f.request(), await f.context(), { cache: f.cache });
  const before = f.cacheReads.length;
  for (const changes of [
    { published: false },
    { indexable: false },
    { files: { webp: { sha256: 'f'.repeat(64) } } },
    null,
  ])
    assert.equal(
      (
        await f.service.response(f.request(), await f.context({ [row.id]: changes }), {
          cache: f.cache,
        })
      ).status,
      404,
    );
  for (const change of [
    { sourceSHA256: 'f'.repeat(64) },
    { preview: row.path.replace('-960', '-440') },
    { width: 5 },
    { type: 'other' },
  ])
    assert.equal(
      (
        await f.service.response(f.request(), await f.context({}, { [row.id]: change }), {
          cache: f.cache,
        })
      ).status,
      404,
    );
  assert.equal(f.cacheReads.length, before, 'Active source checks must precede every cache lookup');
  assert.equal(f.bucketReads.length, 1);
});
test('cache keys isolate origins and manifest roots and cached bodies are fully reverified', async () => {
  const f = await fixture(),
    context = await f.context();
  await f.service.response(f.request(), context, { cache: f.cache });
  const key = [...f.cacheBodies.keys()][0];
  assert.match(key, new RegExp('/' + f.manifest.rootSHA256 + '/' + f.rows[0].sha256 + '$'));
  await f.service.response(
    f.request({}, {}, f.rows[0], 'https://preview.jotclipart.com'),
    context,
    { cache: f.cache },
  );
  assert.equal(f.bucketReads.length, 2);
  assert.equal(f.cacheBodies.size, 2);
  const corrupt = image.slice();
  corrupt[corrupt.length - 1] ^= 1;
  f.cacheBodies.set(
    key,
    new Response(corrupt, {
      headers: { 'content-type': 'image/webp', etag: '"' + f.rows[0].sha256 + '"' },
    }),
  );
  await assert.rejects(f.service.response(f.request(), context, { cache: f.cache }), /BODY_SHA/);
});
test('wrong shard bytes fields ordering duplicates counts prefixes and size descriptors fail without bucket reads', async () => {
  const corrupt = await fixture();
  corrupt.bodies.set('aa', new Uint8Array(corrupt.bodies.get('aa').length));
  await assert.rejects(
    corrupt.service.response(corrupt.request(), await corrupt.context()),
    /SHARD_SHA/,
  );
  for (const patch of [
    (value) => ({ ...value, surprise: true }),
    (value) => ({ ...value, files: [{ ...value.files[0], unknown: 1 }] }),
    (value) => ({ ...value, files: [{ ...value.files[0], id: 123 }] }),
    (value) => ({ ...value, files: [value.files[0], value.files[0]] }),
    (value) => ({
      ...value,
      files: [{ ...value.files[0], path: value.files[0].path.replace('/aa', '/bb') }],
    }),
    (value) => ({ ...value, files: [{ ...value.files[0], bytes: 2 ** 30 }] }),
  ]) {
    const f = await fixture({ shardPatch: patch });
    await assert.rejects(f.service.response(f.request(), await f.context()), /SHARD_/);
    assert.equal(f.bucketReads.length, 0);
  }
});
test('manifest roots counts caps and duplicate or unordered rows cannot be rehashed into an accepted request', async () => {
  for (const change of [
    (m) => m.records++,
    (m) => (m.maxPreviewBytes = 1024 * 1024 + 1),
    (m) => (m.shards.aa.bytes = 128 * 1024 + 1),
    (m) => (m.source.catalogRoot = 'wrong'),
    (m) => (m.rootSHA256 = '0'.repeat(64)),
  ]) {
    const f = await fixture();
    change(f.manifest);
    f.service = f.create();
    await assert.rejects(
      f.service.response(f.request(), await f.context()),
      /MANIFEST|SHARD_DESCRIPTOR/,
    );
    assert.equal(f.assetsReads.length + f.bucketReads.length, 0);
  }
  for (const rows of [
    (row) => [row, { ...row, id: row.id + '-duplicate-path' }],
    (row) => [
      { ...row, id: row.id + '-later', path: '/previews/p1/aa' + 'f'.repeat(22) + '-960.webp' },
      row,
    ],
    (row) => [row, { ...row, path: '/previews/p1/aa' + 'f'.repeat(22) + '-960.webp' }],
  ]) {
    const f = await fixture(),
      bytes = encode({ schema: 1, files: rows(f.rows[0]) });
    f.bodies.set('aa', bytes);
    f.manifest.shards.aa = { bytes: bytes.length, records: 2, sha256: await digest(bytes) };
    f.manifest.records = 2;
    f.manifest.totalPreviewBytes *= 2;
    f.manifest.rootSHA256 = await digest(
      JSON.stringify(
        canonical({ schema: 1, sourceSHA256: f.manifest.source.sha256, shards: f.manifest.shards }),
      ),
    );
    f.service = f.create();
    await assert.rejects(f.service.response(f.request(), await f.context()), /SHARD_ROW/);
    assert.equal(f.bucketReads.length, 0);
  }
});
test('known missing malformed MIME length SHA magic and dimensions are genuine outages, not silent 404 fallbacks', async () => {
  for (const patch of [
    { missingBody: true },
    { objectType: 'text/html' },
    { objectSize: image.length + 1 },
    { objectBody: image.subarray(0, -1) },
    { objectBody: new Uint8Array(image.length) },
  ]) {
    const f = await fixture();
    Object.assign(f, patch);
    await assert.rejects(f.service.response(f.request(), await f.context()), /BODY_/);
  }
  const html = await fixture({ body: new TextEncoder().encode('<html>not a WebP image</html>') });
  await assert.rejects(html.service.response(html.request(), await html.context()), /WEBP_MAGIC/);
  const wrongDimensions = await fixture({ rowPatch: { width: 5 } });
  await assert.rejects(
    wrongDimensions.service.response(wrongDimensions.request(), await wrongDimensions.context()),
    /WEBP_DIMENSIONS/,
  );
});
test('the process-wide shard LRU evicts beyond 32 shards and unknown paths never read arbitrary R2 keys', async () => {
  const prefixes = Array.from({ length: 35 }, (_, n) => n.toString(16).padStart(2, '0')),
    f = await fixture({ prefixes }),
    context = await f.context();
  for (const row of f.rows)
    assert.equal((await f.service.response(f.request({}, {}, row), context)).status, 200);
  const count = f.assetsReads.length;
  await f.service.response(f.request(), context);
  assert.equal(f.assetsReads.length, count + 1, 'The oldest shard must have been evicted');
  const before = f.bucketReads.length;
  const output = await f.service.response(
    new Request('https://jotclipart.com/previews/p1/' + 'ee'.repeat(12) + '-960.webp'),
    context,
  );
  assert.equal(output.status, 404);
  assert.equal(f.bucketReads.length, before);
  assert(f.bucketReads.every((key) => f.rows.some((row) => key === 'delivery' + row.path)));
});
test('actual local workerd serves exact WebP bytes and correct HEAD Range 304 headers from the authenticated-read fixture', async () => {
  const f = await fixture(),
    context = await f.context(),
    shardData = Object.fromEntries(
      [...f.bodies].map(([key, bytes]) => [key, Buffer.from(bytes).toString('base64')]),
    );
  const built = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `import{createLegacyEditorPreviewService}from'./server/jotclipart/editor-preview.mjs';import{digest}from'./server/catalog-search/store.mjs';const decode=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0)),manifest=${JSON.stringify(f.manifest)},shards=${JSON.stringify(shardData)},objects=${JSON.stringify(context.fixtureObjects)},root=${JSON.stringify(context.fixtureRoot)},image=decode(${JSON.stringify(Buffer.from(image).toString('base64'))});async function read(f,d){const bytes=decode(objects[d.key]);if(bytes.length!==d.bytes||await digest(bytes)!==d.sha256)throw Error('fixture metadata SHA');return JSON.parse(new TextDecoder().decode(bytes))}const context={snapshot:${JSON.stringify(context.snapshot)},rootSHA256:${JSON.stringify(context.rootSHA256)},getFacet:()=>read('artworks',root),read};const service=createLegacyEditorPreviewService({manifest,expectedRootSHA256:manifest.rootSHA256,allowFixture:true,assets:{async fetch(req){const prefix=new URL(req.url).pathname.split('/').at(-1).slice(0,2);return new Response(decode(shards[prefix]),{headers:{'content-type':'application/json'}})}},bucket:{async get(key){if(key!==${JSON.stringify('delivery' + f.rows[0].path)})throw Error('unexpected key');return{size:image.length,httpMetadata:{contentType:'image/webp'},body:new Blob([image]).stream()}}}});export default{fetch(request){return service.response(request,context)}};`,
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  const require = createRequire(import.meta.resolve('wrangler')),
    { Miniflare, convertV4MiniflareOptions } = require('miniflare');
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      workers: [
        {
          name: 'editor-preview-fixture',
          script: built.outputFiles[0].text,
          modules: true,
          compatibilityDate: '2026-10-23',
        },
      ],
      host: '127.0.0.1',
      port: 0,
    }),
  );
  try {
    const base = await mf.ready,
      etag = '"' + f.rows[0].sha256 + '"';
    const raw = (method, headers = {}) =>
      new Promise((accept, reject) => {
        get(new URL(f.rows[0].path, base), { method, headers }, (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('error', reject);
          response.on('end', () =>
            accept({
              status: response.statusCode,
              headers: response.headers,
              body: Buffer.concat(chunks),
            }),
          );
        }).on('error', reject);
      });
    const full = await raw('GET');
    assert.equal(full.status, 200, full.body.toString());
    assert.deepEqual(full.body, Buffer.from(image));
    assert.equal(full.headers['content-type'], 'image/webp');
    assert.equal(full.headers.etag, etag);
    const head = await raw('HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(Number(head.headers['content-length']), image.length);
    const range = await raw('GET', { Range: 'bytes=0-3' });
    assert.equal(range.status, 206);
    assert.deepEqual(range.body, Buffer.from(image.subarray(0, 4)));
    assert.equal(range.headers['content-range'], 'bytes 0-3/' + image.length);
    const unchanged = await raw('GET', { 'If-None-Match': etag });
    assert.equal(unchanged.status, 304);
    assert.equal(unchanged.body.length, 0);
    assert.equal(unchanged.headers.etag, etag);
  } finally {
    await mf.dispose();
  }
});
