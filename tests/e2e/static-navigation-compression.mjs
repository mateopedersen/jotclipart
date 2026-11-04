import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { siteNavigationScript } from '../../src/lib/site-navigation-inline.mjs';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.resolve('wrangler')),
  { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const source = '<!doctype html><h1>Single encoded representation</h1>' + '.'.repeat(60000),
  token = "'sha256-" + createHash('sha256').update(siteNavigationScript).digest('base64') + "'";
const code = await build({
  stdin: {
    resolveDir: process.cwd(),
    contents: `import{staticNavigationPolicy}from'./server/catalog-snapshot/static-navigation-policy.mjs';export default{async fetch(){const bytes=new TextEncoder().encode(${JSON.stringify(source)});const body=new Response(bytes).body.pipeThrough(new CompressionStream('gzip'));return staticNavigationPolicy(new Response(body,{headers:{'content-type':'text/html','content-encoding':'gzip','content-security-policy':\"default-src 'self'; script-src 'self'\"},encodeBody:'manual'}),${JSON.stringify(token)})}};`,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
});
const mf = new Miniflare(
  convertV4MiniflareOptions({
    cf: false,
    workers: [
      {
        name: 'navigation-gzip-private-regression',
        modules: true,
        script: code.outputFiles[0].text,
        compatibilityDate: '2026-10-23',
      },
    ],
  }),
);
try {
  const r = await mf.dispatchFetch('https://fixture.invalid/');
  assert.equal(r.status, 200);
  const bytes = new Uint8Array(await r.arrayBuffer()); // dispatchFetch supplies the browser-decoded body. An extra gunzip here
  // would hide the exact double-encoding regression this test must catch.
  const decoded = new TextDecoder().decode(bytes);
  assert.equal(decoded, source);
  assert(r.headers.get('content-security-policy').includes(token));
  console.log(
    JSON.stringify({
      status: 'NATIVE_WORKERS_SINGLE_GZIP_REPRESENTATION_PASSED',
      browserDecodedBytes: bytes.length,
      sourceBytes: source.length,
      productionWrites: 0,
    }),
  );
} finally {
  await mf.dispose();
}
