import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertCatalogPolicy } from './catalog-policy.mjs';
import { readReviewedImportCatalog } from '../reviewed-imports.mjs';
import { assertOwnerPdfColorCatalog, OWNER_PDF_REGISTRY_SHA256, OWNER_PDF_REPLACEMENT_REGISTRY_SHA256, OWNER_PDF_STATUS } from '../../src/lib/file-review-policy.mjs';
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
  assertOwnerPdfColorCatalog(input.artwork);
  if (input.artwork.some((item) => item.sourceCollection === 'owner-75-2026-11-01' || item.reviewStatus === OWNER_PDF_STATUS)) {
    const bytes = readFileSync(new URL('data/editorial/owner-75-pdf-exceptions-20261101.json', root));
    if (createHash('sha256').update(bytes).digest('hex') !== OWNER_PDF_REGISTRY_SHA256)
      throw new Error('Owner PDF direction registry changed; renew source-bound evidence');
    const replacements = readFileSync(new URL('data/editorial/owner-75-reviewed-pdf-replacements-20261101.json', root));
    if (createHash('sha256').update(replacements).digest('hex') !== OWNER_PDF_REPLACEMENT_REGISTRY_SHA256)
      throw new Error('Owner PDF replacement registry changed; renew source-bound evidence');
    assertOwnerPdfColorCatalog(input.artwork, JSON.parse(bytes), JSON.parse(replacements));
  }
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
