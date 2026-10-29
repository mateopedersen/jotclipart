export interface CollectionSubject {
  slug: string;
  name: string;
  count: number;
  sample: { thumb: string; thumbSrcSet?: string; webp?: string; alt: string; title: string };
}
export interface CollectionArtwork {
  id: string;
  topic: string;
  published?: boolean;
  indexable?: boolean;
  thumb?: string;
  thumbSrcSet?: string;
  webp?: string;
  alt?: string;
  title?: string;
}
/** Input artwork is already sorted by the site's canonical publication order. */
export function latestSubjectCollections(
  subjects: CollectionSubject[],
  orderedArt: CollectionArtwork[],
  limit = 8,
) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid collection limit');
  if (limit === 0) return [];
  const bySlug = new Map(subjects.map((subject) => [subject.slug, subject]));
  const seen = new Set<string>();
  const result = [];
  for (const art of orderedArt) {
    if (art.published === false || art.indexable === false || seen.has(art.topic)) continue;
    const subject = bySlug.get(art.topic);
    if (!subject || subject.count < 1) continue;
    seen.add(art.topic);
    result.push({
      slug: subject.slug,
      name: subject.name,
      count: subject.count,
      // The cover should represent the update being announced. Keep the
      // source's own text and assets together; an incomplete record cannot
      // donate just its image to a different record's metadata.
      sample:
        art.thumb && art.webp && art.alt && art.title
          ? {
              thumb: art.thumb,
              thumbSrcSet: art.thumbSrcSet,
              webp: art.webp,
              alt: art.alt,
              title: art.title,
            }
          : { ...subject.sample },
      latestArtworkId: art.id,
      href: `/clipart/${subject.slug}/`,
    });
    if (result.length >= limit) break;
  }
  return result;
}
