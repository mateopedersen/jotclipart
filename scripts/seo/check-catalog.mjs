import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertCatalogPolicy } from './catalog-policy.mjs';
import { readReviewedImportCatalog } from '../reviewed-imports.mjs';
export function checkSourceCatalog(root = new URL('../../', import.meta.url)) {
  const json = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
  const input = {
    artwork: json('data/art.json'),
    topics: [...json('data/topics.json').topics, ...json('data/extra-topics.json')],
    relations: json('data/topic-relations.json'),
    browseGroups: json('data/browse-groups.json'),
    primaryCategories: json('data/primary-topic-categories.json'),
    metadataReviews: json('data/image-metadata-reviews.json').artwork,
  };
  const result = assertCatalogPolicy(input);
  // Reviewed copy is what visitors and search engines actually receive. Distinct
  // incoming strings can still resolve to identical public headings or captions.
  const titles = new Map();
  for (const item of readReviewedImportCatalog(fileURLToPath(root))) {
    if (!item.published || !item.indexable) continue;
    const key = item.title
      .normalize('NFKC')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[.!]$/, '')
      .toLowerCase();
    if (titles.has(key))
      throw new Error(`Duplicate public title: ${item.id} and ${titles.get(key)}`);
    titles.set(key, item.id);
  }
  if (json('data/production-queue.json').availableArtworkCount !== input.artwork.length)
    throw new Error('Catalog count is stale; run scripts/sync-production-queue.mjs');
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(checkSourceCatalog(), null, 2));
