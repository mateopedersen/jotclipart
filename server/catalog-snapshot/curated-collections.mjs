import {
  curatedDefinitions,
  activeCuratedCollections,
  withCuratedCollectionCounts,
  resolveReviewedCover,
  balancedCollectionIDs,
  curatedCollectionCount,
} from '../../src/lib/curated-collection-policy.mjs';
import { mapFour } from '../catalog-search/bounded-map.mjs';

/** Read at most the explicit curated topic keys. Signed counts remain untouched. */
export async function curatedStatistics(cc, base) {
  const keys = [...new Set(curatedDefinitions.flatMap((g) => g.topicSlugs))];
  const topics = { ...base.topics };
  const missing = keys.filter((t) => !Object.hasOwn(topics, t));
  for (let i = 0; i < missing.length; i += 64)
    Object.assign(topics, (await cc.countsFor(missing.slice(i, i + 64))).topics);
  return withCuratedCollectionCounts(base, topics);
}

export async function readCuratedViews({
  cc,
  counts,
  topics,
  subjects,
  artwork,
  byId,
  selectedSlug,
}) {
  const definitions = activeCuratedCollections(counts.topics).filter(
    (g) => !selectedSlug || g.slug === selectedSlug,
  );
  await artwork([...new Set(definitions.flatMap((g) => g.cover.map((a) => a.id)))]);
  const bySlug = new Map(subjects.map((t) => [t.slug, t])),
    topicBySlug = new Map(topics.map((t) => [t.slug, t]));
  return definitions.map((group) => {
    const members = group.topicSlugs.map((slug) => {
      const subject = bySlug.get(slug);
      if (!subject || !topicBySlug.has(slug) || subject.count !== counts.topics[slug])
        throw Error('Curated subject snapshot differs');
      return subject;
    });
    return {
      ...group,
      subjects: members,
      topics: group.topicSlugs.map((t) => topicBySlug.get(t)),
      previews: resolveReviewedCover(group.slug, byId),
      count: curatedCollectionCount(group, counts.topics),
    };
  });
}

/** Only the first approved page of each explicit subject is needed for a balanced preview. */
export async function readCuratedGallery({ group, cc, counts, artwork }) {
  const rows = await mapFour(group.topicSlugs, async (slug) => {
    const entry = await cc.lookupCollection(slug);
    if (!entry) throw Error('Curated topic unavailable');
    const record = await cc.read(entry, 256 * 1024);
    const descriptor = record.pageBlocks?.[0];
    if (
      !['collection-topic', 'collection-topic-references'].includes(record.type) ||
      record.slug !== slug ||
      record.path !== `/clipart/${slug}/` ||
      record.artworkCount !== counts.topics[slug] ||
      entry.artworkCount !== record.artworkCount ||
      !descriptor ||
      descriptor.offset !== 0 ||
      descriptor.count < 1 ||
      descriptor.count > 32
    )
      throw Error('Curated member count or identity differs');
    const page = await cc.read(descriptor, 256 * 1024),
      ids = page.artworkIds ?? page.artworks?.map((a) => a.id);
    if (
      !['collection-page-ids', 'collection-page-artworks'].includes(page.type) ||
      page.slug !== slug ||
      page.offset !== 0 ||
      !Array.isArray(ids) ||
      ids.length !== descriptor.count ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
    )
      throw Error('Curated preview references differ');
    return [slug, ids];
  });
  const ids = balancedCollectionIDs(group, new Map(rows));
  const items = await artwork(ids),
    allowed = new Set(group.topicSlugs);
  if (items.some((a) => !allowed.has(a.topic)))
    throw Error('Curated preview includes unrelated artwork');
  return items;
}
