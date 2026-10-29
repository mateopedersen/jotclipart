type RecentArtwork = {
  topic: string;
  published?: boolean;
  indexable?: boolean;
};

/** Keep the publication order intact while showing the latest artwork from each subject. */
export function diverseRecentArtwork<T extends RecentArtwork>(
  newestFirst: readonly T[],
  _categoryForTopic: (topic: string) => string | undefined,
  limit = 12,
): T[] {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid gallery limit');
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of newestFirst) {
    if (result.length === limit) break;
    if (item.published === false || item.indexable === false || seen.has(item.topic)) continue;
    seen.add(item.topic);
    result.push(item);
  }
  return result;
}
