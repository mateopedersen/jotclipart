import { imageLoadingPreview } from './image-loading-preview';

/** Homepage cards only. Keep the original in src and all canonical/file controls.
 * The browser can use the existing, source-bound R2 thumbnail on ordinary screens;
 * high-density screens retain the original. Unknown/unverified inputs fail back
 * to the original, without making a request or changing the catalog record.
 */
export function homeImageCandidates(item: Parameters<typeof imageLoadingPreview>[0]) {
  const preview = imageLoadingPreview(item);
  return preview ? `${preview.url} 1x, ${preview.source} 2x` : undefined;
}
