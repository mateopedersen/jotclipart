/** Use editorial relationships, never a broad-cluster or text-overlap guess. */
export function relatedCollectionSlugs(
  source: string,
  relations: Record<string, string[]>,
  indexableTopics: ReadonlySet<string>,
): string[] {
  return [...new Set(relations[source] ?? [])]
    .filter((slug) => slug !== source && indexableTopics.has(slug))
    .slice(0, 6);
}

/** Draft candidates from reviewed links only. This does not publish a relation:
 * a shared neighbor can be directional and still needs editorial judgment. */
export function suggestCollectionRelations(
  source: string,
  relations: Record<string, string[]>,
  indexableTopics: ReadonlySet<string>,
  limit = 6,
  categories: ReadonlyMap<string, string> = new Map(),
): { slug: string; evidence: string[] }[] {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid suggestion limit');
  if (limit === 0 || !indexableTopics.has(source)) return [];
  const existing = new Set(relations[source] ?? []);
  const sourceNeighbors = new Set([...existing].filter((slug) => indexableTopics.has(slug)));
  const candidates: { slug: string; evidence: string[]; score: number }[] = [];
  for (const slug of indexableTopics) {
    const targets = relations[slug] ?? [];
    if (
      slug === source ||
      existing.has(slug) ||
      !indexableTopics.has(slug) ||
      !Array.isArray(targets)
    )
      continue;
    const evidence: string[] = [];
    if (targets.includes(source)) evidence.push('reviewed incoming link');
    const common = [...new Set(targets)].filter((target) => sourceNeighbors.has(target)).sort();
    if (common.length) evidence.push(`shared reviewed links: ${common.join(', ')}`);
    const category = categories.get(source)?.trim();
    const sameCategory = !!category && categories.get(slug)?.trim() === category;
    if (sameCategory) evidence.push(`same catalog category: ${category}; review before linking`);
    if (evidence.length)
      candidates.push({
        slug,
        evidence,
        score: (targets.includes(source) ? 100 : 0) + common.length * 10 + (sameCategory ? 1 : 0),
      });
  }
  return candidates
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug, 'en'))
    .slice(0, limit)
    .map(({ slug, evidence }) => ({ slug, evidence }));
}
