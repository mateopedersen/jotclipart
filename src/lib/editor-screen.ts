import { previewIdentity, previewUrls, readPreviewIndex } from '../../scripts/preview-assets.mjs';
import type { art } from './catalog';
import sourceArt from '../../data/art.json';
const index = readPreviewIndex();
const originals = new Map(sourceArt.map((item) => [item.id, item]));

/** Public catalog display policy stays in catalog.ts. Only the noindex editor
 * receives this source-bound screen copy; original verification/export metadata
 * and the public social image are unchanged. */
export function editorScreen(item: (typeof art)[number]) {
  if (item.sourceType !== 'raster') return item;
  const original = originals.get(item.id);
  if (!original) return item;
  const record = index[previewIdentity(original)]?.files?.[960];
  if (!record) return item;
  return {
    ...item,
    preview: previewUrls(original)[960],
    previewWidth: record.width,
    previewHeight: record.height,
  };
}
