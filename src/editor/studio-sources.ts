import type { RasterAsset } from './raster';
import { studioBucket } from './studio-bucket';
type Manifest = { schema: number; buckets: Record<string, string> };
let manifest: Promise<Manifest> | undefined;
const chunks = new Map<string, Promise<RasterAsset[]>>();
async function getManifest() {
  return (manifest ??= fetch('/studio-manifest.json')
    .then(async (response) => {
      if (!response.ok) throw Error('The artwork source directory could not load.');
      const value = await response.json();
      if (value.schema !== 1 || !value.buckets || typeof value.buckets !== 'object')
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
  const index = await getManifest();
  const lists = await Promise.all(
    [...new Set(ids.map(studioBucket))].map((bucket) => {
      const url = index.buckets[bucket];
      if (!new RegExp(`^/studio-data/${bucket}-[a-f0-9]{64}\\.json$`).test(url ?? ''))
        throw Error('This artwork source is unavailable.');
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
