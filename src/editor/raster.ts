import { isEditorScreenURL, publicLoadingImageURL } from '../lib/image-loading-preview';
import { catalogProtocolHeaders } from '../lib/catalog-protocol.ts';
import { clone, identity, type EditorDocument, type RasterLayer } from './model';
import type { VerifiedRepresentation as Representation } from './source-policy';
import { readVerified } from './verified-fetch';
import { lookupRasterAssets } from './studio-sources';
import type { SnapshotTransport } from '../lib/snapshot-studio';
export interface RasterAsset {
  id: string;
  title?: string;
  width: number;
  height: number;
  webp: Representation;
  pdf: Representation;
  screen?: { url: string; width?: number; height?: number };
}
export interface LocalSource {
  id: string;
  sha256: string;
  data: string;
}
interface LoadedAsset {
  local?: LocalSource;
  asset: RasterAsset;
  preview?: string;
  sourceRequest?: Promise<HTMLImageElement>;
  screen?: { url: string; width: number; height: number };
  image?: HTMLImageElement;
  pdf?: Promise<Uint8Array<ArrayBuffer>>;
}
// Projects contain compact, hash-bound references, never executable image URLs.
// Only the current catalog page can register a source. Undo does not copy bitmap bytes.
const assets = new Map<string, LoadedAsset>();
async function decodeScreen(asset: RasterAsset): Promise<LoadedAsset['screen']> {
  const screen = asset.screen;
  if (!screen) return;
  const screenCopy = isEditorScreenURL(screen.url) && screen.width !== undefined && screen.height !== undefined;
  if (!screenCopy && !publicLoadingImageURL(screen.url)) return;
  const display = new Image();
  display.src = screen.url;
  try {
    await display.decode();
    const width = display.naturalWidth;
    const height = display.naturalHeight;
    const sameFraming = Math.abs(width * asset.height - height * asset.width) <= Math.max(asset.width, asset.height);
    if (!width || !height || !sameFraming || (screen.width !== undefined && width !== screen.width) ||
      (screen.height !== undefined && height !== screen.height)) return;
    return { url: screen.url, width, height };
  } catch {
    // The verified original also works if its display derivative fails.
    return undefined;
  }
}
function ensureOriginal(loaded: LoadedAsset): Promise<HTMLImageElement> {
  if (loaded.image) return Promise.resolve(loaded.image);
  return (loaded.sourceRequest ??= (async () => {
    const bytes = await readVerified(loaded.asset.webp, 'webp');
    const preview = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('The image could not be opened.'));
      reader.readAsDataURL(new Blob([bytes], { type: 'image/webp' }));
    });
    const image = new Image();
    image.src = preview;
    await image.decode();
    if (image.naturalWidth !== loaded.asset.width || image.naturalHeight !== loaded.asset.height)
      throw new Error('Image dimensions differ from the verified catalog.');
    loaded.preview = preview;
    loaded.image = image;
    return image;
  })().finally(() => {
    loaded.sourceRequest = undefined;
  }));
}

export async function openRaster(asset: RasterAsset, openFromScreen = false): Promise<EditorDocument> {
  if (
    !/^[a-z0-9-]+$/.test(asset.id) ||
    ![asset.width, asset.height].every((v) => Number.isInteger(v) && v > 0 && v <= 4096)
  )
    throw new Error('Invalid image dimensions.');
  const loaded: LoadedAsset = { asset };
  const screenReady = decodeScreen(asset);
  if (openFromScreen) loaded.screen = await screenReady;
  if (!loaded.screen) {
    const [, screen] = await Promise.all([ensureOriginal(loaded), screenReady]);
    loaded.screen = screen;
  }
  assets.set(asset.id, loaded);
  return {
    version: 2,
    artId: asset.id,
    width: asset.width,
    height: asset.height,
    background: 'transparent',
    crop: null,
    print: { paper: 'letter', orientation: 'portrait', margin: 0.5, scale: 'fit' },
    layers: [
      {
        id: 'original-image',
        label: 'Original image',
        kind: 'raster',
        assetId: asset.id,
        sourceSha256: asset.webp.sha256,
        width: asset.width,
        height: asset.height,
        visible: true,
        locked: false,
        opacity: 1,
        ...identity(),
      },
    ],
  };
}
export function requireRaster(layer: RasterLayer) {
  const loaded = assets.get(layer.assetId);
  if (
    !loaded ||
    loaded.asset.webp.sha256 !== layer.sourceSha256 ||
    loaded.asset.width !== layer.width ||
    loaded.asset.height !== layer.height
  )
    throw new Error('This project references an image that is not available for this artwork.');
  return loaded;
}
export function rasterPreview(layer: RasterLayer, screenScale = Infinity) {
  const { screen, preview } = requireRaster(layer);
  if (
    screen &&
    Number.isFinite(screenScale) &&
    (!preview ||
      (screen.width >= layer.width * Math.abs(layer.scaleX) * screenScale &&
        screen.height >= layer.height * Math.abs(layer.scaleY) * screenScale))
  )
    return screen.url;
  if (!preview) throw new Error('The original image has not been verified yet.');
  return preview;
}

/** Pixel operations and portable exports always await the exact source. */
export async function ensureDocumentOriginals(doc: EditorDocument) {
  const sources = new Set(
    doc.layers.filter((l): l is RasterLayer => l.kind === 'raster' && l.visible).map(requireRaster),
  );
  await Promise.all([...sources].map(ensureOriginal));
}

export async function rasterPixels(layer: RasterLayer) {
  const image = await ensureOriginal(requireRaster(layer));
  const canvas = document.createElement('canvas');
  canvas.width = layer.width;
  canvas.height = layer.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Image processing is unavailable in this browser.');
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, layer.width, layer.height);
}
let catalog: Promise<RasterAsset[]> | undefined;
export interface StudioCategory {
  id: string;
  title: string;
  thumb: string;
  topics: { id: string; title: string; count: number; thumb: string }[];
}
let featuredCatalog:
  | Promise<{
      items: RasterAsset[];
      total: number;
      topics: string[];
      categories?: StudioCategory[];
      transport?: SnapshotTransport;
    }>
  | undefined;
export function featuredRasterCatalog() {
  return (featuredCatalog ??= fetch('/studio-featured.json', { headers: catalogProtocolHeaders })
    .then(async (response) => {
      if (!response.ok) throw new Error('The featured library could not be loaded.');
      return (await response.json()) as {
        items: RasterAsset[];
        total: number;
        topics: string[];
        categories?: StudioCategory[];
        transport?: SnapshotTransport;
      };
    })
    .catch((error) => {
      featuredCatalog = undefined;
      throw error;
    }));
}
export function rasterCatalog() {
  return (catalog ??= fetch('/studio-catalog.json', { headers: catalogProtocolHeaders })
    .then(async (response) => {
      if (!response.ok) throw new Error('The clipart catalog could not be loaded.');
      return (await response.json()) as RasterAsset[];
    })
    .catch((error) => {
      catalog = undefined;
      throw error;
    }));
}
/** Imported projects only name catalogue IDs. URLs/hashes always come from our own manifest. */
export async function prepareProjectSources(doc: EditorDocument) {
  const attached = (doc as EditorDocument & { localSources?: LocalSource[] }).localSources;
  if (attached !== undefined) {
    if (
      !Array.isArray(attached) ||
      attached.length > 12 ||
      JSON.stringify(attached).length > 16000000
    )
      throw new Error('Local project sources exceed the supported size.');
    for (const source of attached) {
      if (
        !source ||
        typeof source.data !== 'string' ||
        !/^data:image\/(png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(source.data) ||
        source.data.length > 5400000 ||
        source.id !== `local-${source.sha256}` ||
        !/^[a-f0-9]{64}$/.test(source.sha256) ||
        !doc.layers.some(
          (l) => l.kind === 'raster' && l.assetId === source.id && l.sourceSha256 === source.sha256,
        )
      )
        throw new Error('The project contains an invalid local image source.');
      {
        const raw = atob(source.data.split(',')[1]),
          bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
        const loaded = await registerLocalImage(bytes);
        if (loaded.assetId !== source.id)
          throw new Error('Local image checksum verification failed.');
      }
    }
  }
  const missing = doc.layers.filter(
    (l): l is RasterLayer => l.kind === 'raster' && !assets.has(l.assetId),
  );
  for (const layer of doc.layers)
    if (layer.kind === 'raster' && assets.has(layer.assetId)) requireRaster(layer);
  if (!missing.length) return;
  const list = await lookupRasterAssets([...new Set(missing.map((layer) => layer.assetId))]);
  for (const layer of missing) {
    const entry = list.find(
      (a) =>
        a.id === layer.assetId &&
        a.webp.sha256 === layer.sourceSha256 &&
        a.width === layer.width &&
        a.height === layer.height,
    );
    if (!entry)
      throw new Error(
        'A project source no longer matches this catalog. The original project has been preserved.',
      );
    await openRaster(entry);
  }
}
export async function rasterPdf(layer: RasterLayer) {
  const loaded = requireRaster(layer);
  loaded.pdf ??= readVerified(loaded.asset.pdf, 'pdf').catch((error) => {
    loaded.pdf = undefined;
    throw error;
  });
  return loaded.pdf;
}

/** Browser-only files are embedded when saving, never sent to an upload service. */
export async function registerLocalImage(bytes: Uint8Array): Promise<RasterLayer> {
  const { localImageHeader } = await import('./smart/local-image'),
    { width, height, mime } = localImageHeader(bytes);
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join(''),
    id = `local-${hash}`;
  if (!assets.has(id)) {
    const preview = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error('Could not read the image.'));
      r.readAsDataURL(new Blob([new Uint8Array(bytes)], { type: mime }));
    });
    const image = new Image();
    image.src = preview;
    await image.decode();
    if (image.naturalWidth !== width || image.naturalHeight !== height)
      throw new Error('Image dimensions did not match the file header.');
    assets.set(id, {
      asset: {
        id,
        width,
        height,
        webp: { url: '', sha256: hash, bytes: bytes.length },
        pdf: { url: '', sha256: '', bytes: 0 },
      },
      image,
      preview,
      local: { id, sha256: hash, data: preview },
    });
  }
  return {
    kind: 'raster',
    id: `image-${crypto.randomUUID()}`,
    assetId: id,
    sourceSha256: hash,
    width,
    height,
    label: 'Your uploaded clipart',
    visible: true,
    locked: false,
    opacity: 1,
    ...identity(),
  };
}
export function isLocalRaster(layer: RasterLayer) {
  return !!requireRaster(layer).local;
}
export function serializeProject(
  doc: EditorDocument,
): EditorDocument & { localSources?: LocalSource[] } {
  const ids = new Set(
      doc.layers.filter((l): l is RasterLayer => l.kind === 'raster').map((l) => l.assetId),
    ),
    localSources = [...ids].map((id) => assets.get(id)?.local).filter((s): s is LocalSource => !!s);
  return localSources.length ? { ...clone(doc), localSources } : clone(doc);
}
export function withoutEmbeddedSources(doc: EditorDocument): EditorDocument {
  const next = clone(doc) as EditorDocument & { localSources?: unknown };
  delete next.localSources;
  return next;
}
