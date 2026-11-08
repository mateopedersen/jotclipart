import { readSurprisePicks } from './surprise-picks.mjs';
import { readStudioFeaturedCount } from './studio-featured-count.mjs';
// Private editor state. Original source identity remains authoritative.
import { readPublicArtwork as readArtwork } from './public-artwork-routes.mjs';
import { lookupHashedRecord } from './hashed-record-directory.mjs';
import { readSharedArtwork } from './shared-artwork-context.mjs';
import { openSevenFacetCollectionContext } from './collection-context.mjs';
export async function readEditorPageState(bucket, context, id, { allowFixture = false } = {}) {
  const item = await readArtwork(context, id);
  if (!item) return undefined;
  const collections = await openSevenFacetCollectionContext(bucket, {
    snapshot: context.snapshot,
    allowUnpublishableFixture: allowFixture,
  });
  const [artRoot, features, featuredStudioCount] = await Promise.all([
    context.getFacet('artworks'),
    collections.read(collections.root.features, 256 * 1024),
    readStudioFeaturedCount(context, collections.collections.studioFeatured),
  ]);
  let editorItem = item;
  if (item.sourceType === 'raster') {
    const decision = await lookupHashedRecord(context, 'artworks', artRoot.editorPreviews, id);
    if (!decision) throw Error('Missing editor source decision');
    if (
      decision.schema !== 1 ||
      decision.type !== 'editor-source' ||
      decision.id !== id ||
      decision.sourceSHA256 !== item.files?.webp?.sha256
    )
      throw Error('Stale editor source decision');
    if (decision.preview) {
      if (
        !/^\/previews\/p1\/[a-f0-9]{24}-960\.webp$/.test(decision.preview) ||
        !Number.isSafeInteger(decision.width) ||
        decision.width < 1 ||
        !Number.isSafeInteger(decision.height) ||
        decision.height < 1 ||
        Math.max(decision.width, decision.height) > 960
      )
        throw Error('Invalid editor preview');
      editorItem = {
        ...item,
        preview: decision.preview,
        previewWidth: decision.width,
        previewHeight: decision.height,
      };
    }
  }
  if (
    !Array.isArray(features.artworks) ||
    !Array.isArray(features.surprise) ||
    features.artworks.length > 500 ||
    features.surprise.length > 500
  )
    throw Error('Invalid shared editor context');
  const surprise = collections.collections.surprise
    ? await readSurprisePicks(context, { limit: 48 })
    : features.surprise.map((p) => ({
        id: p.id,
        topic: p.topic,
        ...(Object.hasOwn(p, 'fresh') ? { fresh: p.fresh } : {}),
      }));
  const shared = await readSharedArtwork(context, features);
  return {
    item,
    editorItem,
    featuredStudioCount,
    featuredStudioArt: [],
    art: [item, ...shared],
    topics: [],
    counts: { ...collections.global, topics: {} },
    surprise,
    summaries: new Map(),
    paragraphs: new Map(),
    copy: {},
    relations: {},
    clusterNames: {},
  };
}
