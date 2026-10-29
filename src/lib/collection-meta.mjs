// A Bing inspection heuristic, not a Google length requirement or ranking guarantee.
const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
const abbreviation = /\b(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|e\.g|i\.e|u\.s|u\.k)\.$/i;

/** Reuse complete reviewed sentences; never slice words or invent a description. */
export function collectionMetaDescription(intro) {
  if (typeof intro !== 'string' || !intro.trim()) throw Error('A reviewed introduction is required');
  const full = intro.trim();
  const sentences = [...segmenter.segment(full)].map((part) => part.segment.trim()).filter(Boolean);
  let prefix = '';
  for (let i = 0; i < sentences.length; i++) {
    prefix = prefix ? `${prefix} ${sentences[i]}` : sentences[i];
    const length = [...prefix].length;
    if (length > 160) return { text: full, needsEditorialReview: true };
    if (abbreviation.test(prefix) && i + 1 < sentences.length) continue;
    if (length >= 25) return { text: prefix, needsEditorialReview: false };
  }
  return { text: full, needsEditorialReview: true };
}

/** Flag identical search descriptions without pretending to inspect artwork. */
export function validateCollectionMetaDescriptions(introductions) {
  const seen = new Map();
  const needsEditorialReview = [];
  for (const [topic, intro] of introductions) {
    const result = collectionMetaDescription(intro);
    const key = result.text.normalize('NFKC').toLocaleLowerCase('en');
    if (seen.has(key)) throw Error(`Repeated collection search description: ${seen.get(key)} and ${topic}`);
    seen.set(key, topic);
    if (result.needsEditorialReview) needsEditorialReview.push(topic);
  }
  return { topics: seen.size, needsEditorialReview };
}
