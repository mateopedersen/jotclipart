import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { missedLegacyRoute } from '../../scripts/catalog-snapshot/build-url-repair.mjs';
import { needsReadableArtworkSlug } from '../../src/lib/artwork-route.mjs';
import {
  buildPublicArtworkRoutes,
  extendPublicArtworkRoutes,
  publicRouteForId,
  resolvePublicArtworkRoute,
} from '../../server/catalog-snapshot/public-artwork-routes.mjs';
const cases = [
  ['300-012', '300-movie', '300', 'Woman In A Flowing Ivory Gown', 'woman-in-a-flowing-ivory-gown'],
  [
    'powerpoint-001',
    'presentation',
    'powerpoint',
    'Woman Arranging Presentation Cards',
    'woman-arranging-presentation-cards',
  ],
  [
    'tesla-brand-001',
    'tesla',
    'tesla-brand',
    'Tesla Battery Pack Cutaway',
    'tesla-battery-pack-cutaway',
  ],
];
function memory() {
  const data = new Map();
  return {
    get: async (d) => structuredClone(data.get(d.key)),
    put: async (x) => {
      const value = { schema: 1, ...x },
        b = Buffer.from(JSON.stringify(value)),
        sha256 = createHash('sha256').update(b).digest('hex'),
        d = { key: 'catalog/objects/artworks/' + sha256 + '.json', bytes: b.length, sha256 };
      data.set(d.key, value);
      return d;
    },
  };
}
const context = (store, d) => ({
  getFacet: async () => ({ publicRoutes: d }),
  read: async (f, d) => {
    assert.equal(f, 'artworks');
    return store.get(d);
  },
});
for (const [id, topic, historicalTopicPrefix, title, slug] of cases) {
  test('renamed topic regression: ' + id, () => {
    assert.equal(
      needsReadableArtworkSlug(id, topic),
      false,
      'Frozen old matcher reproduces actual missed route',
    );
    assert.equal(missedLegacyRoute({ id, oldSlug: id, topic, historicalTopicPrefix }), true);
    assert.equal(
      missedLegacyRoute({ id, oldSlug: slug, topic, historicalTopicPrefix }),
      false,
      'Never migrate the already descriptive address',
    );
  });
  test('future import uses title independently of topic or package ID: ' + id, async () => {
    const store = memory(),
      empty = await buildPublicArtworkRoutes(store, [], new Map()),
      first = await extendPublicArtworkRoutes(store, empty, [{ id, topic, title }]),
      ctx = context(store, first);
    assert.equal(await publicRouteForId(ctx, id), slug);
    assert.deepEqual(await resolvePublicArtworkRoute(ctx, id), { id, slug });
    assert.deepEqual(await resolvePublicArtworkRoute(ctx, slug), { id, slug });
    const corrected = await extendPublicArtworkRoutes(store, first, [
      { id, topic: topic + '-renamed', title: 'Later Caption Correction' },
    ]);
    assert.equal(await publicRouteForId(context(store, corrected), id), slug);
  });
}
test('descriptive scene and meaningful numeric subjects are never selected as bare topic serials', () => {
  for (const [id, topic, prefix] of [
    ['airbus-a380-in-flight', 'airbus-aircraft', 'airbus'],
    ['number-100-school-celebration', '100', 'number'],
    ['election-day-america-checkmark-mosaic-cartoon-078', 'election-day', 'election-day'],
    [
      'election-day-america-checkmark-mosaic-cartoon-078',
      'election-day',
      'election-day-america-checkmark-mosaic-cartoon',
    ],
    ['andorra-flag-clipart-001-flat-sewn-national-flag', 'andorra-flag', 'andorra-flag'],
    ['blue-glass-number-20', '20', '20'],
  ])
    assert.equal(
      missedLegacyRoute({ id, oldSlug: id, topic, historicalTopicPrefix: prefix }),
      false,
      id,
    );
});
test('a collision fails atomically instead of assigning a package number or -2 URL', async () => {
  const store = memory(),
    empty = await buildPublicArtworkRoutes(store, [], new Map()),
    first = await extendPublicArtworkRoutes(store, empty, [
      { id: 'accepted-001', title: 'Tesla Battery Pack Cutaway' },
    ]);
  await assert.rejects(
    extendPublicArtworkRoutes(store, first, [
      { id: 'tesla-brand-001', topic: 'tesla', title: 'Tesla Battery Pack Cutaway' },
    ]),
    /collision/,
  );
  assert.equal(
    await publicRouteForId(context(store, first), 'accepted-001'),
    'tesla-battery-pack-cutaway',
  );
  assert.equal(
    await resolvePublicArtworkRoute(context(store, first), 'tesla-brand-001'),
    undefined,
  );
});
