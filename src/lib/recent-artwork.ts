type RecentArtwork = {
  topic: string;
  published?: boolean;
  indexable?: boolean;
  /** Result of the original-thumbnail color audit; unknown values are left unclassified. */
  monochrome?: boolean;
  style?: string;
};

function monochromeStatus(item: RecentArtwork): boolean | null {
  if (typeof item.monochrome === 'boolean') return item.monochrome;
  const style = item.style?.toLowerCase();
  if (!style) return null;
  if (/black\s*(?:&|and)\s*white|monochrome|silhouette/.test(style)) return true;
  if (/\bcolor(?:ed)?\b|watercolor|full\s*color/.test(style)) return false;
  return null;
}

/**
 * Show one recent design per subject while alternating audited color and monochrome work.
 * Imported sets often append their monochrome variants last, so a plain newest-first
 * de-duplication can make the entire homepage row look black and white.
 */
export function diverseRecentArtwork<T extends RecentArtwork>(
  newestFirst: readonly T[],
  _categoryForTopic: (topic: string) => string | undefined,
  limit = 12,
): T[] {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid gallery limit');
  if (limit === 0) return [];
  const subjects = new Map<string, { color?: T; monochrome?: T; unknown?: T; latest?: T }>();
  for (const item of newestFirst) {
    if (item.published === false || item.indexable === false) continue;
    let subject = subjects.get(item.topic);
    if (!subject) {
      subject = {};
      subjects.set(item.topic, subject);
    }
    subject.latest ??= item;
    const status = monochromeStatus(item);
    if (status === true) subject.monochrome ??= item;
    else if (status === false) subject.color ??= item;
    else subject.unknown ??= item;
  }

  const entries = [...subjects.values()];
  const hasColor = entries.some((subject) => subject.color);
  const hasMonochrome = entries.some((subject) => subject.monochrome);
  if (!hasColor || !hasMonochrome) {
    return entries
      .map((subject) => subject.latest!)
      .filter(Boolean)
      .slice(0, limit);
  }

  const firstStatus = monochromeStatus(entries[0].latest!);
  let wantMonochrome = firstStatus ?? true;
  const usedTopics = new Set<string>();
  const result: T[] = [];

  while (result.length < limit) {
    let selected: { topic: string; item: T } | undefined;
    for (const [topic, subject] of subjects) {
      if (usedTopics.has(topic)) continue;
      const item = wantMonochrome ? subject.monochrome : subject.color;
      if (item) {
        selected = { topic, item };
        break;
      }
    }
    if (!selected) {
      const fallback = [...subjects].find(([topic]) => !usedTopics.has(topic));
      if (!fallback) break;
      selected = { topic: fallback[0], item: fallback[1].latest! };
    }
    usedTopics.add(selected.topic);
    result.push(selected.item);
    wantMonochrome = !wantMonochrome;
  }

  return result;
}
