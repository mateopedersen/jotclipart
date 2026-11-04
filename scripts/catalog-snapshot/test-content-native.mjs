import { displayTitle } from '../../src/lib/display-title.ts';
// Native rendering of the changed batch through a verified point-read service.
// No copied full catalog, no production pointer and no external media downloads.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { openSnapshot } from '../../server/catalog-snapshot/snapshot-context.mjs';
import { openSevenFacetCollectionContext } from '../../server/catalog-snapshot/collection-context.mjs';
import { facetStore } from '../../server/catalog-collections/store.mjs';
import { membership } from '../../server/catalog-collections/writer.mjs';
const sha = (b) => createHash('sha256').update(b).digest('hex'),
  decode = (s) =>
    s
      .replace(/<[^>]*>/g, '')
      .replace(/&#x([0-9a-f]+);|&#(\d+);|&(amp|lt|gt|quot|apos);/gi, (_, h, n, k) =>
        h
          ? String.fromCodePoint(parseInt(h, 16))
          : n
            ? String.fromCodePoint(+n)
            : { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[k.toLowerCase()],
      )
      .trim();
export async function verifyNativeContent(options) {
  const verify = () => verifyNativeContentWithSource(options);
  return typeof options.parentBucket?.withoutDiskCacheAdmissions === 'function'
    ? options.parentBucket.withoutDiskCacheAdmissions(verify)
    : verify();
}
async function verifyNativeContentWithSource({
  candidate,
  created,
  parentBucket,
  software,
  packet,
}) {
  const sourcePacket = packet,
    sourcePacketSHA256 = sha(Buffer.from(JSON.stringify(sourcePacket)));
  if (packet.status === 'SOURCE_REVIEWED_COLLECTION_PROSE_BATCH') {
    const sourceBucket = {
      get: async (key) => {
        const b = created.get(key);
        return b
          ? {
              size: b.length,
              arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
              json: async () => JSON.parse(b),
            }
          : parentBucket.get(key);
      },
    };
    const context = await openSnapshot(sourceBucket, { provided: candidate, allowFixture: true }),
      cc = await openSevenFacetCollectionContext(sourceBucket, {
        snapshot: candidate,
        allowUnpublishableFixture: true,
      }),
      store = facetStore(sourceBucket),
      topicChanges = [];
    for (const c of packet.changes) {
      const d = await cc.lookupCollection(c.slug),
        r = await cc.read(d);
      topicChanges.push({ slug: c.slug, record: c.record, artworkIds: await membership(store, r) });
    }
    packet = { changes: [], topicChanges };
  }
  const report = JSON.parse(readFileSync(join(software, 'runtime/software-report.json')));
  assert.equal(sha(readFileSync(join(software, 'runtime/worker.mjs'))), report.workerSHA256);
  for (const [file, hash] of Object.entries(report.sourceInputs))
    if (!['trusted-public-config', 'http-policy'].includes(file))
      assert.equal(sha(readFileSync(file)), hash, 'Installed renderer source changed: ' + file);
  const code = await build({
      stdin: {
        resolveDir: process.cwd(),
        contents: `import{openSnapshot}from'./server/catalog-snapshot/snapshot-context.mjs';import{requestBucket}from'./server/catalog-snapshot/request-bucket.mjs';import{immutableMetadataCache}from'./server/catalog-snapshot/immutable-cache.mjs';import{createCatalogHandler}from'./server/catalog-snapshot/handler.mjs';import{validateInlineScripts}from'./server/catalog-snapshot/response-policy.mjs';import{renderers}from${JSON.stringify(resolve(software, 'runtime/renderers-entry.mjs'))};const snapshot=${JSON.stringify(candidate)},bucket={async get(key){const r=await fetch('https://catalog-private.invalid/'+encodeURIComponent(key));if(r.status===404)return null;if(!r.ok)throw Error('Private metadata service failed');const bytes=await r.arrayBuffer();return{size:bytes.byteLength,arrayBuffer:async()=>bytes,json:async()=>JSON.parse(new TextDecoder().decode(bytes))}}};const metadata=immutableMetadataCache();export default{async fetch(request){const scoped=requestBucket({get:key=>metadata.get(bucket,key)}),handler=createCatalogHandler({bucket:scoped,capture:()=>openSnapshot(scoped,{provided:snapshot,allowFixture:true}),allowPrivateFixture:true,softwareRevision:${JSON.stringify(report.revision)},renderers,cache:caches.default,rendererSHA256:${JSON.stringify(report.abiSHA256)},validateHTML:html=>validateInlineScripts(html,${JSON.stringify(report.policy.inlineSHA256)})});return await handler(request)??new Response('Retained software fallback',{status:418})}}`,
      },
      write: false,
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      external: ['node:*'],
      loader: { '.css': 'text' },
      define: { 'import.meta.env.PROD': 'true', 'import.meta.env.DEV': 'false' },
      logLevel: 'silent',
    }),
    require = createRequire(import.meta.resolve('wrangler')),
    { Miniflare, convertV4MiniflareOptions } = require('miniflare');
  let reads = 0;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      workers: [
        {
          name: 'private-changed-content-test',
          script: code.outputFiles[0].text,
          modules: true,
          compatibilityDate: '2026-10-23',
          compatibilityFlags: [],
          outboundService: async (r) => {
            const u = new URL(r.url);
            if (u.origin !== 'https://catalog-private.invalid' || r.method !== 'GET')
              throw Error('Unexpected native outbound request');
            const key = decodeURIComponent(u.pathname.slice(1));
            if (
              !/^catalog\/objects\/(artworks|collections|search|recent|related|counts|sitemaps)\/[a-f0-9]{64}\.json$/.test(
                key,
              )
            )
              throw Error('Invalid metadata point read');
            let bytes = created.get(key);
            if (!bytes) {
              const o = await parentBucket.get(key);
              if (!o) return new Response(null, { status: 404 });
              bytes = Buffer.from(await o.arrayBuffer());
            }
            if (bytes.length > 1048576 || sha(bytes) !== key.split('/').at(-1).slice(0, -5))
              throw Error('Native metadata bytes changed');
            reads++;
            return new Response(bytes, { headers: { 'content-type': 'application/json' } });
          },
        },
      ],
    }),
  );
  const results = [],
    headers = { 'x-uc-catalog-protocol': 'snapshot-search-v1' },
    started = Date.now();
  try {
    for (const c of packet.changes)
      for (const kind of ['art', 'edit']) {
        const path = '/' + kind + '/' + c.id + '/',
          r = await mf.dispatchFetch('https://ultraclipart.com' + path, { headers }),
          html = await r.text();
        assert.equal(r.status, c.record ? 200 : 404, path + ' ' + r.headers.get('x-private-error'));
        if (c.record) {
          assert.equal(
            decode(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? ''),
            displayTitle(c.record.title),
            path,
          );
          assert(html.includes('https://ultraclipart.com' + path));
          assert(html.includes(c.record.webp));
          if (kind === 'art') assert(html.includes(c.record.pdf));
          assert(html.includes('name="build-revision" content="' + candidate.revision + '"'));
        }
        results.push({ path, status: r.status, sha256: sha(Buffer.from(html)) });
      }
    for (const c of packet.topicChanges) {
      const path = '/clipart/' + c.slug + '/',
        r = await mf.dispatchFetch('https://ultraclipart.com' + path, { headers }),
        html = await r.text();
      assert.equal(r.status, c.record ? 200 : 404, path + ' ' + r.headers.get('x-private-error'));
      if (c.record) {
        const schema = [
          ...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g),
        ]
          .map((m) => JSON.parse(m[1]))
          .find((x) => x['@type'] === 'CollectionPage');
        assert.equal(schema.description, c.record.summary);
        assert.equal(schema.mainEntity.numberOfItems, c.artworkIds.length);
        const ids = [...html.matchAll(/<article\b[^>]*data-id="([^"]+)"/g)].map((m) => m[1]);
        assert.deepEqual([...ids].sort(), [...c.artworkIds].sort());
        assert(!html.includes('{{artworkCount}}'));
        const panel =
          html.match(/<div[^>]*data-collection-summary[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '';
        const paragraphs = [...panel.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g)].map((m) =>
          decode(m[1]).replace(/\s+/g, ' '),
        );
        assert.deepEqual(
          paragraphs,
          c.record.paragraphs.map((p) =>
            p.replace('{{artworkCount}}', c.artworkIds.length.toLocaleString('en-US')),
          ),
          path + ' exact paragraphs',
        );
        const description =
          html.match(/<meta[^>]*name="description"[^>]*content="([^"]*)"/)?.[1] ?? '';
        assert.equal(
          decode(description),
          c.record.metaDescription,
          path + ' exact meta description',
        );
        assert(!/noindex/i.test(r.headers.get('x-robots-tag') ?? ''), path + ' indexability');
      }
      results.push({ path, status: r.status, sha256: sha(Buffer.from(html)) });
    }
    for (const path of [
      '/',
      '/new/',
      '/categories/',
      '/collections/',
      '/search/',
      '/create/',
      '/black-and-white/',
      '/catalog-stats.json?scope=visible',
      '/studio-featured.json',
      '/search-data/manifest.json',
      '/sitemap.xml',
      '/delivery-release.json',
      '/surprise-picks.json',
    ]) {
      const r = await mf.dispatchFetch('https://ultraclipart.com' + path, { headers }),
        body = await r.text();
      assert.equal(r.status, 200, path + ' ' + r.headers.get('x-private-error'));
      results.push({ path, status: r.status, sha256: sha(Buffer.from(body)) });
    }
    return {
      status: 'CHANGED_CONTENT_NATIVE_ROUTES_VERIFIED_NOT_PUBLISHED',
      revision: candidate.revision,
      candidateSHA256: sha(Buffer.from(JSON.stringify(candidate))),
      packetSHA256: sourcePacketSHA256,
      softwareABI: report.abiSHA256,
      routes: results,
      metadataPointReads: reads,
      seconds: (Date.now() - started) / 1000,
      fullCatalogPagesBuilt: 0,
      fullCatalogScans: 0,
      productionWrites: 0,
    };
  } finally {
    await mf.dispose();
  }
}
