// One-time source bootstrap, followed by changed-topic-only canonical resolution.
import { buildSubjectKeywords } from '../../src/lib/category-search.ts';
import { preferred } from '../../src/lib/category-designs.mjs';
import { clustersForTopic } from '../../src/lib/topic-clusters.ts';
import {
  buildMap,
  mapGet,
  mapEntries,
  patchMap,
  canonical,
  digest,
} from '../catalog-search/store.mjs';
const ok = (x) => typeof x === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(x),
  hash = (x) => digest(JSON.stringify(canonical(x)));
export const LIMITS = {
  topics: 10000,
  topicArtworks: 4096,
  changedTopics: 64,
  artworkLookups: 16384,
  clusters: 128,
};
export function collectionStore(store) {
  return { get: (d) => store.read('collections', d), put: (v) => store.put('collections', v) };
}
export function topicFacts(topic, rows, { preferredId } = {}) {
  if (
    !topic ||
    !ok(topic.slug) ||
    ['keyword', 'cluster', 'sourceCluster'].some(
      (k) => typeof topic[k] !== 'string' || !topic[k].trim(),
    ) ||
    !Array.isArray(rows) ||
    !rows.length ||
    rows.length > LIMITS.topicArtworks ||
    new Set(rows.map((r) => r.artwork.id)).size !== rows.length ||
    rows.some(
      (r) =>
        !r.artwork ||
        !ok(r.artwork.id) ||
        typeof r.artwork.color !== 'string' ||
        typeof r.artwork.createdAt !== 'string' ||
        typeof r.artwork.sourceType !== 'string' ||
        typeof (r.artwork.originalThumb || r.artwork.thumb) !== 'string' ||
        !Number.isSafeInteger(r.n) ||
        r.n < 0 ||
        r.artwork.topic !== topic.slug ||
        !r.artwork.published ||
        !r.artwork.indexable ||
        typeof r.artwork.title !== 'string' ||
        typeof r.artwork.alt !== 'string' ||
        typeof r.artwork.style !== 'string' ||
        typeof r.artwork.monochrome !== 'boolean',
    )
  )
    throw Error('Invalid source-bound discovery topic');
  const ordered = [...rows].sort((a, b) => a.n - b.n);
  if (new Set(ordered.map((r) => r.n)).size !== ordered.length)
    throw Error('Duplicate discovery ordinal');
  const items = ordered.map((r) => r.artwork),
    preference =
      preferredId ?? (Object.hasOwn(preferred, topic.slug) ? preferred[topic.slug] : undefined),
    cover =
      items.find((a) => a.id === preference) ?? items.find((a) => a.style === 'Color') ?? items[0],
    mono = items.filter((a) => a.monochrome),
    studio = items
      .filter((a) => a.sourceType === 'raster')
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) ||
          Number(a.monochrome) - Number(b.monochrome) ||
          a.title.localeCompare(b.title, 'en'),
      );
  const kinds = Object.fromEntries(
    ['outline', 'grayscale', 'silhouette'].map((kind) => [
      kind,
      mono.filter((a) => a.monochromeKind === kind).length,
    ]),
  );
  return {
    schema: 1,
    type: 'discovery-topic-facts-v1',
    slug: topic.slug,
    topic: { ...topic },
    clusterNames: Array.isArray(topic.clusterNames) ? topic.clusterNames : clustersForTopic(topic),
    count: items.length,
    mono: mono.length,
    kinds,
    colors: [...new Set(items.map((a) => a.color))].sort(),
    styles: [...new Set(items.map((a) => a.style))].sort(),
    keywords: buildSubjectKeywords(items.map((a) => `${a.title} ${a.alt} ${a.style}`)),
    coverId: cover.id,
    coverThumb: cover.originalThumb || cover.thumb,
    first: ordered
      .slice(0, 32)
      .map(({ artwork: a, n }) => ({ id: a.id, n, thumb: a.originalThumb || a.thumb })),
    studio: studio.slice(0, 500).map((a) => a.id),
    raster: studio.length,
    sourceRowsSHA256: undefined,
  };
}
export async function bootstrapProjectionFacts(
  store,
  records,
  topics,
  { artworkRootSHA256, recentLedgerSHA256 } = {},
) {
  if (
    !/^[a-f0-9]{64}$/.test(artworkRootSHA256 ?? '') ||
    !/^[a-f0-9]{64}$/.test(recentLedgerSHA256 ?? '') ||
    !Array.isArray(topics) ||
    topics.length > LIMITS.topics ||
    new Set(topics.map((t) => t.slug)).size !== topics.length
  )
    throw Error('Source-bound projection bootstrap required');
  const groups = new Map(),
    seen = new Set();
  let n = 0;
  for (const artwork of records) {
    if (!ok(artwork.id) || seen.has(artwork.id) || !artwork.published || !artwork.indexable)
      throw Error('Invalid projection baseline identity');
    seen.add(artwork.id);
    if (!groups.has(artwork.topic)) groups.set(artwork.topic, []);
    groups.get(artwork.topic).push({ artwork, n: n++ });
  }
  const rows = [];
  for (const topic of topics) {
    const source = groups.get(topic.slug);
    if (!source) continue;
    const facts = topicFacts(topic, source);
    facts.catalogPreview = await store.put({
      type: 'catalog-order-preview',
      topic: topic.slug,
      ids: source.map((r) => r.artwork.id),
    });
    delete facts.topic.clusterNames;
    facts.sourceRowsSHA256 = await hash(source.map((r) => ({ n: r.n, artwork: r.artwork })));
    rows.push({ key: topic.slug, value: await store.put(facts) });
    groups.delete(topic.slug);
  }
  if (groups.size) throw Error('Unregistered source topic in projection bootstrap');
  return store.put({
    type: 'discovery-projection-ledger-v1',
    ordinalPolicy: 'recent-stable-n-v1',
    artworkRootSHA256,
    recentLedgerSHA256,
    total: n,
    topics: await buildMap(store, 'discovery-topic-facts', rows),
  });
}
export async function readFacts(store, descriptor) {
  const root = await store.get(descriptor);
  if (
    root.type !== 'discovery-projection-ledger-v1' ||
    root.ordinalPolicy !== 'recent-stable-n-v1' ||
    !/^[a-f0-9]{64}$/.test(root.artworkRootSHA256 ?? '') ||
    !/^[a-f0-9]{64}$/.test(root.recentLedgerSHA256 ?? '') ||
    !Number.isSafeInteger(root.total) ||
    root.total < 0
  )
    throw Error('Projection bootstrap required');
  const entries = [];
  for await (const entry of mapEntries(store, root.topics, 'discovery-topic-facts')) {
    if (entries.length >= LIMITS.topics) throw Error('Discovery topic limit exceeded');
    entries.push(entry);
  }
  // Network-bound operator reads must not form one serial RPC per old topic.
  // Preserve directory order after four bounded readers complete.
  const values = Array(entries.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, entries.length) }, async () => {
      while (next < entries.length) {
        const i = next++;
        values[i] = await store.get(entries[i].value);
      }
    }),
  );
  const result = new Map();
  for (let i = 0; i < entries.length; i++) {
    const { key, value } = entries[i],
      facts = values[i];
    if (
      facts.type !== 'discovery-topic-facts-v1' ||
      facts.slug !== key ||
      facts.topic?.slug !== key ||
      !ok(key) ||
      !/^[a-f0-9]{64}$/.test(facts.sourceRowsSHA256 ?? '') ||
      !Number.isSafeInteger(facts.count) ||
      facts.count < 1 ||
      facts.count > LIMITS.topicArtworks ||
      !Number.isSafeInteger(facts.mono) ||
      facts.mono < 0 ||
      facts.mono > facts.count ||
      !Array.isArray(facts.first) ||
      facts.first.length !== Math.min(facts.count, 32) ||
      !Array.isArray(facts.studio) ||
      facts.studio.length > 500 ||
      new Set(facts.studio).size !== facts.studio.length ||
      !Array.isArray(facts.clusterNames) ||
      !facts.clusterNames.length ||
      facts.clusterNames.length > LIMITS.clusters ||
      facts.clusterNames.some((c) => typeof c !== 'string' || !c.trim()) ||
      result.has(key) ||
      result.size >= LIMITS.topics
    )
      throw Error('Invalid discovery facts directory');
    result.set(key, { descriptor: value, facts });
  }
  if ([...result.values()].reduce((n, v) => n + v.facts.count, 0) !== root.total)
    throw Error('Discovery ledger totals differ');
  return { root, topics: result };
}
export async function patchFacts(store, descriptor, updates, bindings) {
  const before = await store.get(descriptor);
  return store.put({
    ...before,
    ...bindings,
    topics: await patchMap(store, before.topics, 'discovery-topic-facts', updates),
  });
}
