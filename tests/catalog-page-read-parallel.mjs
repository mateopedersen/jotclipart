// Dependency-gated orchestration test. Immutable-byte reader tests remain separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const stubs = {
  'artwork-facet-reader.mjs':
    'export const readArtwork=(...a)=>globalThis.__pageHarness.artwork(...a);',
  'collection-context.mjs':
    'export const openSevenFacetCollectionContext=(...a)=>globalThis.__pageHarness.open(...a);',
  'related-bounded-reader.mjs':
    'export const readBoundedRelated=(...a)=>globalThis.__pageHarness.related(...a);',
  'hashed-record-directory.mjs':
    'export const lookupHashedRecord=(...a)=>globalThis.__pageHarness.lookup(...a);',
  'shared-artwork-context.mjs':
    'export const readSharedArtwork=(...a)=>globalThis.__pageHarness.shared(...a);',
  'surprise-picks.mjs':
    'export const readSurprisePicks=(...a)=>globalThis.__pageHarness.surprise(...a);',
};
const output = await build({
  entryPoints: ['server/catalog-snapshot/art-page-data.mjs'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  plugins: [
    {
      name: 'explicit-reader-fixture',
      setup(b) {
        b.onResolve({ filter: /\.mjs$/ }, (args) => {
          const k = args.path.split('/').at(-1);
          return stubs[k] ? { path: k, namespace: 'fixture' } : null;
        });
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents: stubs[args.path],
          loader: 'js',
        }));
      },
    },
  ],
});
const { readArtworkPageState } = await import(
  'data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64')
);
function fixture({ badRoster = false, badOwn = false, badPreview = false } = {}) {
  const context = { snapshot: { captured: 'same-root' } },
    bucket = {
      put() {
        throw Error('R2 writes forbidden');
      },
    },
    started = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const item = { id: 'source', topic: 'cat', webp: 'https://assets.ultraclipart.com/source.webp' };
  const own = {
    slug: badOwn ? 'dog' : 'cat',
    keyword: 'Cat Clipart',
    primaryCluster: 'Animals',
    sourceCluster: 'Animals',
  };
  const collections = {
    root: { features: 'features' },
    collections: { surprise: true, catalogPreviewDirectory: 'directory' },
    lookupCollection: async () => {
      started.push('own');
      return 'own';
    },
    countsFor: async () => ({ totals: { artworks: 3 } }),
    read: async (key) => (key === 'features' ? { artworks: [], surprise: [] } : own),
  };
  const h = {
    artwork: async (c, id) => {
      assert.equal(c, context);
      started.push('art:' + id);
      return id === 'source' ? item : { id, topic: badPreview ? 'dog' : 'cat' };
    },
    open: async (b, o) => {
      assert.equal(b, bucket);
      assert.equal(o.snapshot, context.snapshot);
      return collections;
    },
    related: async (c) => {
      assert.equal(c, context);
      started.push('related');
      await gate;
      return { sourceId: 'source', category: '/clipart/cat/' };
    },
    lookup: async (c) => {
      assert.equal(c, context);
      return 'roster';
    },
    shared: async (c) => {
      assert.equal(c, context);
      started.push('shared');
      await gate;
      return [];
    },
    surprise: async (c) => {
      assert.equal(c, context);
      started.push('surprise');
      await gate;
      return [{ id: 'pick', topic: 'dog' }];
    },
  };
  context.read = async () => ({
    schema: 1,
    type: 'catalog-order-preview',
    topic: badRoster ? 'dog' : 'cat',
    ids: ['source', 'other'],
  });
  return { h, context, bucket, started, release };
}
test('own metadata, shared context and related reads start independently on one snapshot', async () => {
  const f = fixture();
  globalThis.__pageHarness = f.h;
  const pending = readArtworkPageState(f.bucket, f.context, 'source');
  await new Promise((r) => setImmediate(r));
  for (const step of ['own', 'shared', 'surprise', 'related'])
    assert(f.started.includes(step), step + ' must start before unrelated reads finish');
  f.release();
  const state = await pending;
  assert.equal(state.item.webp, 'https://assets.ultraclipart.com/source.webp');
  assert.equal(state.surprise[0].id, 'pick');
  assert.equal(state.collectionPreview('cat', 'source')[0].id, 'other');
  assert.throws(() => state.collectionPreview('dog', 'source'));
});
test('parallel reads retain own-topic, roster and preview identity rejection', async () => {
  for (const flags of [{ badOwn: true }, { badRoster: true }, { badPreview: true }]) {
    const f = fixture(flags);
    globalThis.__pageHarness = f.h;
    const pending = readArtworkPageState(f.bucket, f.context, 'source');
    f.release();
    await assert.rejects(
      pending,
      /Wrong artwork collection|Invalid collection preview|Preview references wrong collection/,
    );
  }
});
