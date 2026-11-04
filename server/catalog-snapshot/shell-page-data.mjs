import { examples as aiExamples, visualStyleReferences as aiStyles } from '../../src/ai/ideas.ts';
import { readShellField } from '../catalog-projections/shell.mjs';
import { readSurprisePicks } from './surprise-picks.mjs';
import { readStudioFeaturedCount } from './studio-featured-count.mjs';
// Snapshot-only inputs for existing catalog shells; no full artwork catalog.
import { readArtwork } from './artwork-facet-reader.mjs';
import { readSharedArtwork } from './shared-artwork-context.mjs';
import { openSevenFacetCollectionContext } from './collection-context.mjs';
import { newestIDs, recentSubjectIDs } from './recent-ledger.mjs';
import { openSearch } from '../catalog-search/runtime.mjs';
import { makeStore } from '../catalog-search/store.mjs';
import { uiProviders } from '../catalog-search/ui-metadata.mjs';
import { latestSubjectCollections } from '../../src/lib/collection-discovery.ts';
import { defaults } from '../../src/lib/search.ts';
import {
  curatedBySlug,
  withCuratedCollectionCounts,
  reviewedCoverIDs,
  resolveReviewedCover,
  coverTone,
  reviewedPrimaryCopy,
} from '../../src/lib/curated-collection-policy.mjs';
import { readCuratedViews, readCuratedGallery } from './curated-collections.mjs';
export async function readShellPageState(
  bucket,
  context,
  kind,
  { cluster, allowFixture = false, dataOnly = false } = {},
) {
  const cc = await openSevenFacetCollectionContext(bucket, {
      snapshot: context.snapshot,
      allowUnpublishableFixture: allowFixture,
    }),
    descriptor = cc.collections.shells;
  if (!descriptor) throw Error('Discovery context unavailable');
  const root = await context.read('collections', descriptor, { maxBytes: 65536 });
  if (root.schema !== 1 || root.type !== 'discovery-shell-directory' || !root.fields)
    throw Error('Invalid discovery context');
  const field = (name) => readShellField(context, root, name);
  const [features, staticIds, clusters] = await Promise.all([
      dataOnly ? { surprise: [], ids: [], artworks: [] } : cc.read(cc.root.features, 256 * 1024),
      dataOnly ? [] : field('staticIds', 128),
      field('clusters', 128),
    ]),
    byId = new Map(),
    sharedPromise = readSharedArtwork(context, features),
    surprisePromise = dataOnly
      ? Promise.resolve([])
      : cc.collections.surprise
        ? readSurprisePicks(context, { limit: 48 })
        : Promise.resolve(
            features.surprise.map((p) => ({
              id: p.id,
              topic: p.topic,
              ...(Object.hasOwn(p, 'fresh') ? { fresh: p.fresh } : {}),
            })),
          ),
    recentPromise = context.getFacet('recent');
  async function artwork(ids) {
    if (ids.length > 1500 || new Set(ids).size !== ids.length)
      throw Error('Invalid shell artwork keys');
    let cursor = 0;
    const rows = Array(ids.length);
    await Promise.all(
      Array.from({ length: Math.min(4, ids.length) }, async () => {
        while (cursor < ids.length) {
          const i = cursor++,
            id = ids[i],
            a = byId.get(id) ?? (await readArtwork(context, id));
          if (!a?.published || !a.indexable) throw Error('Shell references missing artwork');
          byId.set(id, a);
          rows[i] = a;
        }
      }),
    );
    return rows;
  }
  const [staticArt, shared, surprise, recent] = await Promise.all([
    artwork(staticIds),
    sharedPromise,
    surprisePromise,
    recentPromise,
  ]);
  for (const item of shared) byId.set(item.id, item);
  const state = {
    art: staticArt,
    topics: [],
    clusters,
    counts: { ...cc.global, topics: {} },
    surprise,
    summaries: new Map(),
    paragraphs: new Map(),
    copy: {},
    relations: {},
    clusterNames: {},
    newestArt: [],
    blackAndWhiteArt: [],
    props: {},
    searchManifest: { version: context.rootSHA256 },
  };
  const rs = { get: (d) => context.read('recent', d, { maxBytes: 65536 }) };
  if (recent.type !== 'recent-directory') throw Error('Invalid recent root');
  if (kind === 'new') {
    state.newestArt = await artwork(await newestIDs(rs, recent.ledger, { limit: 32 }));
    state.props.snapshotTotal = cc.global.totals.artworks;
  }
  if (kind === 'search' || kind === 'monochrome') {
    const engine = await openSearch(bucket, context.snapshot.indexes.search, {
        allowPrivateFixture: allowFixture,
      }),
      data = {
        engine,
        manifest: engine.manifest,
        store: makeStore(bucket, { cacheLimit: 64, maxReads: 4000, maxBytes: 64 * 1024 * 1024 }),
      },
      ctx = { snapshotSha256: context.rootSHA256 },
      found = await engine.search(
        kind === 'monochrome' ? { ...defaults, sort: 'newest', size: 24 } : defaults,
        kind === 'monochrome' ? ['print/monochrome'] : [],
      ),
      full = await artwork(found.items.map((a) => a.id));
    if (kind === 'search') {
      const [topics, colors, styles] = await Promise.all([
        field('topics'),
        field('colors', 128),
        field('styles', 128),
      ]);
      state.topics = topics;
      state.props.snapshotSearch = {
        version: context.rootSHA256,
        result: { ...found, items: full },
        colors,
        styles,
      };
    } else {
      state.monochromeDirectory = (await uiProviders.readMonochromeDirectory(ctx, data)).value;
      if (state.monochromeDirectory.total !== cc.global.totals.printable)
        throw Error('Monochrome totals differ');
      state.newestArt = full;
      state.blackAndWhiteArt = full;
    }
  }
  if (['categories', 'collections', 'library', 'cluster'].includes(kind)) {
    const [subjects, groups, topics, counts] = await Promise.all([
      field('subjects'),
      field('clustersData', 128),
      field('topics'),
      cc.allLegacyCounts(),
    ]);
    state.counts = counts;
    state.topics = topics;
    state.clusterNames = Object.fromEntries(topics.map((t) => [t.slug, [t.cluster]]));
    const visibleSubjects = kind === 'categories' ? subjects.slice(0, 12) : [];
    const heroSubjects =
      kind === 'categories'
        ? subjects.filter((t) => ['fox', 'strawberry', 'school', 'butterfly'].includes(t.slug))
        : [];
    const ids = dataOnly
      ? []
      : [
          ...new Set([
            ...visibleSubjects.map((t) => t.sampleId),
            ...heroSubjects.map((t) => t.sampleId),
            ...(kind === 'categories'
              ? groups.flatMap((g) => g.previewIds.slice(0, 1))
              : kind === 'collections'
                ? groups.flatMap((g) => g.previewIds)
                : []),
          ]),
        ];
    await artwork(ids);
    state.categorySubjects = subjects.map(({ sampleId, ...t }) => {
      if (t.count !== counts.topics[t.slug]) throw Error('Stale discovery topic count');
      return { ...t, sampleId, sample: byId.get(sampleId) };
    });
    const bySlug = new Map(state.categorySubjects.map((t) => [t.slug, t]));
    state.categoryCollections = groups.map(({ subjectSlugs, previewIds, ...g }) => {
      if (g.count !== counts.collections[g.slug]?.artworks)
        throw Error('Stale discovery cluster count');
      return {
        ...g,
        subjects: subjectSlugs.map((slug) => {
          const t = bySlug.get(slug);
          if (!t) throw Error('Missing subject');
          return t;
        }),
        previews: previewIds.map((id) => byId.get(id)),
      };
    });
    if (kind === 'collections') {
      const latest = await artwork(await recentSubjectIDs(rs, recent.ledger, 8));
      const items = latestSubjectCollections(state.categorySubjects, latest);
      state.latestCollections = items.map((item) => ({
        ...item,
        artwork: byId.get(item.latestArtworkId),
      }));
      state.collectionFeed = { version: context.rootSHA256, items };
    }
    if (kind === 'collections' || kind === 'cluster') {
      const group = curatedBySlug.get(cluster);
      state.counts = withCuratedCollectionCounts(counts);
      state.curatedCollections = await readCuratedViews({
        cc,
        counts,
        topics,
        subjects: state.categorySubjects,
        artwork,
        byId,
        ...(kind === 'cluster' ? { selectedSlug: group?.slug ?? '__primary__' } : {}),
      });
      const primary =
        kind === 'collections'
          ? state.categoryCollections
          : state.categoryCollections.filter((g) => g.cluster === cluster);
      await artwork([...new Set(primary.flatMap((g) => reviewedCoverIDs(g.slug)))]);
      for (const g of primary) {
        g.previews = resolveReviewedCover(g.slug, byId) ?? g.previews;
        g.tone = coverTone(g.slug);
        Object.assign(g, reviewedPrimaryCopy(g.slug));
      }
      if (kind === 'cluster') {
        if (group) {
          const current = state.curatedCollections[0];
          if (!current) return undefined;
          current.items = await readCuratedGallery({ group, cc, counts, artwork });
          state.art = [
            ...current.items,
            ...staticArt.filter((a) => !current.items.some((b) => b.id === a.id)),
          ];
          state.props = { cluster: group.title, collectionSlug: group.slug };
        } else {
          const picks = (await field('clusterPicks', 128)).find((p) => p.cluster === cluster);
          if (!picks) return undefined;
          state.art = [
            ...(await artwork(picks.ids)),
            ...staticArt.filter((a) => !picks.ids.includes(a.id)),
          ];
          state.props = {
            cluster,
            collectionSlug: cluster
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-|-$/g, ''),
          };
        }
      }
    }
    if (kind === 'library')
      state.directoryArtwork = await artwork(await field('directoryIds', 1000));
  }
  if (kind === 'ai')
    state.art = [
      ...(await artwork([...new Set([...aiExamples, ...aiStyles].map((a) => a.artwork))])),
      ...staticArt.filter((a) => ![...aiExamples, ...aiStyles].some((ref) => ref.artwork === a.id)),
    ];
  if (kind === 'create') {
    state.featuredStudioCount = await readStudioFeaturedCount(
      context,
      cc.collections.studioFeatured,
    );
    state.featuredStudioArt = [];
    state.studioCompositionPreviews = await field('studioCompositionPreviews', 128);
  }
  return state;
}
