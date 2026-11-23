import geography from '../../data/flag-geography.json' with { type: 'json' };
import editorial from '../../data/topic-relations.json' with { type: 'json' };
import { mapFour } from '../catalog-search/bounded-map.mjs';

const flagCategory = 'Flags & countries';
const resultLimit = 6;
const candidateLimit = 18;
// UN M49 region and most specific subregion, with Natural Earth v5.1.2
// label points and land boundaries. Political status is outside this ranking.
const entries = Object.entries(geography);
const incoming = new Map();
for (const [source, targets] of Object.entries(editorial)) {
  for (const target of targets) {
    const sources = incoming.get(target) ?? [];
    sources.push(source);
    incoming.set(target, sources);
  }
}

// Squared half-chord distance sorts by great-circle distance, including across the date line.
function distance([longitude, latitude], [otherLongitude, otherLatitude]) {
  const rad = Math.PI / 180;
  return (
    Math.sin(((otherLatitude - latitude) * rad) / 2) ** 2 +
    Math.cos(latitude * rad) *
      Math.cos(otherLatitude * rad) *
      Math.sin(((otherLongitude - longitude) * rad) / 2) ** 2
  );
}

export function geographicFlagCandidates(source) {
  const country = geography[source];
  if (!country) return [];
  const [code, region, area, coordinates, borders] = country;
  return entries
    .flatMap(([slug, [otherCode, otherRegion, otherArea, otherCoordinates]]) => {
      if (code === otherCode) return [];
      const land = borders.includes(otherCode);
      if (!land && region !== otherRegion) return [];
      return [
        {
          slug,
          tier: land ? 0 : area === otherArea ? 1 : 2,
          distance: distance(coordinates, otherCoordinates),
        },
      ];
    })
    .sort(
      (a, b) => a.tier - b.tier || a.distance - b.distance || a.slug.localeCompare(b.slug, 'en'),
    )
    .map(({ slug }) => slug);
}

function editorialCandidates(record) {
  const explicit = new Set(record.related.map(({ slug }) => slug));
  const evidence = new Map();
  for (const slug of incoming.get(record.slug) ?? []) {
    evidence.set(slug, { slug, direct: true, common: 0 });
  }
  for (const target of explicit) {
    for (const slug of incoming.get(target) ?? []) {
      const row = evidence.get(slug) ?? { slug, direct: false, common: 0 };
      row.common++;
      evidence.set(slug, row);
    }
  }
  const inferred = [...evidence.values()]
    .filter(({ slug, direct, common }) => !explicit.has(slug) && (direct || common >= 2))
    .sort(
      (a, b) =>
        Number(b.direct) - Number(a.direct) ||
        b.common - a.common ||
        a.slug.localeCompare(b.slug, 'en'),
    );
  return [
    ...[...explicit].map((slug) => ({ slug, sameCategory: false })),
    ...inferred.map(({ slug }) => ({ slug, sameCategory: true })),
  ].filter(({ slug }) => slug !== record.slug);
}

export async function findRelatedTopics(record, find) {
  const geographic =
    record.primaryCluster === flagCategory ? geographicFlagCandidates(record.slug) : [];
  const candidates = (
    geographic.length
      ? geographic.map((slug) => ({ slug, sameCategory: true }))
      : editorialCandidates(record)
  ).slice(0, candidateLimit);
  const results = [];
  for (let offset = 0; offset < candidates.length && results.length < resultLimit;) {
    const batch = candidates.slice(offset, offset + resultLimit - results.length);
    offset += batch.length;
    const rows = await mapFour(batch, async ({ slug, sameCategory }) => {
      const candidate = await find(slug);
      if (!candidate || (sameCategory && candidate.record.primaryCluster !== record.primaryCluster))
        return null;
      return candidate;
    });
    results.push(...rows.filter(Boolean));
  }
  return results;
}
