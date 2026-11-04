import type { RasterAsset } from './raster';
import { catalogProtocolHeaders } from '../lib/catalog-protocol.ts';
import { studioBucket } from './studio-bucket';
import { requestPinnedStudioAssets, type SnapshotTransport } from '../lib/snapshot-studio';
type Manifest = {
  schema: number;
  buckets: Record<string, string>;
  topics?: Record<string, string>;
  transport?: SnapshotTransport;
};
const selectedSnapshots = new Map<string, SnapshotTransport>();
/** Pin only a root, never client-supplied URLs or hashes. The server resolves source facts. */
export function pinRasterSnapshot(id: string, transport: SnapshotTransport) {
  if (!/^[a-z0-9-]+$/.test(id) || transport.protocol !== 'snapshot-search-v1' ||
      transport.endpoint !== '/catalog-search.json' || !/^[a-f0-9]{64}$/.test(transport.snapshot))
    throw Error('Invalid selected artwork snapshot.');
  selectedSnapshots.set(id, Object.freeze({ ...transport }));
  if (selectedSnapshots.size > 128) selectedSnapshots.delete(selectedSnapshots.keys().next().value!);
}
export function unpinRasterSnapshot(id: string) { selectedSnapshots.delete(id); }
let manifest: Promise<Manifest> | undefined;
const chunks = new Map<string, Promise<RasterAsset[]>>();
async function getManifest() {
  return (manifest ??= fetch('/studio-manifest.json', { cache: 'no-cache', headers: catalogProtocolHeaders })
    .then(async (response) => {
      if (!response.ok) throw Error('The artwork source directory could not load.');
      const value = await response.json();
      if (value.schema !== 1 ||
          (!value.transport && (!value.buckets || typeof value.buckets !== 'object')) ||
          (value.transport && (value.transport.protocol !== 'snapshot-search-v1' ||
            value.transport.endpoint !== '/catalog-search.json' || !/^[a-f0-9]{64}$/.test(value.transport.snapshot))))
        throw Error('The artwork source directory is invalid.');
      return value as Manifest;
    })
    .catch((error) => {
      manifest = undefined;
      throw error;
    }));
}
/** Resolve only requested sources. An opened project or starter no longer needs
 * the entire 15 MB library. Original hash/dimension verification still happens
 * in openRaster and prepareProjectSources before editing or exporting. */
export async function lookupRasterAssets(ids: string[]): Promise<RasterAsset[]> {
  if (!ids.length) return [];
  if (ids.some((id) => !/^[a-z0-9-]+$/.test(id))) throw Error('Invalid artwork source ID.');
  if (ids.some(id => selectedSnapshots.has(id))) {
    const selected = ids.map(id => selectedSnapshots.get(id));
    if (selected.some(t => !t || t.snapshot !== selected[0]?.snapshot))
      throw Error('Selected artwork uses different catalog snapshots. Your canvas is preserved.');
    try {
      const items = await requestPinnedStudioAssets(selected[0]!, ids);
      if (items.some(a => a === null)) throw Error('Selected artwork is unavailable. Your canvas is preserved.');
      return items as RasterAsset[];
    } finally { ids.forEach(id => selectedSnapshots.delete(id)); }
  }
  const index = await getManifest();
  if (index.transport) {
    try {
      const items = await requestPinnedStudioAssets(index.transport, ids);
      if (items.some(a => a === null)) throw Error('This artwork is unavailable. Your canvas is preserved.');
      return items as RasterAsset[];
    } catch (error) { manifest = undefined; throw error; }
  }
  const lists = await Promise.all(
    [...new Set(ids.map(studioBucket))].map((bucket) => {
      const url = index.buckets[bucket];
      if (url !== `/studio-data/${bucket}.json`) throw Error('This artwork source is unavailable.');
      let request = chunks.get(url);
      if (!request) {
        request = fetch(url)
          .then(async (response) => {
            if (!response.ok) throw Error('The artwork sources could not load.');
            const items = await response.json();
            if (
              !Array.isArray(items) ||
              items.some(
                (item) => !item || typeof item.id !== 'string' || studioBucket(item.id) !== bucket,
              )
            )
              throw Error('The artwork source chunk is invalid.');
            return items as RasterAsset[];
          })
          .catch((error) => {
            chunks.delete(url);
            throw error;
          });
        chunks.set(url, request);
      }
      return request;
    }),
  );
  const found = new Map(lists.flat().map((item) => [item.id, item]));
  return ids.map((id) => {
    const item = found.get(id);
    if (!item) throw Error('This artwork is unavailable. Your current canvas is preserved.');
    return item;
  });
}

/** A subject choice transfers its own metadata instead of the complete library. */
export async function lookupTopicAssets(topic: string): Promise<RasterAsset[]> {
  if (!/^[a-z0-9-]+$/.test(topic)) throw Error('Invalid artwork subject.');
  const index = await getManifest(),
    url = index.topics?.[topic];
  if (url !== `/studio-topics/${topic}.json`) throw Error('This artwork subject is unavailable.');
  let request = chunks.get(url);
  if (!request) {
    request = fetch(url)
      .then(async (response) => {
        if (!response.ok) throw Error('The artwork subject could not load.');
        const items = await response.json();
        if (
          !Array.isArray(items) ||
          items.some((item) => !item || typeof item.id !== 'string' || item.topic !== topic)
        )
          throw Error('The artwork subject chunk is invalid.');
        return items as RasterAsset[];
      })
      .catch((error) => {
        chunks.delete(url);
        throw error;
      });
    chunks.set(url, request);
  }
  return request;
}
