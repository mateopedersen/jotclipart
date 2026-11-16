import type { SearchRepository } from './search-remote';
import { requestPinnedStudioAssets } from './snapshot-studio.ts';

export type CategorySample = {
  id: string;
  title: string;
  alt: string;
  webp: string;
  preview?: { source: string; url: string };
};

/** Resolve only the visible batch from one captured catalog; never derive asset paths. */
export async function categorySamples(
  repository: Pick<SearchRepository, 'manifest' | 'favoriteItems' | 'clear'>,
  ids: string[],
  signal: AbortSignal,
): Promise<(CategorySample | null)[]> {
  if (ids.length > 12 || new Set(ids).size !== ids.length)
    throw new Error('A category preview batch must contain at most twelve unique artworks.');
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal.aborted) throw new DOMException('Request cancelled', 'AbortError');
    const manifest = await repository.manifest(signal);
    if (!manifest.transport) return repository.favoriteItems(ids, signal);
    try {
      const assets = await requestPinnedStudioAssets(manifest.transport, ids, signal);
      return assets.map((asset) => {
        if (!asset) return null;
        let preview: CategorySample['preview'];
        try {
          const url = new URL(asset.thumb);
          if (
            url.protocol === 'https:' &&
            url.hostname === 'assets.jotclipart.com' &&
            !url.username &&
            !url.password &&
            !url.port &&
            !url.search &&
            !url.hash &&
            url.pathname.endsWith('.webp') &&
            url.href !== asset.webp.url
          )
            preview = { source: asset.webp.url, url: url.href };
        } catch {
          /* An invalid optional preview never replaces the verified original. */
        }
        return { id: asset.id, title: asset.title, alt: asset.alt, webp: asset.webp.url, preview };
      });
    } catch (error) {
      // Legacy vector entries may not have the raster Studio representation.
      // Identity/snapshot validation failures and cancellation must fail closed.
      if (signal.aborted) throw error;
      const status = (error as { status?: number }).status;
      if (attempt === 0 && (status === 409 || status === 412)) {
        repository.clear();
        continue;
      }
      if (![501, 503].includes(status ?? 0)) throw error;
      return repository.favoriteItems(ids, signal);
    }
  }
  throw new Error('The category catalog changed. Refresh the page to try again.');
}
