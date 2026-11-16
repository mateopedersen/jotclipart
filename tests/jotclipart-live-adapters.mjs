// Private protocol fixtures only; these are not artwork or publication receipts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { brand, publicBrandURL } from '../src/lib/brand.mjs';
import { displayTitle, displayCatalogTitle } from '../src/lib/display-title.ts';
import {
  catalogPublicOrigin,
  verifyIncomingMedia,
} from '../scripts/catalog-snapshot/batch-media.mjs';
import { verifyContentLive } from '../scripts/catalog-snapshot/verify-content-live.mjs';
import { verifiedPublicStudioSHA256 } from '../scripts/catalog-snapshot/verify-presentation-live.mjs';
import { openSnapshot } from '../server/catalog-snapshot/snapshot-context.mjs';
import { prepareStudioInfoRecord } from '../server/catalog-snapshot/prepared-studio.mjs';
import { merkle } from '../scripts/delivery/manifest.mjs';
import { MIME_TYPES } from '../scripts/publication-policy.mjs';
import { artwork, manifestFor } from './fixtures/publication.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function scratch() {
  mkdirSync(resolve('work'), { recursive: true });
  return mkdtempSync(join(resolve('work'), 'jotclipart-live-adapter-'));
}
function mediaFixture() {
  const bodies = new Map();
  const files = ['webp', 'pdf', 'thumb'].map((kind) => {
    const bytes = Buffer.from('PRIVATE_PROTOCOL_FIXTURE_' + kind);
    const hash = sha(bytes),
      extension = kind === 'thumb' ? 'webp' : kind;
    const url = `https://assets.ultraclipart.com/private/${kind}.${hash.slice(0, 16)}.${extension}`;
    bodies.set(publicBrandURL(url), bytes);
    return {
      assetId: 'private-fixture',
      sourceType: 'raster',
      kind,
      path: `/catalog/private/${kind}.${extension}`,
      name: `${kind}.${extension}`,
      url,
      bytes: bytes.length,
      sha256: hash,
      contentType: MIME_TYPES[kind],
      expectedCorsOrigin: 'https://ultraclipart.com',
    };
  });
  return {
    bodies,
    manifest: {
      schema: 2,
      status: 'PLANNED_INCOMING_MEDIA',
      plannedAt: '2026-11-16T00:00:00Z',
      files,
      bytes: files.reduce((n, file) => n + file.bytes, 0),
    },
  };
}
test('public origin is scoped to the new project and rejects unsafe or old targets', () => {
  for (const origin of [
    brand.origin,
    'https://jotclipart.pages.dev',
    'https://review-1.jotclipart.pages.dev',
  ])
    assert.equal(catalogPublicOrigin(origin), origin);
  for (const origin of [
    'https://ultraclipart.com',
    'https://foreign.example',
    'http://jotclipart.com',
    'https://jotclipart.com:444',
    'https://user@jotclipart.com',
    'https://jotclipart.com/path',
    'https://nested.x.jotclipart.pages.dev',
  ])
    assert.throws(() => catalogPublicOrigin(origin));
});
test('new public media GETs retain source descriptors and verify real bytes/MIME/CORS', async () => {
  const { bodies, manifest } = mediaFixture(),
    before = JSON.stringify(manifest),
    seen = [];
  const result = await verifyIncomingMedia(manifest, {
    publicOrigin: brand.origin,
    fetcher: async (url, options) => {
      seen.push(url);
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Origin, brand.origin);
      const file = manifest.files.find((f) => publicBrandURL(f.url) === url);
      assert(file);
      return new Response(bodies.get(url), {
        headers: { 'content-type': file.contentType, 'access-control-allow-origin': brand.origin },
      });
    },
  });
  assert.equal(seen.length, 3);
  assert.equal(result.publicOrigin, brand.origin);
  assert.equal(JSON.stringify(manifest), before);
  for (const file of result.files) {
    const source = manifest.files.find((f) => f.kind === file.kind);
    assert.equal(file.url, source.url);
    assert.equal(file.publicUrl, publicBrandURL(source.url));
    assert.equal(file.sha256, source.sha256);
    assert.equal(file.bytes, source.bytes);
    assert.equal(file.corsOrigin, brand.origin);
  }
});
for (const fault of ['http', 'mime', 'cors', 'short', 'long', 'hash'])
  test('new public media refuses ' + fault + ' without producing a receipt', async () => {
    const { bodies, manifest } = mediaFixture();
    await assert.rejects(
      verifyIncomingMedia(manifest, {
        publicOrigin: brand.origin,
        fetcher: async (url) => {
          const file = manifest.files.find((f) => publicBrandURL(f.url) === url);
          const original = bodies.get(url);
          const body =
            fault === 'short'
              ? original.subarray(1)
              : fault === 'long'
                ? Buffer.concat([original, Buffer.from('extra')])
                : fault === 'hash'
                  ? Buffer.alloc(original.length, 0)
                  : original;
          return new Response(body, {
            status: fault === 'http' ? 302 : 200,
            headers: {
              'content-type': fault === 'mime' ? 'text/plain' : file.contentType,
              'access-control-allow-origin':
                fault === 'cors' ? 'https://ultraclipart.com' : brand.origin,
            },
          });
        },
      }),
    );
  });

function contentFixture(directory, free = true) {
  const bodies = new Map(),
    raw = artwork('private-artwork', bodies);
  const manifest = manifestFor([raw]);
  const record = {
    ...raw,
    title: 'Baby Elephant Clipart',
    alt: 'Literal source alt.',
    description: 'Literal source description.',
  };
  for (const file of manifest.files) record[file.kind] = file.url;
  const root = 'a'.repeat(64),
    revision = 'b'.repeat(40),
    calls = [];
  return {
    calls,
    packet: {
      changes: [{ id: record.id, record }],
      topicChanges: [],
      incomingMediaManifest: manifest,
    },
    sealed: { verifiedRoot: root, snapshot: { revision } },
    fetcher: async (url, options) => {
      calls.push(url);
      if (url === brand.origin + '/delivery-release.json')
        return Response.json({ verifiedRoot: root, renderedRevision: revision });
      const media = manifest.files.find((file) => publicBrandURL(file.url) === url);
      if (media) {
        assert.equal(options.headers.Origin, brand.origin);
        return new Response(bodies.get(media.path), {
          headers: {
            'content-type': media.contentType,
            'access-control-allow-origin': brand.origin,
          },
        });
      }
      const path = new URL(url).pathname;
      assert.equal(new URL(url).origin, brand.origin);
      assert(['/art/private-artwork/', '/edit/private-artwork/'].includes(path));
      const title =
        path.startsWith('/art/') && free
          ? displayCatalogTitle(record.title)
          : displayTitle(record.title);
      return new Response(
        `<html><head><meta name="build-revision" content="${revision}"><link rel="canonical" href="${brand.origin}${path}"></head><body><h1>${title}</h1><img src="${publicBrandURL(record.webp)}"><a href="${publicBrandURL(record.pdf)}">PDF</a></body></html>`,
        { headers: { 'x-uc-snapshot': root } },
      );
    },
    directory,
  };
}
test('content live gate uses new hosts and Free art titles while preserving editor/source text', async () => {
  const directory = scratch();
  try {
    const fixture = contentFixture(directory),
      before = JSON.stringify(fixture.packet);
    const receipt = await verifyContentLive(fixture);
    assert.equal(receipt.pages.length, 2);
    assert.equal(receipt.publicOrigin, brand.origin);
    assert.equal(JSON.stringify(fixture.packet), before);
    assert(fixture.calls.every((url) => !url.includes('ultraclipart.com')));
    assert.equal(
      JSON.parse(readFileSync(join(directory, 'live-verification.json'))).verifiedRoot,
      fixture.sealed.verifiedRoot,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('content live gate rejects a missing Free prefix on a public artwork', async () => {
  const directory = scratch();
  try {
    await assert.rejects(verifyContentLive(contentFixture(directory, false)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function preparedStudioFixture(directory) {
  const records = [],
    sourceByKey = {},
    bytesByKey = new Map();
  const put = async (facet, value) => {
    const bytes = Buffer.from(JSON.stringify(value)),
      hash = sha(bytes);
    const descriptor = {
      key: `catalog/objects/${facet}/${hash}.json`,
      sha256: hash,
      bytes: bytes.length,
    };
    if (!bytesByKey.has(descriptor.key)) {
      const file = join(directory, hash + '.json');
      writeFileSync(file, bytes);
      sourceByKey[descriptor.key] = file;
      bytesByKey.set(descriptor.key, bytes);
      records.push({
        ...descriptor,
        path: '/catalog-snapshot/' + descriptor.key.slice('catalog/objects/'.length),
        mime: 'application/json',
      });
    }
    return descriptor;
  };
  const indexes = {};
  for (const facet of [
    'artworks',
    'collections',
    'search',
    'recent',
    'related',
    'counts',
    'sitemaps',
  ])
    indexes[facet] = await put(facet, {});
  const candidate = {
    schema: 1,
    revision: 'c'.repeat(40),
    parentRevision: 'd'.repeat(40),
    fixture: true,
    status: 'PRIVATE_UNPUBLISHABLE',
    indexes,
  };
  const bucket = {
    get: async (key) => {
      const bytes = bytesByKey.get(key);
      return bytes ? { size: bytes.length, arrayBuffer: async () => bytes } : null;
    },
  };
  const context = await openSnapshot(bucket, { provided: candidate, allowFixture: true });
  const info = {
    items: [
      {
        id: 'private-fixture',
        title: 'https://ultraclipart.com/source-title/',
        alt: 'Literal source alt',
        webp: {
          url: 'https://assets.ultraclipart.com/original.webp',
          bytes: 10,
          sha256: '1'.repeat(64),
        },
      },
    ],
    topics: [],
    total: 1,
    transport: {
      protocol: 'snapshot-search-v1',
      endpoint: '/catalog-search.json',
      snapshot: context.rootSHA256,
    },
  };
  const softwareABI = 'e'.repeat(64);
  const prepared = await prepareStudioInfoRecord({
    context,
    info,
    rendererSHA256: softwareABI,
    compress: async (bytes) => gzipSync(bytes),
    put: (value) => put('collections', value),
  });
  candidate.indexes.collections = await put('collections', { preparedStudio: prepared.descriptor });
  const manifest = {
    schema: 1,
    status: 'REVIEWED_METADATA_REQUIRES_REMOTE_READBACK',
    revision: candidate.revision,
    root: merkle(records).root,
    records,
    sourceByKey,
  };
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
  return { directory, candidate, softwareABI, receipt: prepared.receipt, info, manifest };
}
test('public Studio digest derives only after original prepared bytes and source digest pass', async () => {
  const directory = scratch();
  try {
    const fixture = await preparedStudioFixture(directory),
      projected = structuredClone(fixture.info);
    projected.items[0].webp.url = 'https://assets.jotclipart.com/original.webp';
    assert.equal(
      await verifiedPublicStudioSHA256(fixture),
      sha(Buffer.from(JSON.stringify(projected))),
    );
    assert.equal(fixture.info.items[0].title, 'https://ultraclipart.com/source-title/');
    assert.equal(fixture.receipt.sourceBodySHA256, sha(Buffer.from(JSON.stringify(fixture.info))));
    await assert.rejects(
      verifiedPublicStudioSHA256({
        ...fixture,
        receipt: { ...fixture.receipt, sourceBodySHA256: '0'.repeat(64) },
      }),
    );
    const file = fixture.manifest.sourceByKey[fixture.candidate.indexes.collections.key];
    writeFileSync(file, Buffer.from('changed source'));
    await assert.rejects(
      verifiedPublicStudioSHA256(fixture),
      /Metadata source changed|immutable object/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
