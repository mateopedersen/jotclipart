import { readSurprisePicks } from './surprise-picks.mjs';
// Private bounded home view. Incremental recent selection is a writer concern.
import { readPublicArtwork as readArtwork } from './public-artwork-routes.mjs';
import { openSevenFacetCollectionContext } from './collection-context.mjs';
const valid = (x) => typeof x === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(x);
export async function readHomePageState(bucket, context, { allowFixture = false } = {}) {
  const [recent, collections] = await Promise.all([
    context.getFacet('recent'),
    openSevenFacetCollectionContext(bucket, {
      snapshot: context.snapshot,
      allowUnpublishableFixture: allowFixture,
    }),
  ]);
  if (recent.schema !== 1 || recent.type !== 'recent-directory')
    throw Error('Invalid recent facet');
  const home = await context.read('recent', recent.home, { maxBytes: 65536 });
  if (
    home.schema !== 1 ||
    home.type !== 'home-context' ||
    !Array.isArray(home.staticIds) ||
    home.staticIds.length > 128 ||
    !Array.isArray(home.recentIds) ||
    home.recentIds.length > 15 ||
    [...home.staticIds, ...home.recentIds].some((x) => !valid(x)) ||
    new Set(home.staticIds).size !== home.staticIds.length ||
    new Set(home.recentIds).size !== home.recentIds.length ||
    !Array.isArray(home.clusters) ||
    home.clusters.length > 128
  )
    throw Error('Invalid home context');
  const ids = [...new Set([...home.staticIds, ...home.recentIds])],
    art = [];
  let cursor = 0;
  const output = Array(ids.length);
  await Promise.all(
    Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (cursor < ids.length) {
        const i = cursor++,
          item = await readArtwork(context, ids[i]);
        if (!item) throw Error('Missing homepage artwork');
        output[i] = item;
      }
    }),
  );
  art.push(...output);
  const byId = new Map(art.map((x) => [x.id, x])),
    slugs = [...new Set(art.map((x) => x.topic))],
    records = [];
  cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, slugs.length) }, async () => {
      while (cursor < slugs.length) {
        const index = cursor++,
          slug = slugs[index],
          d = await collections.lookupCollection(slug);
        if (!d) throw Error('Missing homepage collection');
        const record = await collections.read(d, 256 * 1024);
        if (record.slug !== slug || !Array.isArray(record.clusters))
          throw Error('Wrong homepage topic');
        records[index] = record;
      }
    }),
  );
  const features = await collections.read(collections.root.features, 256 * 1024);
  if (!Array.isArray(features.surprise)) throw Error('Invalid home discovery context');
  return {
    art,
    homeRecent: home.recentIds.map((id) => byId.get(id)),
    topics: records.map((r) => ({
      slug: r.slug,
      keyword: r.keyword,
      cluster: r.primaryCluster,
      sourceCluster: r.sourceCluster,
    })),
    counts: { ...collections.global, topics: {} },
    surprise: collections.collections.surprise
      ? await readSurprisePicks(context, { limit: 48 })
      : features.surprise.map((p) => ({
          id: p.id,
          topic: p.topic,
          ...(Object.hasOwn(p, 'fresh') ? { fresh: p.fresh } : {}),
        })),
    clusters: home.clusters,
    summaries: new Map(),
    paragraphs: new Map(),
    copy: {},
    relations: {},
    clusterNames: Object.fromEntries(records.map((r) => [r.slug, r.clusters.map((c) => c.name)])),
  };
}
