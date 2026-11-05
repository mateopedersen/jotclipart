import { boundLoadingPreview, publicLoadingImageURL } from '../lib/image-loading-preview.ts';
import type { SearchCard } from '../lib/search-index.ts';
import {
  requestPinnedStudioAssets,
  type SnapshotStudioAsset,
  type SnapshotTransport,
} from '../lib/snapshot-studio.ts';
import { bindSearchCardPreview } from './search-card.ts';

export function searchPreviewFromPinnedAsset(card: SearchCard, asset?: SnapshotStudioAsset | null) {
  const original = card.download?.files.webp;
  if (
    !original ||
    asset?.id !== card.id ||
    asset.webp.url !== card.webp ||
    asset.webp.sha256 !== original.sha256 ||
    asset.webp.bytes !== original.bytes
  )
    return undefined;
  return boundLoadingPreview(card.webp, asset.thumb);
}

// Older signed card blocks did not store preview metadata. Their existing,
// snapshot-pinned Studio projection can supply it without holding search text,
// links, pagination, or a newer query behind a second metadata request.
export function loadLegacySearchPreviews(
  cards: { item: SearchCard; element: HTMLElement }[],
  transport: SnapshotTransport | undefined,
  signal: AbortSignal,
) {
  if (!transport || signal.aborted || !navigator.onLine) return;
  const pending = new Map<string, { item: SearchCard; images: HTMLImageElement[] }>();
  for (const { item, element } of cards) {
    const image = element.querySelector<HTMLImageElement>('.art-picture > img');
    if (
      !image ||
      image.dataset.originalPlaceholder ||
      !item.download?.files.webp ||
      !publicLoadingImageURL(item.webp)
    )
      continue;
    let entry = pending.get(item.id);
    if (!entry) {
      if (pending.size >= 32) break;
      entry = { item, images: [] };
      pending.set(item.id, entry);
    }
    entry.images.push(image);
    image.dataset.searchPreviewAwaiting = '';
  }
  if (!pending.size) return;
  const controller = new AbortController();
  const entries = [...pending.values()];
  const release = () => {
    for (const { images } of entries)
      for (const image of images) delete image.dataset.searchPreviewAwaiting;
  };
  const cancel = () => {
    controller.abort();
    release();
  };
  // Limit the hold on originals, but let a slow lookup deliver a preview
  // while those larger images are still in flight.
  const releaseTimer = setTimeout(release, 900);
  const requestTimer = setTimeout(cancel, 3000);
  signal.addEventListener('abort', cancel, { once: true });
  void requestPinnedStudioAssets(transport, [...pending.keys()], controller.signal)
    .then((assets) => {
      if (controller.signal.aborted || signal.aborted) return;
      for (const [index, { item, images }] of entries.entries()) {
        const preview = searchPreviewFromPinnedAsset(item, assets[index]);
        for (const image of images) if (image.isConnected) bindSearchCardPreview(image, preview);
      }
    })
    .catch(() => {
      // A stale, missing, or slow optional preview falls back to the original.
    })
    .finally(() => {
      clearTimeout(releaseTimer);
      clearTimeout(requestTimer);
      signal.removeEventListener('abort', cancel);
      release();
    });
}
