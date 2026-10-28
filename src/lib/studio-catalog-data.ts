import { publishedArt } from './catalog';
import { featuredStudioIds } from './studio-artwork';
import { studioBucket } from '../editor/studio-bucket';

export const studioCatalog = publishedArt
  .filter((a) => a.sourceType === 'raster')
  .map((a) => ({
    id: a.id,
    title: a.title,
    alt: a.alt,
    topic: a.topic,
    style: a.style,
    featured: featuredStudioIds.has(a.id),
    createdAt: a.createdAt,
    monochrome: a.monochrome,
    thumb: a.originalThumb,
    width: a.width,
    height: a.height,
    webp: { url: a.webp, ...a.files.webp },
    pdf: { url: a.pdf, ...a.files.pdf },
  }));
const buckets = new Map<string, typeof studioCatalog>();
for (const item of studioCatalog) {
  const bucket = studioBucket(item.id);
  if (!buckets.has(bucket)) buckets.set(bucket, []);
  buckets.get(bucket)!.push(item);
}
export const studioShards = [...buckets].map(([bucket, items]) => {
  const body = JSON.stringify(items);
  // Revalidated stable URLs also work for tabs opened before a deployment.
  // Originals inside the metadata retain immutable URLs and SHA-256 checks.
  return { bucket, file: `${bucket}.json`, body };
});
export const studioManifest = {
  schema: 1,
  buckets: Object.fromEntries(studioShards.map((s) => [s.bucket, `/studio-data/${s.file}`])),
};
