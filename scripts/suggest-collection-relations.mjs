import { readFileSync } from 'node:fs';
import { suggestCollectionRelations } from '../src/lib/related-collections.ts';
import { primaryClusterForTopic } from '../src/lib/topic-clusters.ts';

const topic = process.argv[2];
if (!topic || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(topic)) {
  console.error('Usage: node scripts/suggest-collection-relations.mjs <topic-slug>');
  process.exitCode = 1;
} else {
  const read = (name) =>
    JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'));
  const art = read('art.json');
  const topics = [...read('topics.json').topics, ...read('extra-topics.json')];
  const registered = new Set(topics.map((t) => t.slug));
  const categories = new Map(topics.map((t) => [t.slug, primaryClusterForTopic(t)]));
  const eligible = new Set(
    art.filter((a) => a.published && a.indexable && registered.has(a.topic)).map((a) => a.topic),
  );
  if (!eligible.has(topic))
    throw new Error('Topic must be registered and have published indexable artwork');
  const relations = read('topic-relations.json');
  console.log(
    JSON.stringify(
      {
        topic,
        status: 'editorial-candidates-only',
        suggestions: suggestCollectionRelations(topic, relations, eligible, 6, categories),
      },
      null,
      2,
    ),
  );
}
