// Private protocol fixtures only. No new image review, live import, external
// request, publication authority, R2 write or freshly verified CDN claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import {
  incomingMediaFiles,
  incomingManifestSHA256,
  assertIncomingCDNReceipt,
} from '../scripts/catalog-snapshot/incoming-media-plan.mjs';
import { createReviewedDeltaValidators } from '../scripts/catalog-snapshot/validate-delta-source.mjs';
import { validateManifest } from '../scripts/publication-policy.mjs';
import { validatePageArtwork } from '../server/catalog-snapshot/legacy-artwork-validation.mjs';
import {
  facetStore,
  emitDirectory,
  bytesOf,
  digest,
} from '../server/catalog-collections/store.mjs';
import { readCollectionReferences } from '../server/catalog-collections/reader.mjs';
import { openSnapshot } from '../server/catalog-snapshot/snapshot-context.mjs';
import { readPublicArtwork } from '../server/catalog-snapshot/public-artwork-routes.mjs';
import { presentationState } from '../server/catalog-snapshot/brand-presentation.mjs';

const original = JSON.parse(readFileSync('tests/fixtures/catalog-delta-source.json'));
const newOrigin = 'https://assets.jotclipart.com',
  oldOrigin = 'https://assets.ultraclipart.com';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const mapURL = (value) =>
  typeof value === 'string'
    ? value.replace(/^https:\/\/assets\.ultraclipart\.com(?=\/)/, newOrigin)
    : value;
function fixture() {
  const f = structuredClone(original),
    plan = f.media;
  plan.status = 'PLANNED_INCOMING_MEDIA';
  plan.plannedAt = plan.verifiedAt;
  delete plan.verifiedAt;
  for (const file of plan.files) {
    file.url = mapURL(file.url);
    file.expectedCorsOrigin = 'https://jotclipart.com';
    delete file.corsOrigin;
    delete file.verification;
    delete file.verifiedAt;
  }
  for (const key of ['webp', 'pdf', 'originalThumb', 'thumb', 'preview'])
    f.record[key] = mapURL(f.record[key]);
  const row = {
    id: f.raw.id,
    raw: f.raw,
    review: f.review,
    expectedOldPublicSHA256: null,
    monochromeReceipt: {
      sourceSHA256: f.raw.files.thumb.sha256,
      monochrome: f.record.monochrome,
      kind: f.record.monochromeKind,
      receiptSHA256: '1'.repeat(64),
    },
    pairReceipt: {
      status: 'MATCHED_SOURCE_PIXELS',
      imageSHA256: f.raw.files.webp.sha256,
      pdfSHA256: f.raw.files.pdf.sha256,
      receiptSHA256: '2'.repeat(64),
    },
  };
  return {
    ...f,
    plan,
    row,
    change: { id: f.raw.id, expectedPublicSHA256: null, record: f.record },
  };
}
async function admit(f) {
  const before = JSON.stringify(f.plan);
  assert.equal(incomingMediaFiles(f.plan).size, 3);
  const receipt = {
    status: 'INCOMING_MEDIA_CDN_GET_BYTES_SHA_MIME_CORS_VERIFIED',
    publicOrigin: 'https://jotclipart.com',
    manifestSHA256: incomingManifestSHA256(f.plan),
    oldCatalogScans: 0,
    files: f.plan.files.map((file) => ({
      url: file.url,
      publicUrl: file.url,
      assetId: file.assetId,
      kind: file.kind,
      bytes: file.bytes,
      sha256: file.sha256,
      contentType: file.contentType,
      corsOrigin: 'https://jotclipart.com',
    })),
  };
  const options = { artworkRows: [f.row], topicRows: [], incomingMediaManifest: f.plan };
  await createReviewedDeltaValidators({
    ...options,
    phase: 'local-preflight',
    mediaPlanSHA256: incomingManifestSHA256(f.plan),
  }).validateSourceChange({ change: f.change, oldRecord: null });
  const result = await createReviewedDeltaValidators({
    ...options,
    mediaReceipt: receipt,
    mediaReceiptSHA256: incomingManifestSHA256(receipt),
  }).validateSourceChange({ change: f.change, oldRecord: null });
  assert.equal(result.imageSHA256, f.raw.files.webp.sha256);
  assert.equal(JSON.stringify(f.plan), before);
  return receipt;
}
async function graph(record) {
  const objects = new Map(),
    bucket = {
      async get(key) {
        const bytes = objects.get(key);
        return bytes ? { size: bytes.length, arrayBuffer: async () => bytes } : null;
      },
      async put(key, bytes, options) {
        assert.deepEqual(options.onlyIf, { etagDoesNotMatch: '*' });
        if (objects.has(key)) return null;
        objects.set(key, new Uint8Array(bytes));
        return { etag: 'private-immutable' };
      },
    };
  const store = facetStore(bucket, { writable: true }),
    id = record.id,
    slug = record.topic,
    revision = 'a'.repeat(40);
  const member = {
    offset: 0,
    count: 1,
    ...(await store.put('collections', {
      type: 'collection-members',
      slug,
      offset: 0,
      artworkIds: [id],
    })),
  };
  const page = {
    offset: 0,
    count: 1,
    ...(await store.put('collections', {
      type: 'collection-page-ids',
      slug,
      offset: 0,
      artworkIds: [id],
    })),
  };
  const summary = 'Private protocol fixture topic.',
    paragraphs = [
      'Private protocol fixture with {{artworkCount}} source item.',
      'Another private protocol paragraph.',
    ];
  const topic = {
    schema: 1,
    type: 'collection-topic-references',
    slug,
    path: `/clipart/${slug}/`,
    canonical: `https://ultraclipart.com/clipart/${slug}/`,
    keyword: 'Private fixture',
    title: 'Private Fixture Clipart',
    summary,
    metaDescription: summary,
    primaryCluster: 'Fixture',
    sourceCluster: 'Fixture',
    clusters: [{ name: 'Fixture', path: '/collection/fixture/' }],
    paragraphs,
    editorial: { intro: summary, paragraphs },
    artworkCount: 1,
    coverArtworkId: id,
    related: [],
    membership: [member],
    pageBlocks: [page],
  };
  const topicDescriptor = await store.put('collections', topic),
    directory = await emitDirectory(
      store,
      [{ slug, path: topic.path, artworkCount: 1, ...topicDescriptor }],
      'collection',
    );
  const topics = await emitDirectory(store, [{ slug, count: 1 }], 'count');
  const global = await store.put('counts', {
    type: 'catalog-counts',
    version: 'a'.repeat(16),
    totals: { artworks: 1, subjects: 1, collections: 1, printable: 0 },
    collections: { fixture: { artworks: 1, subjects: 1 } },
  });
  const sharedContext = await store.put('collections', { ids: [id], artworks: [], surprise: [] });
  const hash = sha(id),
    part = hash.slice(0, 3),
    prefix = part.slice(0, 2);
  const leaf = await store.put('artworks', {
    type: 'artwork-leaf',
    shard: part,
    records: [record],
  });
  const artDirectory = await store.put('artworks', {
    type: 'artwork-directory',
    prefix,
    shards: { [part]: leaf },
  });
  const indexes = {
    artworks: await store.put('artworks', {
      type: 'artwork-root',
      revision,
      directories: { [prefix]: artDirectory },
    }),
    collections: await store.put('collections', {
      type: 'collection-directory',
      viewProtocol: 'collection-references-v2',
      topicCount: 1,
      artworkCount: 1,
      directory,
      sharedContext,
    }),
    counts: await store.put('counts', {
      type: 'catalog-count-directory',
      topicCount: 1,
      artworkCount: 1,
      topics,
      global,
    }),
  };
  for (const facet of ['search', 'recent', 'related', 'sitemaps']) {
    const bytes = bytesOf({ schema: 1, type: 'private-unused-facet' }),
      sha256 = await digest(bytes),
      key = `catalog/objects/${facet}/${sha256}.json`;
    objects.set(key, bytes);
    indexes[facet] = { key, sha256, bytes: bytes.length };
  }
  const snapshot = {
    schema: 1,
    status: 'PRIVATE_UNPUBLISHABLE',
    fixture: true,
    revision,
    parentRevision: 'b'.repeat(40),
    indexes,
  };
  const context = await openSnapshot(bucket, { provided: snapshot, allowFixture: true });
  return { objects, bucket, snapshot, context, leaf, slug };
}
const readerOptions = {
  resolveArtwork: async (id, context) => ({
    rootSHA256: context.rootSHA256,
    artwork: await readPublicArtwork(context, id),
  }),
};
test('a future Jot-host plan is source-admitted and read through the captured v2 reader without rewriting source facts', async () => {
  const f = fixture(),
    before = JSON.stringify(original);
  await admit(f);
  const g = await graph(f.record),
    result = await readCollectionReferences(g.context, g.slug, readerOptions);
  const item = result.state.art[0];
  assert.equal(item.id, f.raw.id);
  assert.equal(item.webp, f.record.webp);
  assert.equal(item.pdf, f.record.pdf);
  assert.equal(item.description, f.record.description);
  assert.equal(item.alt, f.record.alt);
  assert.deepEqual(item.files, f.raw.files);
  assert.equal(validatePageArtwork(f.record), f.record);
  assert.equal(presentationState(result.state).art[0].webp, f.record.webp);
  assert.equal(JSON.stringify(original), before);
  assert.equal(g.context.publicationVerified, false);
  assert.throws(
    () =>
      validateManifest({
        ...original.media,
        files: original.media.files.map((file) => ({ ...file, url: mapURL(file.url) })),
      }),
    'Legacy verified source-receipt validator remains strict',
  );
});
test('the actual local workerd reader accepts new Jot media URLs and renders one derived Free title', async () => {
  const f = fixture();
  await admit(f);
  const g = await graph(f.record);
  const values = Object.fromEntries(
    [...g.objects].map(([key, bytes]) => [key, Buffer.from(bytes).toString('base64')]),
  );
  const code = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `import{openSnapshot}from'./server/catalog-snapshot/snapshot-context.mjs';import{readCollectionReferences}from'./server/catalog-collections/reader.mjs';import{readPublicArtwork}from'./server/catalog-snapshot/public-artwork-routes.mjs';import{presentationState}from'./server/catalog-snapshot/brand-presentation.mjs';import{displayCatalogTitle}from'./src/lib/display-title.ts';const values=${JSON.stringify(values)},snapshot=${JSON.stringify(g.snapshot)};export default{async fetch(){try{const bucket={async get(key){const value=values[key];if(!value)return null;const bytes=Uint8Array.from(atob(value),c=>c.charCodeAt(0));return{size:bytes.length,arrayBuffer:async()=>bytes}}};const context=await openSnapshot(bucket,{provided:snapshot,allowFixture:true});const result=await readCollectionReferences(context,${JSON.stringify(g.slug)},{resolveArtwork:async(id,ctx)=>({rootSHA256:ctx.rootSHA256,artwork:await readPublicArtwork(ctx,id)})});const item=presentationState(result.state).art[0];return Response.json({item,title:displayCatalogTitle(item.title),publicationVerified:context.publicationVerified})}catch(error){return new Response(error.message,{status:503})}}};`,
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
          name: 'private-future-import',
          script: code.outputFiles[0].text,
          modules: true,
          compatibilityDate: '2026-10-23',
        },
      ],
      host: '127.0.0.1',
      port: 0,
    }),
  );
  try {
    const response = await mf.dispatchFetch('https://private-future-import.invalid/');
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const body = JSON.parse(text);
    assert.equal(body.title, 'Free ' + f.record.title);
    assert.equal(body.item.webp, f.record.webp);
    assert.equal(body.item.pdf, f.record.pdf);
    assert.deepEqual(body.item.files, f.raw.files);
    assert.equal(body.publicationVerified, false);
  } finally {
    await mf.dispose();
  }
});
test('both exact owned media hosts work while spoofed origins and changed media facts fail closed in the v2 reader', async () => {
  const f = fixture();
  for (const origin of [newOrigin, oldOrigin]) {
    const item = {
      ...f.record,
      webp: f.record.webp.replace(newOrigin, origin),
      pdf: f.record.pdf.replace(newOrigin, origin),
      thumb: f.record.webp.replace(newOrigin, origin),
    };
    const g = await graph(item);
    assert.equal(
      (await readCollectionReferences(g.context, g.slug, readerOptions)).state.art[0].webp,
      item.webp,
    );
    assert.equal(validatePageArtwork(item), item);
  }
  for (const patch of [
    { webp: f.record.webp.replace(newOrigin, 'https://assets.jotclipart.com.evil.invalid') },
    { webp: f.record.webp.replace(newOrigin, 'http://assets.jotclipart.com') },
    { webp: f.record.webp.replace(newOrigin, 'https://assets.jotclipart.com:444') },
    { webp: f.record.webp.replace(newOrigin, 'https://user:pass@assets.jotclipart.com') },
    { webp: f.record.webp + '?mutable=1' },
    { webp: f.record.webp + '#fragment' },
    { files: { ...f.record.files, webp: { ...f.record.files.webp, sha256: 'wrong' } } },
    { files: { ...f.record.files, webp: { ...f.record.files.webp, bytes: 0 } } },
  ]) {
    const item = { ...f.record, ...patch };
    item.thumb = item.webp;
    const g = await graph(item);
    await assert.rejects(readCollectionReferences(g.context, g.slug, readerOptions));
  }
});
test('new plans keep strict immutable paths, content hashes, MIME, byte bounds and CORS', () => {
  const f = fixture();
  for (const mutate of [
    (plan) => (plan.files[0].url = plan.files[0].url.replace(newOrigin, 'https://foreign.invalid')),
    (plan) => (plan.files[0].url += '?mutable=1'),
    (plan) => (plan.files[0].sha256 = '0'.repeat(64)),
    (plan) => (plan.files[0].contentType = 'text/html'),
    (plan) => (plan.files[0].bytes = 0),
    (plan) => (plan.files[0].expectedCorsOrigin = 'https://foreign.invalid'),
  ]) {
    const plan = structuredClone(f.plan);
    mutate(plan);
    assert.throws(() => incomingMediaFiles(plan));
  }
});
test('old immutable plans may bind a fresh exact new-origin receipt without changing the old plan or signatures', async () => {
  const f = fixture();
  for (const file of f.plan.files) {
    file.url = file.url.replace(newOrigin, oldOrigin);
    file.expectedCorsOrigin = 'https://ultraclipart.com';
  }
  const before = JSON.stringify(f.plan),
    receipt = {
      status: 'INCOMING_MEDIA_CDN_GET_BYTES_SHA_MIME_CORS_VERIFIED',
      publicOrigin: 'https://jotclipart.com',
      manifestSHA256: incomingManifestSHA256(f.plan),
      oldCatalogScans: 0,
      files: f.plan.files.map((file) => ({
        url: file.url,
        publicUrl: mapURL(file.url),
        assetId: file.assetId,
        kind: file.kind,
        bytes: file.bytes,
        sha256: file.sha256,
        contentType: file.contentType,
        corsOrigin: 'https://jotclipart.com',
      })),
    };
  assertIncomingCDNReceipt(f.plan, receipt, incomingManifestSHA256(receipt));
  assert.equal(JSON.stringify(f.plan), before);
  for (const change of [
    (value) => (value.publicOrigin = 'https://foreign.invalid'),
    (value) =>
      (value.files[0].publicUrl = value.files[0].publicUrl.replace(
        newOrigin,
        'https://foreign.invalid',
      )),
    (value) => (value.files[0].corsOrigin = 'https://ultraclipart.com'),
    (value) => (value.files[0].sha256 = '0'.repeat(64)),
  ]) {
    const copy = structuredClone(receipt);
    change(copy);
    assert.throws(() => assertIncomingCDNReceipt(f.plan, copy, incomingManifestSHA256(copy)));
  }
});
