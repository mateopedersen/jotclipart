import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.resolve('wrangler')),
  { Miniflare, convertV4MiniflareOptions } = require('miniflare'),
  date = '2026-10-23',
  flags = [];
const mf = new Miniflare(
  convertV4MiniflareOptions({
    cf: false,
    workers: [
      {
        name: 'private-existing-date-defaults',
        modules: true,
        compatibilityDate: date,
        compatibilityFlags: flags,
        script: `import{AsyncLocalStorage}from'node:async_hooks';const state=new AsyncLocalStorage();export default{fetch(r){const id=new URL(r.url).searchParams.get('id');return state.run(id,async()=>{await new Promise(resolve=>setTimeout(resolve,id==='first'?8:1));return Response.json({id:state.getStore()})})}}`,
      },
    ],
  }),
);
try {
  const results = await Promise.all(
    ['first', 'second'].map((id) =>
      mf.dispatchFetch('http://private.test/?id=' + id).then((r) => r.json()),
    ),
  );
  assert.deepEqual(results, [{ id: 'first' }, { id: 'second' }]);
  const report = {
    status: 'EXISTING_DATE_EMPTY_FLAGS_LOCAL_NATIVE_ASYNCLOCALSTORAGE_VERIFIED',
    compatibilityDate: date,
    compatibilityFlags: flags,
    isolatedConcurrentRequests: results,
    platformSettingMutations: 0,
    productionWrites: 0,
  };
  writeFileSync(
    'work/catalog-snapshot/runtime-defaults-report.json',
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await mf.dispose();
}
