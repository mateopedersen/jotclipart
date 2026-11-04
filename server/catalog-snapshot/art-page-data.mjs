import { readSurprisePicks } from './surprise-picks.mjs';
import { readArtwork } from './artwork-facet-reader.mjs';
import { readBoundedRelated } from './related-bounded-reader.mjs';
import { lookupHashedRecord } from './hashed-record-directory.mjs';
import { readSharedArtwork } from './shared-artwork-context.mjs';
import { openSevenFacetCollectionContext } from './collection-context.mjs';

// All branches resolve from this one captured snapshot. Only independent reads
// overlap; the existing request bucket still enforces its network/read budget.
export async function readArtworkPageState(bucket, context, id, { allowFixture = false } = {}) {
  const [item, collections] = await Promise.all([
    readArtwork(context, id),
    openSevenFacetCollectionContext(bucket, {
      snapshot: context.snapshot,
      allowUnpublishableFixture: allowFixture,
    }),
  ]);
  if (!item) return undefined;
  const ownRecord = async () => {
    const ownEntry = await collections.lookupCollection(item.topic);
    if (!ownEntry) throw Error('Artwork collection missing');
    const record = await collections.read(ownEntry, 256 * 1024);
    if (record.slug !== item.topic) throw Error('Wrong artwork collection');
    return record;
  };
  const sharedState = async () => {
    const features = await collections.read(collections.root.features, 256 * 1024);
    if (
      !Array.isArray(features.artworks) ||
      !Array.isArray(features.surprise) ||
      features.artworks.length > 500 ||
      features.surprise.length > 500
    )
      throw Error('Invalid shared page context');
    return Promise.all([
      collections.collections.surprise
        ? readSurprisePicks(context, { limit: 48 })
        : features.surprise.map((p) => ({
            id: p.id,
            topic: p.topic,
            ...(Object.hasOwn(p, 'fresh') ? { fresh: p.fresh } : {}),
          })),
      readSharedArtwork(context, features),
    ]);
  };
  const relatedState = async () => {
    const related = await readBoundedRelated(context, id, {
      hasTopic: async (slug) => !!(await collections.lookupCollection(slug)),
      topicFor: async (slug) => {
        const descriptor = await collections.lookupCollection(slug);
        return descriptor ? collections.read(descriptor, 256 * 1024) : undefined;
      },
    });
    const category = /^\/clipart\/([a-z0-9-]+)\/$/.exec(related.category)?.[1];
    if (!category) throw Error('Invalid collection preview route');
    const previewRows = async () => {
      const descriptor = await lookupHashedRecord(
        context,
        'collections',
        collections.collections.catalogPreviewDirectory,
        category,
      );
      if (!descriptor) throw Error('Collection preview missing');
      const roster = await context.read('collections', descriptor, { maxBytes: 256 * 1024 });
      if (
        roster.schema !== 1 ||
        roster.type !== 'catalog-order-preview' ||
        roster.topic !== category ||
        !Array.isArray(roster.ids) ||
        roster.ids.length > 4096 ||
        new Set(roster.ids).size !== roster.ids.length
      )
        throw Error('Invalid collection preview');
      const others = roster.ids.filter((x) => x !== item.id),
        choices = others.length ? others : roster.ids;
      const ids =
        choices.length <= 3
          ? choices
          : [
              choices[0],
              choices[Math.floor(choices.length / 3)],
              choices[Math.floor((2 * choices.length) / 3)],
            ];
      return Promise.all(
        ids.map(async (target) => {
          const artwork = await readArtwork(context, target);
          if (!artwork || artwork.topic !== category)
            throw Error('Preview references wrong collection');
          return artwork;
        }),
      );
    };
    const [previews, counts] = await Promise.all([
      previewRows(),
      collections.countsFor([item.topic, category], { strict: true }),
    ]);
    return { related, category, previews, counts };
  };
  const [record, [surprise, shared], { related, category, previews, counts }] = await Promise.all([
    ownRecord(),
    sharedState(),
    relatedState(),
  ]);
  const topic = {
    slug: record.slug,
    keyword: record.keyword,
    cluster: record.primaryCluster,
    sourceCluster: record.sourceCluster,
  };
  return {
    item,
    related,
    collectionPreview: (slug, sourceId) => {
      if (slug !== category || sourceId !== item.id) throw Error('Wrong preview source');
      return previews;
    },
    art: [item, ...shared],
    topics: [topic],
    counts,
    surprise,
    summaries: new Map(),
    paragraphs: new Map(),
    copy: {},
    relations: {},
    clusterNames: { [topic.slug]: [] },
  };
}
