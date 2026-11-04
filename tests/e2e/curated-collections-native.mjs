// Local workerd/R2 only. Private protocol fixtures cannot be activated.
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { m, fixture, batch, put } from '../fixtures/discovery-projections.mjs';
import { curatedDefinitions } from '../../src/lib/curated-collection-policy.mjs';
import { readReviewedImportCatalog } from '../../scripts/reviewed-imports.mjs';

const group = curatedDefinitions.find((g) => g.slug === 'primates'),
  catalog = new Map(readReviewedImportCatalog(process.cwd()).map((a) => [a.id, a]));
const rows = group.cover.map((p) => ({ ...catalog.get(p.id), monochrome: false }));
let f = await fixture();
const changed = await batch(
  f,
  rows.map((record) => ({ id: record.id, record })),
  group.topicSlugs,
);
const refreshed = await m.refresh.refreshDiscoveryViews(changed.args);
f = {
  ...f,
  records: changed.records,
  indexes: { ...changed.indexes, collections: refreshed.collections, search: refreshed.search },
};
const sha = (s) => createHash('sha256').update(s).digest('hex'),
  parts = new Map(),
  directories = {};
for (const row of f.records.values()) {
  const p = sha(row.id).slice(0, 3);
  parts.set(p, [...(parts.get(p) ?? []), row]);
}
for (const [part, records] of parts) {
  const prefix = part.slice(0, 2);
  directories[prefix] ??= { schema: 1, type: 'artwork-directory', prefix, shards: {} };
  directories[prefix].shards[part] = await put(f.bucket, 'artworks', { shard: part, records });
}
for (const prefix of Object.keys(directories))
  directories[prefix] = await put(f.bucket, 'artworks', directories[prefix]);
const indexes = {
  ...f.indexes,
  artworks: await put(f.bucket, 'artworks', {
    type: 'artwork-root',
    revision: 'a'.repeat(40),
    directories,
  }),
};
indexes.collections = await put(f.bucket, 'collections', {
  ...(await f.cs.read('collections', indexes.collections)),
  sharedContext: await put(f.bucket, 'collections', {
    type: 'private-shared-fixture',
    ids: [],
    artworks: [],
    surprise: [],
  }),
});
indexes.related = await put(f.bucket, 'related', { type: 'private-unused-facet' });
indexes.sitemaps = await put(f.bucket, 'sitemaps', {
  type: 'sitemap-directory',
  index: await put(f.bucket, 'sitemaps', { type: 'sitemap-index', kinds: ['pages', 'images'] }),
});
const snapshot = {
  schema: 1,
  fixture: true,
  status: 'PRIVATE_UNPUBLISHABLE',
  revision: 'a'.repeat(40),
  parentRevision: 'b'.repeat(40),
  indexes: Object.fromEntries(
    ['artworks', 'collections', 'search', 'recent', 'related', 'counts', 'sitemaps'].map((name) => [
      name,
      indexes[name],
    ]),
  ),
};
const require = createRequire(import.meta.resolve('wrangler/package.json')),
  { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const compiled = await build({
  entryPoints: ['tests/fixtures/curated-collections-worker.mjs'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  write: false,
});
const mf = new Miniflare(
  convertV4MiniflareOptions({
    cf: false,
    r2Persist: false,
    workers: [
      {
        name: 'private-curated-collections',
        modules: true,
        script: compiled.outputFiles[0].text,
        compatibilityDate: '2026-10-23',
        r2Buckets: ['TEST'],
        outboundService: () => {
          throw Error('External calls prohibited');
        },
      },
    ],
  }),
);
const report = {
  scope:
    'Private native workerd/R2 protocol test. Reused source artwork is not a new review or publication.',
  status: 'RUNNING',
  checks: [],
};
try {
  const bucket = await mf.getR2Bucket('TEST');
  for (const [key, bytes] of f.bucket.objects) await bucket.put(key, bytes);
  await bucket.put('catalog/active.json', JSON.stringify(snapshot));
  const invoke = async (path) => {
    const r = await mf.dispatchFetch('http://local.invalid' + path),
      body = await r.text();
    assert.equal(r.status, 200, path + ' ' + body + ' ' + r.headers.get('x-private-error'));
    return body;
  };
  const page = JSON.parse(await invoke('/collection/primates/'));
  assert.equal(page.props.collectionSlug, 'primates');
  assert.equal(page.curated.length, 1);
  assert.equal(page.curated[0].count, 3);
  assert.deepEqual(
    page.curated[0].covers,
    group.cover.map((a) => a.id),
  );
  assert(page.curated[0].gallery.every((a) => group.topicSlugs.includes(a.topic)));
  report.checks.push(
    'Captured curated route, current source cover hashes and exact gallery membership',
  );
  const directory = JSON.parse(await invoke('/collections/'));
  assert.equal(directory.curated.length, 1);
  assert.equal(directory.counts.totals.artworks, 7);
  assert.equal(directory.counts.totals.collections, 2);
  report.checks.push('No duplicate global artwork count or primary category mutation');
  const counts = JSON.parse(await invoke('/catalog-stats.json?scope=visible&topic=monkey'));
  assert.equal(counts.collections.primates.artworks, 3);
  assert.deepEqual(counts.topics, { monkey: 1 });
  report.checks.push('Bounded visible count protocol');
  const xml = await invoke('/sitemap-collections.xml');
  assert(xml.includes('/collection/primates/'));
  assert(!xml.includes('/collection/farm-animals/'));
  assert((await invoke('/sitemap.xml')).includes('/sitemap-collections.xml'));
  report.checks.push('Only complete curated groups enter the additional sitemap');
  assert.equal((await mf.dispatchFetch('http://local.invalid/collection/unknown/')).status, 404);
  assert.equal(
    (await mf.dispatchFetch('http://local.invalid/collection/farm-animals/')).status,
    404,
  );
  assert.deepEqual(JSON.parse(await (await bucket.get('catalog/active.json')).text()), snapshot);
  report.checks.push('Unknown/incomplete routes fail closed; private active pointer untouched');
  report.status = 'PRIVATE_NATIVE_QA_PASSED_NOT_PUBLISHED';
} finally {
  await mf.dispose();
  const dir = resolve(process.env.UC_COLLECTION_REPORT ?? 'reports/curated-collections');
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'native-report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report));
