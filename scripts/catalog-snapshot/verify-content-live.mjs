import { displayTitle, displayArtworkTitle } from '../../src/lib/display-title.ts';
import { brand, publicBrandURL } from '../../src/lib/brand.mjs';
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { verifyIncomingMedia, catalogPublicOrigin } from './batch-media.mjs';
import { verifyRecentDiscovery } from './publication-date.mjs';
const clean = (s) =>
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
export function verifiedLiveArtworkRedirects(directory, packet, sealed) {
  const hash = (b) => createHash('sha256').update(b).digest('hex');
  const graphBytes = readFileSync(join(directory, 'graph-verified-receipt.json'));
  assert.equal(
    hash(graphBytes),
    sealed.snapshot.authorization.graphReceiptSHA256,
    'Signed source graph receipt changed',
  );
  const graph = JSON.parse(graphBytes),
    nativeBytes = readFileSync(join(directory, 'native-integration-report.json'));
  assert.equal(
    hash(nativeBytes),
    graph.nativeIntegrationSHA256,
    'Authenticated native route proof changed',
  );
  const native = JSON.parse(nativeBytes),
    packetBytes = readFileSync(join(directory, 'packet.json'));
  assert.deepEqual(JSON.parse(packetBytes), packet);
  assert.equal(native.packetSHA256, hash(packetBytes));
  assert.equal(native.revision, sealed.snapshot.revision);
  assert.equal(native.softwareABI, sealed.snapshot.authorization.abiSHA256);
  assert.equal(native.productionWrites, 0);
  const aliases = new Map();
  for (const row of native.routes.filter(
    (r) => r.source === 'changed-artwork-stable-id-redirect',
  )) {
    assert.equal(row.status, 301);
    assert(!aliases.has(row.path));
    const url = new URL(row.expectedLocation);
    assert.equal(url.origin, brand.origin);
    assert(!url.search && !url.hash && /^\/art\/[a-z0-9][a-z0-9-]*\/$/.test(url.pathname));
    aliases.set(row.path, row.expectedLocation);
  }
  return aliases;
}
export async function verifyContentLive({
  directory,
  packet,
  sealed,
  progress = () => {},
  publicOrigin = brand.origin,
  fetcher = fetch,
}) {
  const origin = catalogPublicOrigin(publicOrigin);
  const root = sealed.verifiedRoot,
    revision = sealed.snapshot.revision,
    headers = { 'x-uc-catalog-protocol': 'snapshot-search-v1' },
    rows = [];
  async function get(path) {
    let last;
    for (let i = 0; i < 3; i++)
      try {
        const r = await fetcher(origin + path, {
            headers,
            redirect: 'manual',
            signal: AbortSignal.timeout(90000),
          }),
          text = await r.text();
        return { r, text };
      } catch (e) {
        last = e;
      }
    throw last;
  }
  const control = await get('/delivery-release.json');
  assert.equal(control.r.status, 200);
  assert.equal(JSON.parse(control.text).verifiedRoot, root);
  assert.equal(JSON.parse(control.text).renderedRevision, revision);
  const targets = packet.changes
    .flatMap((c) =>
      ['art', 'edit'].map((kind) => ({
        path: `/${kind}/${c.id}/`,
        kind,
        art: c.record,
        removed: c.record === null,
      })),
    )
    .concat(
      packet.topicChanges.map((c) => ({
        path: `/clipart/${c.slug}/`,
        topic: c.record,
        ids: c.artworkIds,
        removed: c.record === null,
      })),
    );
  let cursor = 0;
  let redirects;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (cursor < targets.length) {
        const t = targets[cursor++];
        let path = t.path,
          { r, text } = await get(path);
        if (!t.removed && t.kind === 'art' && r.status === 301) {
          redirects ??= verifiedLiveArtworkRedirects(directory, packet, sealed);
          const expected = redirects.get(path);
          assert(expected, 'Authenticated canonical target required for ' + path);
          assert.equal(
            r.headers.get('location'),
            expected,
            'Live stable ID redirected to an unexpected artwork',
          );
          rows.push({
            path,
            status: 301,
            expectedLocation: expected,
            source: 'authenticated-stable-id-redirect',
          });
          path = new URL(expected).pathname;
          ({ r, text } = await get(path));
        }
        assert.equal(r.status, t.removed ? 404 : 200, path);
        if (!t.removed) {
          assert.equal(r.headers.get('x-uc-snapshot'), root, t.path);
          assert(text.includes('name="build-revision" content="' + revision + '"'));
          assert(text.includes(brand.origin + path));
          if (t.art) {
            const title = t.path.startsWith('/art/') ? displayArtworkTitle : displayTitle;
            assert.equal(
              clean(text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? ''),
              title(t.art.title),
            );
            assert(text.includes(publicBrandURL(t.art.webp)));
            if (t.path.startsWith('/art/')) assert(text.includes(publicBrandURL(t.art.pdf)));
          }
          if (t.topic) {
            const schema = [
              ...text.matchAll(
                /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g,
              ),
            ]
              .map((m) => JSON.parse(m[1]))
              .find((s) => s['@type'] === 'CollectionPage');
            assert.equal(schema.description, t.topic.summary);
            assert.equal(schema.mainEntity.numberOfItems, t.ids.length);
            assert.deepEqual(
              [...text.matchAll(/<article\b[^>]*data-id="([^"]+)"/g)].map((m) => m[1]).sort(),
              [...t.ids].sort(),
            );
          }
        }
        rows.push({
          path,
          status: r.status,
          sha256: createHash('sha256').update(text).digest('hex'),
        });
        progress({
          phase: 'changed-public-pages-verified',
          verified: rows.length,
          total: targets.length,
        });
      }
    }),
  );
  if (packet.publicationStartedAt) {
    for (const path of ['/', '/new/']) {
      const { r, text } = await get(path);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('x-uc-snapshot'), root, path);
      verifyRecentDiscovery(text, path, packet);
      rows.push({
        path,
        status: r.status,
        sha256: createHash('sha256').update(text).digest('hex'),
      });
    }
  }
  const media = await verifyIncomingMedia(packet.incomingMediaManifest, {
      progress,
      publicOrigin: origin,
      fetcher,
    }),
    after = await get('/delivery-release.json');
  assert.equal(JSON.parse(after.text).verifiedRoot, root);
  const receipt = {
    status: 'CHANGED_PUBLIC_PAGES_AND_ORIGINAL_MEDIA_VERIFIED',
    publicOrigin: origin,
    revision,
    verifiedRoot: root,
    pages: rows,
    media,
    at: new Date().toISOString(),
    oldCatalogPagesRescanned: 0,
  };
  writeFileSync(join(directory, 'live-verification.json'), JSON.stringify(receipt, null, 2));
  return receipt;
}
