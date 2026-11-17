import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildPublicArtworkRoutes } from '../../server/catalog-snapshot/public-artwork-routes.mjs';
import { readPresentationSurprisePicks as readSurprisePicks } from '../../scripts/catalog-snapshot/presentation.mjs';
import { readSurprisePicks as readRuntimeSurprisePicks } from '../../server/catalog-snapshot/surprise-picks.mjs';
import { artworkPath } from '../../src/lib/artwork-route.mjs';
test('Surprise preserves stable identities while using root-bound canonical URLs', async () => {
  const values = new Map(),
    put = async (x) => {
      const value = { schema: 1, ...x },
        body = Buffer.from(JSON.stringify(value)),
        sha256 = createHash('sha256').update(body).digest('hex'),
        d = { key: 'catalog/objects/artworks/' + sha256 + '.json', sha256, bytes: body.length };
      values.set(d.key, value);
      return d;
    },
    store = { put, get: async (d) => values.get(d.key) },
    id = 'dart-20261107-031',
    slug = 'smiling-amateur-darts-champion';
  const publicRoutes = await buildPublicArtworkRoutes(store, [{ id }], new Map([[id, slug]]));
  const surprise = await put({
    type: 'cute-discovery-projection',
    version: 3,
    artworksRootSHA256: 'a'.repeat(64),
    items: [
      {
        id,
        topic: 'dart',
        score: 94,
        sourceSHA256: 'b'.repeat(64),
        metadataSHA256: 'c'.repeat(64),
        fresh: true,
      },
    ],
  });
  const context = {
    snapshot: { indexes: { artworks: { sha256: 'a'.repeat(64) } } },
    getFacet: async (f) => (f === 'artworks' ? { publicRoutes } : { surprise }),
    read: async (f, d) => store.get(d),
  };
  const runtimePicks = await readRuntimeSurprisePicks(context);
  const presentationPicks = await readSurprisePicks(context);
  assert.deepEqual(
    runtimePicks,
    presentationPicks,
    'Dynamic Surprise and prebuilt presentation must expose the same canonical paths',
  );
  const [pick] = runtimePicks;
  assert.equal(pick.id, id);
  assert.equal(pick.publicSlug, slug);
  assert.equal(pick.fresh, true);
  assert.equal(artworkPath(pick), '/art/' + slug + '/');
  const publicRoutes2 = await buildPublicArtworkRoutes(
    store,
    [{ id }],
    new Map([[id, 'new-canonical-champion']]),
  );
  const context2 = {
    ...context,
    getFacet: async (f) => (f === 'artworks' ? { publicRoutes: publicRoutes2 } : { surprise }),
  };
  assert.equal((await readRuntimeSurprisePicks(context2))[0].publicSlug, 'new-canonical-champion');
  assert.equal(
    artworkPath((await readRuntimeSurprisePicks(context))[0]),
    '/art/' + slug + '/',
    'A route change must not leak into another pinned root',
  );
  assert.equal((await readSurprisePicks(context))[0].publicSlug, slug);
});
