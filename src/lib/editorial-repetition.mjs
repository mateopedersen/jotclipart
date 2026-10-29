/** Exact repeated sentences are review candidates, not automatic errors. */
export function repeatedSentences(records, minimum = 3) {
  if (!Number.isSafeInteger(minimum) || minimum < 2) throw Error('Invalid repetition threshold');
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  const groups = new Map();
  for (const record of records) {
    if (!record.id || typeof record.description !== 'string')
      throw Error('Invalid editorial record');
    for (const sentence of new Set(
      [...segmenter.segment(record.description)].map((s) => s.segment.trim()),
    )) {
      if (sentence.length < 25) continue;
      const ids = groups.get(sentence) ?? new Set();
      ids.add(record.id);
      groups.set(sentence, ids);
    }
  }
  return [...groups]
    .filter(([, ids]) => ids.size >= minimum)
    .map(([sentence, ids]) => ({ sentence, count: ids.size, ids: [...ids].sort() }))
    .sort((a, b) => b.count - a.count || a.sentence.localeCompare(b.sentence, 'en'));
}
