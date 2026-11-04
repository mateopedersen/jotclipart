import type { SearchManifest } from './search-index';
import type { SiteSearchEntry } from './site-search';
export interface SearchDirectoryResult {
  version: string;
  entries: SiteSearchEntry[] | null;
  siteError: boolean;
}
/** A search retry may advance artwork while a directory response is still in flight. */
export async function alignSearchDirectory(
  repository: { siteEntries(manifest: SearchManifest, signal?: AbortSignal): Promise<SiteSearchEntry[]> },
  manifest: SearchManifest,
  directory: SearchDirectoryResult,
  signal?: AbortSignal,
): Promise<SearchDirectoryResult> {
  if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
  if (!directory.version || directory.version === manifest.version) return directory;
  try {
    const entries = await repository.siteEntries(manifest, signal);
    if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
    return { version: manifest.version, entries, siteError: false };
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
    return { version: manifest.version, entries: null, siteError: true };
  }
}
