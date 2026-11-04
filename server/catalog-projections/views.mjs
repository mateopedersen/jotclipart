// Pure bounded metadata views. Artwork facts have already been source-bound.
import { collectionStyle } from '../../src/lib/category-designs.mjs';
import { normalizeQuery } from '../../src/lib/search-language.ts';
export const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
export const fieldKey = (field, value) =>
  ['staticIds', 'directoryIds', 'colors', 'styles', 'clusters'].includes(field)
    ? value
    : field === 'clusterPicks'
      ? value.cluster
      : ['subjects', 'topics', 'clustersData'].includes(field)
        ? value.slug
        : (value.id ?? value.slug);
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const design = (name, subjects) =>
  Object.hasOwn(collectionStyle, name)
    ? collectionStyle[name]
    : {
        title: name,
        description: 'Find a new starting point for your next project.',
        color: 'sage',
        subjects: subjects.map((s) => s.slug),
      };
const cleanTopic = (t) => {
  const { clusterNames, ...rest } = t;
  return rest;
};
export function deriveViews(oldFields, facts, global) {
  const topics = oldFields.topics
    .filter((t) => facts.has(t.slug))
    .map((t) => cleanTopic(facts.get(t.slug).topic));
  for (const [slug, f] of facts)
    if (!topics.some((t) => t.slug === slug)) topics.push(cleanTopic(f.topic));
  if (topics.length > 10000 || new Set(topics.map((t) => t.slug)).size !== topics.length)
    throw Error('Invalid public topic list');
  const bySlug = new Map(topics.map((t) => [t.slug, t])),
    labels = [],
    seen = new Map();
  for (const t of topics)
    for (const label of facts.get(t.slug).clusterNames) {
      const key = slugify(label);
      if (seen.has(key) && seen.get(key) !== label) throw Error('Canonical cluster slug collision');
      if (!seen.has(key)) {
        seen.set(key, label);
        labels.push(label);
      }
    }
  const clusters = labels.filter((c) => topics.some((t) => t.cluster === c));
  if (clusters.length > 128) throw Error('Cluster budget exceeded');
  const subjects = topics
    .map((t) => {
      const f = facts.get(t.slug),
        name = t.keyword.replace(/\s+clipart$/i, '');
      return {
        ...t,
        name: capitalize(name),
        searchKeywords: f.keywords,
        count: f.count,
        sampleId: f.coverId,
        group: slugify(t.cluster),
        groups: [slugify(t.cluster)],
        relatedGroups: f.clusterNames.map(slugify),
        color: design(t.cluster, []).color,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const bySubject = new Map(subjects.map((s) => [s.slug, s])),
    thumbs = new Map();
  for (const f of facts.values()) {
    thumbs.set(f.coverId, f.coverThumb);
    for (const p of f.first) thumbs.set(p.id, p.thumb);
  }
  const order = Object.keys(collectionStyle),
    clustersData = clusters
      .map((cluster) => {
        const list = subjects.filter((t) => t.cluster === cluster),
          d = design(cluster, list),
          previews = d.subjects.flatMap((slug) =>
            list.some((t) => t.slug === slug) ? [bySubject.get(slug).sampleId] : [],
          );
        for (const t of list) {
          for (const a of facts.get(t.slug).first) {
            if (previews.length >= 3) break;
            if (!previews.includes(a.id)) previews.push(a.id);
          }
          if (previews.length >= 3) break;
        }
        const count = list.reduce((n, t) => n + t.count, 0),
          key = slugify(cluster);
        if (
          count !== global.collections[key]?.artworks ||
          list.length !== global.collections[key]?.subjects
        )
          throw Error('Projection cluster count differs');
        const { subjects: ignoredDesignSubjects, ...copy } = d;
        return {
          ...copy,
          cluster,
          slug: key,
          subjectSlugs: list.map((t) => t.slug),
          previewIds: previews.slice(0, 3),
          count,
        };
      })
      .filter((c) => c.subjectSlugs.length)
      .sort(
        (a, b) =>
          (order.indexOf(a.cluster) < 0 ? 999 : order.indexOf(a.cluster)) -
          (order.indexOf(b.cluster) < 0 ? 999 : order.indexOf(b.cluster)),
      );
  const clusterPicks = clustersData.map((c) => ({
    cluster: c.cluster,
    ids: c.subjectSlugs
      .flatMap((slug) => facts.get(slug).first)
      .sort((a, b) => a.n - b.n)
      .slice(0, 32)
      .map((a) => a.id),
  }));
  const categories = clustersData.map((c) => ({
    id: c.slug,
    title: c.title,
    thumb: thumbs.get(c.previewIds[0]) || '',
    topics: c.subjectSlugs.map((slug) => {
      const s = bySubject.get(slug);
      return { id: slug, title: s.name, count: s.count, thumb: facts.get(slug).coverThumb };
    }),
  }));
  const monoTopics = topics
    .flatMap((t) => {
      const f = facts.get(t.slug);
      return f.mono
        ? [
            {
              slug: t.slug,
              label: t.keyword.replace(/\s+clipart$/i, ''),
              count: f.mono,
              collections: f.clusterNames.map(slugify),
            },
          ]
        : [];
    })
    .sort((a, b) => a.label.localeCompare(b.label, 'en'));
  const monoTotal = monoTopics.reduce((n, t) => n + t.count, 0),
    monoCollections = clusters
      .flatMap((label) => {
        const slug = slugify(label),
          count = monoTopics
            .filter((t) => t.collections.includes(slug))
            .reduce((n, t) => n + t.count, 0);
        return count ? [{ slug, label: label.split(' ').map(capitalize).join(' '), count }] : [];
      })
      .sort((a, b) => a.label.localeCompare(b.label, 'en')),
    kinds = [
      ['outline', 'Line Art'],
      ['grayscale', 'Shaded & Ink Drawings'],
      ['silhouette', 'Silhouettes'],
    ]
      .map(([slug, label]) => ({
        slug,
        label,
        count: [...facts.values()].reduce((n, t) => n + (t.kinds[slug] || 0), 0),
      }))
      .filter((k) => k.count);
  if (
    [...facts.values()].reduce((n, f) => n + f.count, 0) !== global.totals.artworks ||
    facts.size !== global.totals.subjects ||
    monoTotal !== global.totals.printable ||
    clusters.length !== global.totals.collections ||
    JSON.stringify(clusters.map(slugify).sort()) !==
      JSON.stringify(Object.keys(global.collections).sort())
  )
    throw Error('Projection global counts differ');
  const groups = [...facts].sort(([a], [b]) => a.localeCompare(b)).map(([, f]) => f.studio),
    featuredIds = [];
  for (let i = 0; featuredIds.length < 500 && groups.some((g) => g[i]); i++)
    for (const group of groups) {
      if (group[i]) featuredIds.push(group[i]);
      if (featuredIds.length === 500) break;
    }
  const colors = [...new Set([...facts.values()].flatMap((f) => f.colors))].sort(),
    styles = [...new Set([...facts.values()].flatMap((f) => f.styles))].sort();
  return {
    fields: {
      ...oldFields,
      topics,
      subjects,
      clusters,
      clustersData,
      clusterPicks,
      colors,
      styles,
    },
    ui: {
      categories,
      monochrome: { total: monoTotal, topics: monoTopics, collections: monoCollections, kinds },
      featuredIds,
    },
    facts,
    topics,
  };
}
export function replaceSiteEntries(old, topics, clusters) {
  const dynamic = (e) => e.kind === 'topic' || e.kind === 'collection',
    start = old.findIndex(dynamic);
  if (start < 0) throw Error('Missing source site-search section');
  let end = start;
  while (end < old.length && dynamic(old[end])) end++;
  if (old.slice(end).some(dynamic)) throw Error('Noncontiguous site-search sections');
  const add = (kind, id, title, description, href, text) => ({
    kind,
    id,
    title,
    description,
    href,
    text: [...new Set(normalizeQuery(text))].join(' '),
  });
  const entries = topics.map((t) =>
    add(
      'topic',
      'topic:' + t.slug,
      t.keyword,
      `Browse ${t.count} illustrations of ${t.keyword.replace(/ clipart$/i, '')}.`,
      `/clipart/${t.slug}/`,
      `${t.keyword} ${t.cluster}`,
    ),
  );
  const byCluster = new Map(clusters.map((label) => [slugify(label), label]));
  const clusterOrder = [
    ...old
      .slice(start, end)
      .filter((e) => e.kind === 'collection')
      .map((e) => byCluster.get(e.id.replace(/^collection:/, '')))
      .filter(Boolean),
  ];
  for (const label of clusters) if (!clusterOrder.includes(label)) clusterOrder.push(label);
  for (const cluster of clusterOrder)
    entries.push(
      add(
        'collection',
        'collection:' + slugify(cluster),
        cluster,
        `Browse the ${cluster} clipart collection.`,
        `/collection/${slugify(cluster)}/`,
        topics
          .filter((t) => t.cluster === cluster)
          .map((t) => t.keyword)
          .join(' '),
      ),
    );
  const result = [...old.slice(0, start), ...entries, ...old.slice(end)];
  if (result.length > 10000 || new Set(result.map((e) => e.id)).size !== result.length)
    throw Error('Site-search row budget or identity differs');
  return result;
}

// Stable source UI tie order; new categories still follow the shared design priorities.
export function alignCategoryOrder(categories, previous) {
  const priorities = Object.keys(collectionStyle).map(slugify),
    rank = (id) => (priorities.includes(id) ? priorities.indexOf(id) : 999),
    old = new Map(previous.map((v, i) => [v.id, i]));
  return [...categories].sort(
    (a, b) => rank(a.id) - rank(b.id) || (old.get(a.id) ?? 10000) - (old.get(b.id) ?? 10000),
  );
}
