import { collectionStyle, preferred } from './category-designs.mjs';
import { buildSubjectKeywords } from './category-search';
import {
  publishedArt as art,
  availableTopics,
  availableClusters,
  slugify,
  clustersForTopic,
} from './catalog';
import { catalogStatistics } from './catalog-statistics';

const artworkByTopic = new Map<string, typeof art>();
for (const item of art) {
  const group = artworkByTopic.get(item.topic) ?? [];
  group.push(item);
  artworkByTopic.set(item.topic, group);
}
export const categorySubjects = availableTopics
  .map((topic) => {
    const items = artworkByTopic.get(topic.slug)!;
    const sample =
      items.find((item) => item.id === preferred[topic.slug]) ??
      items.find((item) => item.style === 'Color') ??
      items[0];
    const name = topic.keyword.replace(/\s+clipart$/i, '');
    return {
      ...topic,
      name: name[0].toUpperCase() + name.slice(1),
      searchKeywords: buildSubjectKeywords(
        items.map((item) => `${item.title} ${item.alt} ${item.style}`),
      ),
      count: catalogStatistics.topics[topic.slug] ?? 0,
      sample,
      group: slugify(topic.cluster),
      groups: [slugify(topic.cluster)],
      relatedGroups: clustersForTopic(topic).map(slugify),
      color: collectionStyle[topic.cluster]?.color ?? 'sage',
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name, 'en'));

const order = Object.keys(collectionStyle);
export const categoryCollections = availableClusters
  .map((cluster) => {
    const subjects = categorySubjects.filter((topic) => topic.cluster === cluster);
    const design = collectionStyle[cluster] ?? {
      title: cluster,
      description: 'Find a new starting point for your next project.',
      color: 'sage',
      subjects: subjects.map((s) => s.slug),
    };
    const previews = design.subjects.flatMap((slug) => {
      const subject = subjects.find((s) => s.slug === slug);
      return subject ? [subject.sample] : [];
    });
    for (const subject of subjects) {
      for (const item of artworkByTopic.get(subject.slug)!) {
        if (previews.length >= 3) break;
        if (!previews.some((preview) => preview.id === item.id)) previews.push(item);
      }
      if (previews.length >= 3) break;
    }
    return {
      ...design,
      cluster,
      slug: slugify(cluster),
      subjects,
      previews: previews.slice(0, 3),
      count: catalogStatistics.collections[slugify(cluster)]?.artworks ?? 0,
    };
  })
  .filter((collection) => collection.subjects.length > 0)
  .sort(
    (a, b) =>
      (order.indexOf(a.cluster) < 0 ? 999 : order.indexOf(a.cluster)) -
      (order.indexOf(b.cluster) < 0 ? 999 : order.indexOf(b.cluster)),
  );
