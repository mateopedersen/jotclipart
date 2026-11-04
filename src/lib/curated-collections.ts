import { publishedArt, availableTopics } from './catalog';
import { categorySubjects } from './category-directory';
import {
  activeCuratedCollections,
  resolveReviewedCover,
  balancedCollectionIDs,
  curatedCollectionCount,
} from './curated-collection-policy.mjs';

const byId = new Map(publishedArt.map((a) => [a.id, a]));
const byTopic = new Map<string, string[]>();
for (const item of publishedArt)
  byTopic.set(item.topic, [...(byTopic.get(item.topic) ?? []), item.id]);
const topicCounts = Object.fromEntries([...byTopic].map(([t, ids]) => [t, ids.length]));
export const curatedCollections = activeCuratedCollections(topicCounts).map((group) => ({
  ...group,
  subjects: group.topicSlugs.map((slug) => categorySubjects.find((t) => t.slug === slug)!),
  topics: group.topicSlugs.map((slug) => availableTopics.find((t) => t.slug === slug)!),
  previews: resolveReviewedCover(group.slug, byId)!,
  items: balancedCollectionIDs(group, byTopic).map((id) => byId.get(id)!),
  count: curatedCollectionCount(group, topicCounts),
}));
