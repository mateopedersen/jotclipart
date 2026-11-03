import { catalogStatistics } from './catalog-statistics';
import { catalogCountValue, formatCatalogCount } from './catalog-counts';
import { collectionCountParts } from './collection-count-tokens.mjs';

// Legacy collection introductions begin with e.g. "Explore 50 cat clipart designs".
// Resolve those catalog-size claims centrally, along with explicit future templates.
export function collectionCountTemplate(text: string): string {
  return text.replace(
    /^((?:explore|browse|find|download|choose(?: from)?)\s+)[\d,]+(?=\s+[^.!?]{0,80}\b(?:illustrations|clipart designs|artworks)\b)/i,
    '$1{{artworkCount}}',
  );
}

export function resolveCollectionCountCopy(text: string, topic: string): string {
  const value = catalogCountValue(catalogStatistics, 'topic', topic);
  return collectionCountParts(collectionCountTemplate(text))
    .map((part: string | { unit?: 'illustration' }) =>
      typeof part === 'string' ? part : formatCatalogCount(value, part.unit),
    )
    .join('');
}
