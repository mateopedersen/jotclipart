import registry from '../../data/curated-collections.json' with { type: 'json' };
import { fingerprint } from './cache-fingerprint.ts';

const slugOK = (s) => typeof s === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s);
/** @template T @param {T} value @returns {T} */
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
/** @template T @param {T} value @returns {T} */
export function validateCuratedRegistry(value) {
  if (
    value?.schema !== 1 ||
    value.kind !== 'reviewed-curated-topic-collections' ||
    !Array.isArray(value.collections) ||
    value.collections.length > 128 ||
    !Array.isArray(value.primaryCovers) ||
    value.primaryCovers.length > 128 ||
    !/^[a-f0-9]{64}$/.test(value.version ?? '')
  )
    throw Error('Invalid curated collection registry');
  const slugs = new Set();
  for (const group of [...value.collections, ...value.primaryCovers]) {
    if (
      !slugOK(group.slug) ||
      slugs.has(group.slug) ||
      !['sage', 'peach', 'rose', 'ice', 'lavender', 'sand'].includes(group.tone) ||
      !Array.isArray(group.cover) ||
      group.cover.length !== 3 ||
      new Set(group.cover.map((a) => a.id)).size !== 3 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(group.review?.checkedAt ?? '') ||
      group.review.method !== 'actual-source-contact-sheets' ||
      !Array.isArray(group.review.observations) ||
      group.review.observations.length < 2 ||
      group.review.observations.some((s) => typeof s !== 'string' || !s.trim())
    )
      throw Error('Invalid or unreviewed collection cover');
    slugs.add(group.slug);
    for (const a of group.cover)
      if (
        !slugOK(a.id) ||
        !slugOK(a.topic) ||
        !/^[a-f0-9]{64}$/.test(a.sourceSHA256 ?? '') ||
        ['title', 'alt', 'description'].some(
          (k) => typeof a.metadata?.[k] !== 'string' || !a.metadata[k].trim(),
        )
      )
        throw Error('Missing source-bound cover');
  }
  const memberships = new Set();
  for (const group of value.collections) {
    if (
      typeof group.title !== 'string' ||
      !group.title ||
      typeof group.summary !== 'string' ||
      !group.summary ||
      typeof group.section !== 'string' ||
      !Array.isArray(group.topicSlugs) ||
      group.topicSlugs.length < 2 ||
      group.topicSlugs.length > 64 ||
      group.topicSlugs.some((t) => !slugOK(t)) ||
      new Set(group.topicSlugs).size !== group.topicSlugs.length ||
      group.cover.some((a) => !group.topicSlugs.includes(a.topic))
    )
      throw Error('Invalid curated membership');
    const membership = [...group.topicSlugs].sort().join('|');
    if (memberships.has(membership)) throw Error('Duplicate curated membership');
    memberships.add(membership);
  }
  const openings = new Set();
  for (const group of [...value.collections, ...value.primaryCovers]) {
    if (
      typeof group.summary !== 'string' ||
      !group.summary.trim() ||
      /[-\u2010-\u2015]/u.test(group.summary) ||
      !Array.isArray(group.paragraphs) ||
      group.paragraphs.length < 2 ||
      group.paragraphs.length > 3 ||
      group.paragraphs.some(
        (p) => typeof p !== 'string' || !p.trim() || /[-\u2010-\u2015]/u.test(p),
      ) ||
      (group.paragraphs.join(' ').match(/\{\{artworkCount\}\}/g) ?? []).length !== 1
    )
      throw Error('Invalid curated introduction');
    const opening = group.paragraphs[0].split(/[.!?]/)[0].toLowerCase();
    if (openings.has(opening) || /^welcome to our\b/i.test(opening))
      throw Error('Repeated curated opening');
    openings.add(opening);
  }
  return value;
}
export const curatedRegistry = freeze(validateCuratedRegistry(registry));
export const curatedDefinitions = curatedRegistry.collections;
export const curatedBySlug = new Map(curatedDefinitions.map((g) => [g.slug, g]));
const coverBySlug = new Map(
  [...curatedDefinitions, ...curatedRegistry.primaryCovers].map((g) => [g.slug, g]),
);
const primaryBySlug = new Map(curatedRegistry.primaryCovers.map((g) => [g.slug, g]));
export function reviewedPrimaryCopy(slug) {
  const group = primaryBySlug.get(slug);
  return group ? { description: group.summary, paragraphs: group.paragraphs } : {};
}

/** Topic IDs are explicit. An alias, substring or search result cannot add a member. */
export function activeCuratedCollections(topicCounts) {
  return curatedDefinitions.filter((g) =>
    g.topicSlugs.every((t) => Number.isSafeInteger(topicCounts[t]) && topicCounts[t] > 0),
  );
}
export function curatedCollectionCount(group, topicCounts) {
  return group.topicSlugs.reduce((total, slug) => total + (topicCounts[slug] ?? 0), 0);
}
/** A presentation view over captured counts. Never mutate signed primary-category facts. */
export function withCuratedCollectionCounts(base, topicCounts = base.topics) {
  const primary = Object.fromEntries(
    Object.entries(base.collections).filter(([slug]) => !curatedBySlug.has(slug)),
  );
  const active = activeCuratedCollections(topicCounts);
  if (!active.length) return base;
  const added = Object.fromEntries(
    active.map((g) => [
      g.slug,
      { artworks: curatedCollectionCount(g, topicCounts), subjects: g.topicSlugs.length },
    ]),
  );
  return {
    ...base,
    version: fingerprint({ source: base.version, curated: curatedRegistry.version, counts: added }),
    totals: { ...base.totals, collections: Object.keys(primary).length + active.length },
    collections: { ...primary, ...added },
  };
}
export function resolveReviewedCover(slug, artworkById) {
  const definition = coverBySlug.get(slug);
  if (!definition) return undefined;
  return definition.cover.map((proof) => {
    const item = artworkById.get(proof.id);
    if (
      !item ||
      item.published !== true ||
      item.indexable !== true ||
      item.topic !== proof.topic ||
      item.files?.webp?.sha256 !== proof.sourceSHA256 ||
      ['title', 'alt', 'description'].some((k) => item[k] !== proof.metadata[k])
    )
      throw Error('Stale collection cover review: ' + slug + '/' + proof.id);
    return item;
  });
}
export const reviewedCoverIDs = (slug) => coverBySlug.get(slug)?.cover.map((a) => a.id) ?? [];
export const coverTone = (slug) => coverBySlug.get(slug)?.tone ?? 'ice';
export function curatedSubjectIDs(group) {
  return new Set(group.topicSlugs);
}

/** Round robin keeps a large member topic from crowding out all the others. */
export function balancedCollectionIDs(group, byTopic, { limit = 32 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 3 || limit > 64)
    throw Error('Invalid curated gallery budget');
  const result = [],
    seen = new Set(),
    add = (id) => {
      if (id && !seen.has(id) && result.length < limit) {
        seen.add(id);
        result.push(id);
      }
    };
  group.cover.forEach((a) => add(a.id));
  const rows = group.topicSlugs.map((t) => byTopic.get(t) ?? []);
  for (let n = 0; n < 32 && result.length < limit; n++) for (const row of rows) add(row[n]);
  return result;
}
export function curatedSitemap(topicCounts) {
  const urls = activeCuratedCollections(topicCounts).map(
    (g) => `<url><loc>https://jotclipart.com/collection/${g.slug}/</loc></url>`,
  );
  if (!urls.length) return undefined;
  return (
    '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    urls.join('') +
    '</urlset>'
  );
}
