import { readFileSync } from 'node:fs';
import { resolveArtworkCopy } from '../artwork-editorial.mjs';
import { repeatedSentences } from '../../src/lib/editorial-repetition.mjs';

const read = (path) => JSON.parse(readFileSync(new URL('../../data/' + path, import.meta.url)));
const records = read('art.json').filter((item) => item.published && item.indexable);
const reviews = new Map(
  read('editorial/reviews.json').artworks.map((review) => [review.id, review]),
);
const rows = repeatedSentences(
  records.map((item) => ({
    id: item.id,
    description: resolveArtworkCopy(item, reviews.get(item.id)).description,
  })),
);
console.log(
  JSON.stringify(
    {
      scope: 'Exact repeated sentences are candidates for editorial review, not automatic errors.',
      artworks: records.length,
      groups: rows.length,
      affected: new Set(rows.flatMap((row) => row.ids)).size,
      rows,
    },
    null,
    2,
  ),
);
