import type { SearchManifest } from './search-index';
import { verifiedSourceUrl } from '../editor/source-policy.ts';

export interface SnapshotStudioAsset {
  id: string; title: string; alt: string; topic: string; style: string; thumb: string;
  width: number; height: number; createdAt?: string; monochrome?: boolean; featured?: boolean;
  webp: { url: string; bytes: number; sha256: string };
  pdf: { url: string; bytes: number; sha256: string };
}
export type SnapshotTransport = NonNullable<SearchManifest['transport']>;
export function validateStudioAsset(asset: SnapshotStudioAsset, id = asset?.id) {
  if (!asset || asset.id !== id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(asset.id) ||
      ![asset.width, asset.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 4096) ||
      ['title', 'alt', 'topic', 'style', 'thumb'].some(k => typeof asset[k as keyof SnapshotStudioAsset] !== 'string'))
    throw Error('The artwork source metadata is invalid.');
  const origin = typeof location === 'undefined' ? 'https://jotclipart.com' : location.origin;
  verifiedSourceUrl(asset.webp, 'webp', origin);
  verifiedSourceUrl(asset.pdf, 'pdf', origin);
  return asset;
}
export async function requestPinnedStudioAssets(
  transport: SnapshotTransport, ids: string[], signal?: AbortSignal,
): Promise<(SnapshotStudioAsset | null)[]> {
  if (transport?.protocol !== 'snapshot-search-v1' || transport.endpoint !== '/catalog-search.json' ||
      !/^[a-f0-9]{64}$/.test(transport.snapshot) || ids.length > 128 ||
      ids.some(id => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))) throw Error('Invalid artwork snapshot.');
  const response = await fetch(transport.endpoint, { method: 'POST', signal, cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schema: 1, operation: 'studio-items', snapshot: transport.snapshot, ids }) });
  if (!response.ok) throw Object.assign(Error(response.status === 409
    ? 'The catalog changed. Refresh the library before adding this artwork.'
    : 'The artwork sources could not load. Your current canvas is preserved.'), { status: response.status });
  const reply = await response.json();
  if (reply?.schema !== 1 || reply.snapshot !== transport.snapshot || !Array.isArray(reply.result) ||
      reply.result.length !== ids.length) throw Error('The artwork source snapshot differs.');
  return reply.result.map((asset: SnapshotStudioAsset | null, i: number) =>
    asset === null ? null : validateStudioAsset(asset, ids[i]));
}
