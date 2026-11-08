import { mapGet, buildMap, patchMap } from '../catalog-search/store.mjs';
import { readableArtworkSlug } from '../../src/lib/artwork-route.mjs';
import { readArtwork } from './artwork-facet-reader.mjs';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const routeStore = (context) => ({
  get: (d) => context.read('artworks', d, { maxBytes: 65536 }),
});
export function validateRoutes(value) {
  if (
    value?.schema !== 1 ||
    value.type !== 'public-artwork-routes-v1' ||
    !value.byId ||
    !value.byPath ||
    !Number.isSafeInteger(value.artworks) ||
    value.artworks < 0
  )
    throw Error('Invalid source-bound public artwork routes');
  return value;
}
export async function publicRouteForId(context, id) {
  if (!SLUG.test(id ?? '')) throw Error('Invalid artwork identity');
  const root = await context.getFacet('artworks');
  if (!root.publicRoutes) return id;
  const routes = validateRoutes(await context.read('artworks', root.publicRoutes));
  const row = await mapGet(routeStore(context), routes.byId, 'public-artwork-ids', id);
  if (!row || row.id !== id || !SLUG.test(row.slug)) throw Error('Missing canonical artwork route');
  return row.slug;
}
export async function resolvePublicArtworkRoute(context, slug) {
  if (!SLUG.test(slug ?? '')) return undefined;
  const root = await context.getFacet('artworks');
  if (!root.publicRoutes) return { id: slug, slug };
  const routes = validateRoutes(await context.read('artworks', root.publicRoutes));
  const store = routeStore(context),
    row = await mapGet(store, routes.byPath, 'public-artwork-paths', slug);
  if (!row) return undefined;
  if (!SLUG.test(row.id) || !SLUG.test(row.slug)) throw Error('Wrong route identity');
  return { id: row.id, slug: row.slug };
}
export async function readPublicArtwork(context, id) {
  const item = await readArtwork(context, id);
  return item ? { ...item, publicSlug: await publicRouteForId(context, id) } : undefined;
}
export async function buildPublicArtworkRoutes(store, rows, assignments) {
  const ids = [],
    paths = [],
    used = new Map();
  for (const row of rows) {
    const slug = assignments.get(row.id) ?? row.id;
    if (!SLUG.test(row.id) || !SLUG.test(slug)) throw Error('Invalid route assignment');
    ids.push({ key: row.id, value: { id: row.id, slug } });
    for (const path of new Set([row.id, slug])) {
      if (used.has(path) && used.get(path) !== row.id) throw Error('Public URL collision');
      used.set(path, row.id);
    }
  }
  for (const [key, id] of used) paths.push({ key, value: { id, slug: assignments.get(id) ?? id } });
  return store.put({
    type: 'public-artwork-routes-v1',
    artworks: ids.length,
    byId: await buildMap(store, 'public-artwork-ids', ids),
    byPath: await buildMap(store, 'public-artwork-paths', paths),
  });
}
// Import-time allocation persists the first address. Later copy changes do not
// rename an indexed URL, and withdrawn IDs/aliases stay reserved.
export async function extendPublicArtworkRoutes(store, descriptor, records) {
  const prior = validateRoutes(await store.get(descriptor)),
    ids = new Map(),
    paths = new Map();
  const taken = async (path) =>
    paths.get(path) ?? (await mapGet(store, prior.byPath, 'public-artwork-paths', path));
  for (const record of records) {
    if (!record || !SLUG.test(record.id)) throw Error('Invalid incoming artwork route');
    const old = await mapGet(store, prior.byId, 'public-artwork-ids', record.id);
    if (old) continue;
    const slug = readableArtworkSlug(record.title);
    const collision = await taken(slug);
    if (collision && collision.id !== record.id)
      throw Error('Readable artwork URL collision: review an image-specific distinguishing title; automatic numeric suffixes are forbidden');
    const legacy = await taken(record.id);
    if (legacy && legacy.id !== record.id) throw Error('Incoming ID conflicts with a reserved URL');
    ids.set(record.id, { id: record.id, slug });
    paths.set(slug, { id: record.id, slug });
    paths.set(record.id, { id: record.id, slug });
  }
  return store.put({
    ...prior,
    artworks: prior.artworks + ids.size,
    byId: await patchMap(store, prior.byId, 'public-artwork-ids', ids),
    byPath: await patchMap(store, prior.byPath, 'public-artwork-paths', paths),
  });
}
