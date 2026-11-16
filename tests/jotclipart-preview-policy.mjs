import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { get } from 'node:http';
import { gzipSync, gunzipSync } from 'node:zlib';
import { build } from 'esbuild';
import {
  isJotclipartPreview,
  previewResponsePolicy,
  withPreviewResponsePolicy,
} from '../server/jotclipart/preview-policy.mjs';

const request = (host, path = '/', init) => new Request('https://' + host + path, init);
const preview = request('preview.jotclipart.com');
test('only the exact custom preview, Pages origin and one valid alias label are excluded', () => {
  for (const host of [
    'preview.jotclipart.com',
    'jotclipart.pages.dev',
    'migration-preview.jotclipart.pages.dev',
    '123456ab.jotclipart.pages.dev',
    'a.jotclipart.pages.dev',
  ])
    assert.equal(isJotclipartPreview(request(host)), true, host);
  for (const host of [
    'jotclipart.com',
    'www.jotclipart.com',
    'assets.jotclipart.com',
    'notpreview.jotclipart.com',
    'preview.jotclipart.com.evil.invalid',
    'jotclipart.pages.dev.evil.invalid',
    'notjotclipart.pages.dev',
    'nested.alias.jotclipart.pages.dev',
    'ultraclipart.pages.dev',
    'alias.ultraclipart.pages.dev',
  ])
    assert.equal(isJotclipartPreview(request(host)), false, host);
});
test('production returns the identical response, keeping each existing indexing and body policy', async () => {
  for (const host of ['jotclipart.com', 'www.jotclipart.com'])
    for (const value of [null, 'index, follow', 'noindex']) {
      const headers = new Headers({ 'content-type': 'text/html', etag: '"same"' });
      if (value) headers.set('x-robots-tag', value);
      const source = new Response('<p>same production body</p>', { headers });
      assert.equal(previewResponsePolicy(request(host), source), source);
      assert.equal(source.headers.get('x-robots-tag'), value);
      assert.equal(await source.text(), '<p>same production body</p>');
    }
});
test('preview headers cover success errors redirects ranges HEAD and empty responses without rewriting bytes', async () => {
  for (const [method, status, body] of [
    ['GET', 200, '<p>unchanged</p>'],
    ['POST', 201, '{"saved":true}'],
    ['OPTIONS', 204, null],
    ['GET', 206, 'range'],
    ['GET', 301, 'redirect'],
    ['GET', 304, null],
    ['GET', 404, 'missing'],
    ['GET', 503, 'unavailable'],
    ['HEAD', 200, null],
  ]) {
    const headers = new Headers({
      'content-type': 'application/octet-stream',
      'cache-control': 'private, no-store',
      etag: '"unchanged"',
      vary: 'Origin, Accept-Encoding',
      'content-length': String(body?.length ?? 0),
      'content-range': 'bytes 0-4/20',
      'set-cookie': 'private=1; Secure; HttpOnly',
      location: '/unchanged/',
      'x-uc-snapshot': 'a'.repeat(64),
    });
    const source = new Response(body, { status, statusText: 'Retained status', headers }),
      output = previewResponsePolicy(request('preview.jotclipart.com', '/', { method }), source);
    assert.equal(output.status, status);
    assert.equal(output.statusText, source.statusText);
    assert.equal(output.headers.get('x-robots-tag'), 'noindex, nofollow');
    for (const [name, value] of headers) assert.equal(output.headers.get(name), value, name);
    assert.equal(source.headers.get('x-robots-tag'), null, 'Source headers must not be mutated');
    assert.equal(await output.text(), body ?? '');
  }
});
test('stricter robots directives and immutable upstream headers are retained, with idempotent wrapping', async () => {
  const source = new Response('unchanged', { headers: { 'x-robots-tag': 'noarchive, noindex' } }),
    output = previewResponsePolicy(preview, source);
  assert.equal(output.headers.get('x-robots-tag'), 'noarchive, noindex, nofollow');
  assert.equal(previewResponsePolicy(preview, output), output);
  const upstream = await fetch('data:text/plain,exact-upstream-bytes');
  assert.equal(await previewResponsePolicy(preview, upstream).text(), 'exact-upstream-bytes');
});
test('the outer wrapper covers early AI/share catalog and fallback returns while preserving dispatch and failures', async () => {
  const env = {},
    ctx = {},
    handler = withPreviewResponsePolicy(async (req, seenEnv, seenCtx) => {
      assert.equal(seenEnv, env);
      assert.equal(seenCtx, ctx);
      const path = new URL(req.url).pathname;
      if (path.startsWith('/api/ai/')) return Response.json({ kind: 'ai' }, { status: 403 });
      if (path.startsWith('/api/share') || path.startsWith('/share/'))
        return new Response('share', { status: 404 });
      if (path.startsWith('/art/')) return new Response('catalog');
      return new Response('fallback');
    });
  for (const path of ['/api/ai/generate', '/api/share', '/share/id', '/art/id/', '/other']) {
    const result = await handler(request('preview.jotclipart.com', path), env, ctx);
    assert.equal(result.headers.get('x-robots-tag'), 'noindex, nofollow', path);
  }
  const failure = new Error('Original failure');
  await assert.rejects(
    () => withPreviewResponsePolicy(() => Promise.reject(failure))(preview, env, ctx),
    (error) => error === failure,
  );
});
test('the compiled entry binds the exact helper into its ABI and wraps outside every dispatch branch', () => {
  const source = readFileSync('scripts/catalog-snapshot/build-runtime.mjs', 'utf8');
  assert.match(source, /'server\/jotclipart\/preview-policy\.mjs'/);
  assert.match(source, /import\{withPreviewResponsePolicy\}from/);
  assert.match(
    source,
    /export default\{fetch:withPreviewResponsePolicy\(async function\(request,env,ctx\)/,
  );
  assert.match(source, /staticNavigationPolicy,withPreviewResponsePolicy\};/);
});
test('actual workerd preserves manual and automatic gzip exactly once, plus HEAD and 304 contracts', async () => {
  const text = 'Exact compressed preview representation. '.repeat(200),
    compressed = gzipSync(text);
  const bundled = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `import{withPreviewResponsePolicy}from'./server/jotclipart/preview-policy.mjs';const text=${JSON.stringify(text)},compressed=Uint8Array.from(atob(${JSON.stringify(compressed.toString('base64'))}),c=>c.charCodeAt(0));function dispatch(request){const path=new URL(request.url).pathname,status=path==='/304'?304:200,manual=path!=='/auto',body=status===304||request.method==='HEAD'?null:manual?compressed:text;return new Response(body,{status,headers:{'content-encoding':'gzip','content-type':'text/html','cache-control':'private, no-store',etag:'"retained"',vary:'Accept-Encoding'},...(manual?{encodeBody:'manual'}:{})})}export default{fetch(request,env,ctx){const url=new URL(request.url);return url.searchParams.has('wrap')?withPreviewResponsePolicy(dispatch)(new Request('https://preview.jotclipart.com'+url.pathname,request),env,ctx):dispatch(request)}};`,
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
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
          name: 'preview-policy-fixture',
          script: bundled.outputFiles[0].text,
          modules: true,
          compatibilityDate: '2026-10-23',
        },
      ],
      host: '127.0.0.1',
      port: 0,
    }),
  );
  try {
    const base = await mf.ready;
    const raw = (path, method) =>
      new Promise((accept, reject) => {
        // node:http deliberately does not decompress: compare actual wire bytes.
        get(new URL(path, base), { method }, (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('error', reject);
          response.on('end', () =>
            accept({
              body: Buffer.concat(chunks),
              status: response.statusCode,
              headers: response.headers,
            }),
          );
        }).on('error', reject);
      });
    for (const [path, method] of [
      ['/manual', 'GET'],
      ['/auto', 'GET'],
      ['/manual', 'HEAD'],
      ['/304', 'GET'],
    ]) {
      const baseline = await raw(path, method),
        output = await raw(path + '?wrap', method);
      assert.equal(output.status, baseline.status);
      assert.deepEqual(output.body, baseline.body, 'Encoded wire bytes must be unchanged');
      assert.equal(output.headers['x-robots-tag'], 'noindex, nofollow');
      assert.equal(baseline.headers['x-robots-tag'], undefined);
      for (const name of [
        'content-type',
        'content-encoding',
        'cache-control',
        'etag',
        'vary',
        'content-length',
      ])
        assert.equal(output.headers[name], baseline.headers[name], name);
      if (method === 'GET' && output.status === 200) {
        assert.equal(
          gunzipSync(output.body).toString(),
          text,
          'Exactly one gzip decoding must succeed',
        );
        if (path === '/manual') assert.deepEqual(output.body, compressed);
      } else assert.equal(output.body.length, 0);
    }
  } finally {
    await mf.dispose();
  }
});
