import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript } from './helpers/typescript.mjs';
test('current request timings separate fresh authenticated capture from response resolution', async () => {
  const { createCatalogHandler } = await loadTypescript('server/catalog-snapshot/handler.mjs');
  const renderer = { render: () => '', css: '', scripts: {} };
  let captures = 0,
    reads = 0;
  const context = {
    authorizationVerified: true,
    rootSHA256: 'a'.repeat(64),
    snapshot: { revision: 'b'.repeat(40) },
    getFacet: async () => {
      reads++;
      await new Promise((r) => setTimeout(r, 15));
      return { version: 3 };
    },
  };
  const handler = createCatalogHandler({
    bucket: {
      get() {
        throw Error('unexpected');
      },
    },
    capture: async () => {
      captures++;
      await new Promise((r) => setTimeout(r, 20));
      return context;
    },
    renderers: {
      art: renderer,
      editor: renderer,
      home: renderer,
      collection: renderer,
      shells: {},
      shellScripts: {},
    },
  });
  for (let i = 0; i < 2; i++) {
    const r = await handler(new Request('https://ultraclipart.com/related-release.json'));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { version: 3 });
    const timing = r.headers.get('server-timing');
    assert.match(timing, /^uc_capture;dur=\d+\.\d, uc_resolve;dur=\d+\.\d, uc_total;dur=\d+\.\d$/);
    const d = [...timing.matchAll(/dur=([\d.]+)/g)].map((m) => Number(m[1]));
    assert(d[0] >= 15 && d[1] >= 10 && Math.abs(d[0] + d[1] - d[2]) < 0.2);
    assert.equal(r.headers.get('x-uc-snapshot'), 'a'.repeat(64));
    assert.match(r.headers.get('cache-control'), /no-store/);
  }
  assert.equal(captures, 2);
  assert.equal(reads, 2);
  context.authorizationVerified = false;
  const denied = await handler(new Request('https://ultraclipart.com/related-release.json'));
  assert.equal(denied.status, 503);
  assert(!denied.headers.has('server-timing'));
});
