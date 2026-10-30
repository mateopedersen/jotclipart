// Actual workerd HTMLRewriter + local R2; no production account or network.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { refreshRelatedPreview } from '../../server/delivery/related-version.mjs';
const require = createRequire(import.meta.resolve('wrangler'));
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const old = 'a'.repeat(40),
  next = 'b'.repeat(40),
  version = 'uc-related-current-fixture';
const options = {
  revision: next,
  ids: ['old', 'new'],
  htmlRevisions: [[old, ['old']]],
  relatedVersion: version,
  pageHeaders: { 'Content-Security-Policy': "script-src 'self'" },
  editorHeaders: { 'Content-Security-Policy': "script-src 'self'", 'X-Robots-Tag': 'noindex' },
};
const code = await build({
  stdin: {
    resolveDir: new URL('../..', import.meta.url).pathname,
    contents: `import {createPublicFileHandler} from './server/delivery/public-files.mjs';
    const handle=createPublicFileHandler(${JSON.stringify(options)});
    export default {fetch(req,env,ctx){return handle(req,env,ctx,{fetch:()=>Response.json({version:${JSON.stringify(version)}})})}};`,
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  write: false,
});
const mf = new Miniflare(
  convertV4MiniflareOptions({
    cf: false,
    r2Persist: false,
    workers: [
      {
        name: 'public-fixture',
        modules: true,
        script: code.outputFiles[0].text,
        compatibilityDate: '2026-10-19',
        r2Buckets: ['CATALOG_PAGES'],
        outboundService: () => {
          throw Error('No external requests allowed');
        },
      },
    ],
  }),
);
try {
  const storage = await mf.getR2Bucket('CATALOG_PAGES');
  const snapshot = {
    sourceId: 'old',
    version: 'uc-related-previous-fixture',
    alternatives: [{ id: 'card', title: 'A & B < C', href: '/art/card/' }],
    companions: [],
    collection: [],
  };
  const html =
    `<meta name="build-revision" content="${old}"><h1>Unchanged image title</h1>` +
    `<p>Unchanged image-specific description.</p><script type="application/json" data-related-snapshot="">` +
    JSON.stringify(snapshot).replaceAll('<', '\\u003c') +
    '</script>';
  const original = await storage.put(`delivery/${old}/art/old/index.html`, html, {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
  });
  const response = await mf.dispatchFetch('https://example.test/art/old/', {
    headers: { 'Referrer-Policy': 'no-referrer' },
  });
  assert.equal(response.status, 200);
  const etag = response.headers.get('ETag');
  assert(etag.startsWith('W/'));
  assert.notEqual(etag, original.httpEtag);
  assert.equal(response.headers.get('Content-Length'), null);
  assert.equal(response.headers.get('Content-Security-Policy'), "script-src 'self'");
  assert.equal(response.headers.get('X-UC-Delivery'), `r2; html=${old}`);
  const representation = await response.text();
  assert.equal(representation, refreshRelatedPreview(html, 'old', version));
  const current = JSON.parse(
    /data-related-snapshot="">([\s\S]*?)<\/script>/.exec(representation)[1],
  );
  assert.equal(current.version, version);
  assert.deepEqual(current.alternatives, snapshot.alternatives);
  assert.equal(
    (await (await mf.dispatchFetch('https://example.test/related-release.json')).json()).version,
    current.version,
  );
  assert.equal(await (await storage.get(`delivery/${old}/art/old/index.html`)).text(), html);
  const head = await mf.dispatchFetch('https://example.test/art/old/', { method: 'HEAD' });
  assert.equal(head.headers.get('ETag'), etag);
  assert.equal(await head.text(), '');
  const unchanged = await mf.dispatchFetch('https://example.test/art/old/', {
    headers: { 'If-None-Match': etag },
  });
  assert.equal(unchanged.status, 304);
  const stale = await mf.dispatchFetch('https://example.test/art/old/', {
    headers: { 'If-None-Match': original.httpEtag },
  });
  assert.equal(stale.status, 200);
  assert.equal(await stale.text(), representation);
  console.log(
    JSON.stringify({
      status: 'PASS_LOCAL_PUBLIC_WORKER',
      relatedRemainsCurrent: true,
      cardsAndCopyUnchanged: true,
      nativeRepresentationMatchesPreview: true,
      noReferrerRequired: true,
      sourceBytesUnchanged: true,
      headAndConditionalCacheValid: true,
    }),
  );
} finally {
  await mf.dispose();
}
