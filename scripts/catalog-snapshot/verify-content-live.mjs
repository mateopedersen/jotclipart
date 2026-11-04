import { displayTitle } from '../../src/lib/display-title.ts';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { verifyIncomingMedia } from './batch-media.mjs';
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
export async function verifyContentLive({ directory, packet, sealed, progress = () => {} }) {
  const root = sealed.verifiedRoot,
    revision = sealed.snapshot.revision,
    headers = { 'x-uc-catalog-protocol': 'snapshot-search-v1' },
    rows = [];
  async function get(path) {
    let last;
    for (let i = 0; i < 3; i++)
      try {
        const r = await fetch('https://ultraclipart.com' + path, {
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
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (cursor < targets.length) {
        const t = targets[cursor++],
          { r, text } = await get(t.path);
        assert.equal(r.status, t.removed ? 404 : 200, t.path);
        if (!t.removed) {
          assert.equal(r.headers.get('x-uc-snapshot'), root, t.path);
          assert(text.includes('name="build-revision" content="' + revision + '"'));
          assert(text.includes('https://ultraclipart.com' + t.path));
          if (t.art) {
            assert.equal(clean(text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? ''), displayTitle(t.art.title));
            assert(text.includes(t.art.webp));
            if (t.path.startsWith('/art/')) assert(text.includes(t.art.pdf));
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
          path: t.path,
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
  const media = await verifyIncomingMedia(packet.incomingMediaManifest, { progress }),
    after = await get('/delivery-release.json');
  assert.equal(JSON.parse(after.text).verifiedRoot, root);
  const receipt = {
    status: 'CHANGED_PUBLIC_PAGES_AND_ORIGINAL_MEDIA_VERIFIED',
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
