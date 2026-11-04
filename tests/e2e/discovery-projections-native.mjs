// Real local native workerd/R2, deliberately fictional records. No remote access.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { m, fixture, batch, inspect, artwork } from '../fixtures/discovery-projections.mjs';
const require = createRequire(import.meta.resolve('wrangler/package.json')),
  { Miniflare, convertV4MiniflareOptions } = require('miniflare'),
  compiled = await build({
    entryPoints: ['tests/fixtures/discovery-projections-worker.mjs'],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
  }),
  mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      r2Persist: false,
      workers: [
        {
          name: 'private-discovery-projection-test',
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
let f = await fixture();
const report = {
  scope:
    'Actual private native workerd/R2; synthetic metadata is not image approval, no public routes or remote writes',
  passed: false,
  stages: [],
};
try {
  const bucket = await mf.getR2Bucket('TEST');
  for (const step of [
    {
      name: 'new-topic',
      changes: [
        {
          id: 'new-one',
          record: artwork('new-one', 'new-subject', {
            monochrome: true,
            monochromeKind: 'silhouette',
            style: 'Silhouette',
          }),
        },
      ],
      slugs: ['new-subject'],
      options: { groups: { 'new-subject': 'New Fixture' } },
    },
    {
      name: 'edit',
      changes: [
        {
          id: 'b-one',
          record: artwork('b-one', 'subject-b', {
            title: 'Native changed source title',
            style: 'Outline',
            monochrome: true,
            monochromeKind: 'outline',
          }),
        },
      ],
      slugs: ['subject-b'],
    },
    {
      name: 'move',
      changes: [{ id: 'b-two', record: artwork('b-two', 'new-subject') }],
      slugs: ['subject-b', 'new-subject'],
      options: { groups: { 'new-subject': 'New Fixture' } },
    },
    { name: 'withdraw-topic', changes: [{ id: 'b-one', record: null }], slugs: ['subject-b'] },
  ]) {
    const p = await batch(f, step.changes, step.slugs, step.options);
    for (const [key, b] of f.bucket.objects) {
      const existing = await bucket.head(key);
      if (!existing) await bucket.put(key, b);
    }
    const payload = {
      privateFixture: true,
      before: f.indexes,
      after: p.indexes,
      changes: p.args.changes,
      topicChanges: p.args.topicChanges,
      searchDataDescriptor: p.args.searchDataDescriptor,
    };
    const response = await mf.dispatchFetch('http://private.local/refresh', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
      body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    const node = await m.refresh.refreshDiscoveryViews(p.args),
      expected = await inspect(f, node, p.indexes);
    assert.deepEqual(m.search.canonical(body.result), m.search.canonical(node));
    assert.deepEqual(m.search.canonical(body.fields), m.search.canonical(expected.fields));
    assert.deepEqual(m.search.canonical(body.categories), m.search.canonical(expected.categories));
    assert.deepEqual(m.search.canonical(body.site), m.search.canonical(expected.site));
    assert.deepEqual(m.search.canonical(body.mono), m.search.canonical(expected.mono));
    report.stages.push({
      name: step.name,
      status: response.status,
      topics: body.topics,
      metrics: body.result.metrics,
    });
    f = {
      ...f,
      records: p.records,
      indexes: { ...p.indexes, collections: node.collections, search: node.search },
      context: expected.context,
    };
  }
  report.passed = true;
} finally {
  await mf.dispose();
}
console.log(JSON.stringify(report));
