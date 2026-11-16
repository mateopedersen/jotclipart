// Runs the exact built private renderer in workerd, then exercises its parent
// protocol, cache, HEAD and conditional GET. Read-only public thumbnail requests.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createLocalPreview } from './serve-local.mjs';
import {
  createCatalogOgService,
  fetchOgRenderService,
} from '../../server/jotclipart/og-runtime.mjs';
const require = createRequire(import.meta.resolve('wrangler/package.json'));
const { Miniflare } = require('miniflare');
const directory = resolve(process.argv[2] ?? 'work/og-integration/og-worker');
const proof = resolve(process.argv[3] ?? '../og-research');
const report = JSON.parse(await readFile(join(directory, 'og-worker-report.json')));
const source = JSON.parse(await readFile(join(proof, 'verified-sample.json')));
const files = Object.fromEntries(
  await Promise.all(
    ['worker.mjs', 'resvg.wasm', 'webp.wasm'].map(async (name) => [
      name,
      await readFile(join(directory, name)),
    ]),
  ),
);
const mf = new Miniflare({
  workers: [
    {
      config: {
        name: report.name,
        compatibilityDate: '2026-10-23',
        compatibilityFlags: [],
        manifest: {
          mainModule: 'worker.mjs',
          modulesRoot: '/',
          modules: {
            'worker.mjs': { type: 'esm', contents: files['worker.mjs'] },
            'resvg.wasm': { type: 'wasm', contents: files['resvg.wasm'] },
            'webp.wasm': { type: 'wasm', contents: files['webp.wasm'] },
          },
        },
      },
      dev: { rootPath: process.cwd() },
    },
  ],
  host: '127.0.0.1',
  port: 0,
  telemetry: { enabled: false },
});
try {
  let serviceCalls = 0;
  const binding = {
    fetch: async (url, init) => {
      assert.equal(url, 'https://jotclipart-og.internal/render');
      serviceCalls++;
      return mf.dispatchFetch(url, init);
    },
  };
  const service = createCatalogOgService({
    identity: report.identity,
    render: (s) => fetchOgRenderService(binding, s, report.identity),
  });
  const descriptor = await service.descriptor(source);
  const values = new Map();
  const cache = {
    match: async (r) => values.get(r.url)?.clone(),
    put: async (r, response) => values.set(r.url, response.clone()),
  };
  const first = await service.image(new Request(descriptor.url), source, { cache });
  assert.equal(first.status, 200);
  const bytes = Buffer.from(await first.arrayBuffer());
  const image = await sharp(bytes).metadata();
  assert.equal(image.width, 1200);
  assert.equal(image.height, 630);
  assert.equal(image.format, 'png');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(first.headers.get('etag'), '"' + sha256 + '"');
  assert.equal(first.headers.get('x-jotclipart-og'), descriptor.digest);
  const head = await service.image(new Request(descriptor.url, { method: 'HEAD' }), source, {
    cache,
  });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(head.headers.get('content-length'), String(bytes.length));
  const conditional = await service.image(
    new Request(descriptor.url, { headers: { 'if-none-match': first.headers.get('etag') } }),
    source,
    { cache },
  );
  assert.equal(conditional.status, 304);
  assert.equal((await conditional.arrayBuffer()).byteLength, 0);
  assert.equal(serviceCalls, 1);
  const stage = await service.image(
    new Request(descriptor.url.replace('jotclipart.com', 'preview.jotclipart.com')),
    source,
    { cache },
  );
  assert.equal(stage.status, 200);
  assert.equal(serviceCalls, 2);
  assert.deepEqual(Buffer.from(await stage.arrayBuffer()), bytes);
  assert.equal((await mf.dispatchFetch('https://private.invalid/render')).status, 404);
  assert.equal(
    (
      await mf.dispatchFetch('https://private.invalid/render', {
        method: 'POST',
        body: 'x'.repeat(16385),
      })
    ).status,
    413,
  );
  const catalogChecks = [];
  if (process.argv[4] === '--catalog') {
    const preview = await createLocalPreview({
      ogBinding: binding,
      metadata: process.env.JOTCLIPART_TEST_METADATA,
    });
    const paths = [
      '/art/versace-purple-barocco-jumpsuit/',
      '/edit/versace-violet-medusa-belted-jumpsuit-clipart-080/',
      '/clipart/baby-elephant/',
      '/collection/spiders-scorpions/',
      '/collection/animals-nature/',
    ];
    for (const path of paths) {
      const page = await preview.handle(path);
      assert.equal(page.status, 200, path);
      const html = await page.text();
      const url = /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1];
      assert(url?.startsWith('https://jotclipart.com/og/catalog/'), path);
      assert(html.includes(`<meta property="og:image:secure_url" content="${url}">`));
      const response = await preview.handle(url);
      assert.equal(response.status, 200, 'Compiled catalog OG ' + path);
      const png = Buffer.from(await response.arrayBuffer());
      const metadata = await sharp(png).metadata();
      assert.equal(metadata.width, 1200);
      assert.equal(metadata.height, 630);
      assert.equal(response.headers.get('content-type'), 'image/png');
      assert.equal(response.headers.get('x-jotclipart-og'), url.split('/').at(-1).slice(0, -4));
      assert.equal(
        response.headers.get('x-uc-snapshot'),
        '7c311351a6c725394ca7473cbcc1025868a281d17449cc817776452f0f3f6753',
      );
      catalogChecks.push({
        path,
        ogURL: url,
        bytes: png.length,
        sha256: createHash('sha256').update(png).digest('hex'),
      });
      await writeFile(join(directory, `catalog-${catalogChecks.length}.png`), png);
    }
    await preview.settled();
    assert.equal(preview.metrics.missing.size, 0);
  }
  const result = {
    status: 'EXACT_BUILT_PRIVATE_WORKER_NATIVE_PROTOCOL_PASSED',
    at: new Date().toISOString(),
    renderer: report.name,
    identity: report.identity,
    pngSHA256: sha256,
    pngBytes: bytes.length,
    width: 1200,
    height: 630,
    serviceCalls,
    catalogChecks,
    cacheEntries: values.size,
    checks: [
      'real-public-sha-bound-WebP',
      'exact-built-static-Wasm',
      'parent-full-byte-protocol',
      'HEAD',
      '304',
      'origin-cache-isolation',
      'private-method-guard',
      'bounded-request',
    ],
    cloudWrites: 0,
    publicWorkerRoutes: [],
  };
  await writeFile(join(directory, 'native-binding-proof.png'), bytes);
  await writeFile(
    join(directory, 'native-binding-proof.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(JSON.stringify(result));
} finally {
  await mf.dispose();
}
