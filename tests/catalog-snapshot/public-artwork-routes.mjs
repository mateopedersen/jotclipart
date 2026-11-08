import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  buildPublicArtworkRoutes,
  publicRouteForId,
  resolvePublicArtworkRoute,
  extendPublicArtworkRoutes,
} from '../../server/catalog-snapshot/public-artwork-routes.mjs';
import { artworkPath, readableArtworkSlug, needsReadableArtworkSlug } from '../../src/lib/artwork-route.mjs';
function memory() {
  const values = new Map();
  return {
    get: async (d) => structuredClone(values.get(d.key)),
    put: async (x) => {
      const v = { schema: 1, ...x },
        b = Buffer.from(JSON.stringify(v)),
        sha256 = createHash('sha256').update(b).digest('hex'),
        d = { key: `catalog/objects/artworks/${sha256}.json`, sha256, bytes: b.length };
      values.set(d.key, v);
      return d;
    },
  };
}
const ctx = (store, d) => ({
  getFacet: async () => ({ publicRoutes: d }),
  read: async (f, d) => {
    assert.equal(f, 'artworks');
    return store.get(d);
  },
});
test('readable routes preserve immutable IDs and give legacy and canonical paths one target', async () => {
  const store = memory(),
    d = await buildPublicArtworkRoutes(
      store,
      [{ id: 'futsal-20261107-002' }, { id: 'pumpkin-hot-air-balloon' }],
      new Map([['futsal-20261107-002', 'rubber-soled-futsal-shoes']]),
    ),
    context = ctx(store, d);
  assert.equal(await publicRouteForId(context, 'futsal-20261107-002'), 'rubber-soled-futsal-shoes');
  for (const slug of ['futsal-20261107-002', 'rubber-soled-futsal-shoes'])
    assert.deepEqual(await resolvePublicArtworkRoute(context, slug), {
      id: 'futsal-20261107-002',
      slug: 'rubber-soled-futsal-shoes',
    });
  assert.equal(await resolvePublicArtworkRoute(context, 'missing'), undefined);
  assert.equal(artworkPath({ id: 'stable', publicSlug: 'new-address' }), '/art/new-address/');
  await assert.rejects(
    buildPublicArtworkRoutes(
      store,
      [{ id: 'first' }, { id: 'second' }],
      new Map([['first', 'second']]),
    ),
    /collision/,
  );
});
test('future imports reject artificial numeric disambiguation, and copy edits never rename URLs', async () => {
  const store = memory(),
    first = await buildPublicArtworkRoutes(
      store,
      [{ id: 'existing' }],
      new Map([['existing', 'red-balloon']]),
    );
  await assert.rejects(extendPublicArtworkRoutes(store, first, [
    { id: 'new-20261108-001', title: 'Red Balloon Clipart' },
  ]), /automatic numeric suffixes are forbidden/);
  const second = await extendPublicArtworkRoutes(store, first, [
    { id: 'new-20261108-001', title: 'Red Heart Shaped Balloon' },
  ]);
  assert.equal(await publicRouteForId(ctx(store, second), 'new-20261108-001'), 'red-heart-shaped-balloon');
  const third = await extendPublicArtworkRoutes(store, second, [
    { id: 'new-20261108-001', title: 'Corrected Source Caption' },
  ]);
  assert.equal(await publicRouteForId(ctx(store, third), 'new-20261108-001'), 'red-heart-shaped-balloon');
  await assert.rejects(
    extendPublicArtworkRoutes(store, third, [{ id: 'red-balloon', title: 'Other Image' }]),
    /reserved/,
  );
  assert.equal(
    readableArtworkSlug('Blue & Gold Aircraft Concept'),
    'blue-and-gold-aircraft-concept',
  );
  assert.equal(readableArtworkSlug('Very '.repeat(80)).endsWith('very'), true);
  for (const title of ['Airbus A380 In Flight', 'B-2 Spirit', 'Number 100'])
    assert.match(readableArtworkSlug(title), /\d/, 'Meaningful subject/model numbers remain');
  await assert.rejects(extendPublicArtworkRoutes(store, first, [
    { id: 'first-new', title: 'Blue Balloon' },
    { id: 'second-new', title: 'Blue Balloon' },
  ]), /collision/, 'Two records in the same atomic import cannot silently gain numeric suffixes');
});

test('migration changes machine-only suffixes and preserves already descriptive URLs',()=>{
 for(const [id,topic] of [['futsal-20261107-002','futsal'],['walmart-20261104-004','walmart'],['007-001','007'],['80s-01','80s']])assert.equal(needsReadableArtworkSlug(id,topic),true,id);
 for(const [id,topic] of [['pumpkin-hot-air-balloon','pumpkin'],['andorra-flag-clipart-001-flat-sewn-national-flag','andorra-flag'],['boeing-747-in-flight','boeing'],['futsal-20261107-002-red-shoes','futsal'],['number-100-school-celebration','100']])assert.equal(needsReadableArtworkSlug(id,topic),false,id);
});
