import { displayCatalogTitle } from '../../src/lib/display-title.ts';
import { readPublicArtwork } from '../catalog-snapshot/public-artwork-routes.mjs';
import { openSevenFacetCollectionContext } from '../catalog-snapshot/collection-context.mjs';
import { readShellPageState } from '../catalog-snapshot/shell-page-data.mjs';
import { curatedBySlug } from '../../src/lib/curated-collection-policy.mjs';
import { readShellField } from '../catalog-projections/shell.mjs';
import { ogSHA256 } from './og-image.mjs';
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE_ASSETS = new Set(['https://assets.ultraclipart.com', 'https://assets.jotclipart.com']);
const fail = (message) => {
  throw Error(message);
};
export function catalogOgRoute(path) {
  const match =
    /^\/og\/catalog\/(art|topic|collection|editor)\/([a-z0-9-]+)\/([a-f0-9]{64})\.png$/.exec(path);
  return match ? { kind: match[1], id: match[2], digest: match[3] } : undefined;
}
/** The full WebP alias named thumb is deliberately never used here. */
export function originalOgThumbnail(item) {
  if (!item?.published || !item.indexable || !SLUG.test(item.id ?? ''))
    fail('OG artwork is not public');
  const url = new URL(item.originalThumb);
  const file = item.files?.thumb;
  if (
    !SOURCE_ASSETS.has(url.origin) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !file ||
    !/^[a-f0-9]{64}$/.test(file.sha256 ?? '') ||
    !Number.isSafeInteger(file.bytes) ||
    file.bytes <= 0 ||
    file.bytes > 1024 * 1024 ||
    !url.pathname.endsWith('.webp')
  )
    fail('Source-bound original OG thumbnail required');
  return {
    objectKey: decodeURIComponent(url.pathname.slice(1)),
    mime: 'image/webp',
    bytes: file.bytes,
    sha256: file.sha256,
  };
}
const collectionTitle = (value) => {
  const heading = displayCatalogTitle(value);
  return heading + (/\bClipart$/i.test(heading) ? '' : ' Clipart') + ' Collection';
};
function canonicalSource(value) {
  if (Array.isArray(value)) return value.map(canonicalSource);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .filter((k) => k !== 'publicSlug')
        .sort()
        .map((k) => [k, canonicalSource(value[k])]),
    );
  return value;
}
export async function resolveOgCollectionCluster(context, collectionContext, id) {
  if (!SLUG.test(id ?? '')) return undefined;
  // Curated shell selection takes its stable registry slug, not its title.
  if (curatedBySlug.has(id)) return id;
  if (!Object.hasOwn(collectionContext.global.collections, id)) return undefined;
  // Global counts contain counts, not display names. Resolve the primary name
  // from the same authenticated shell field used by the HTML route.
  const root = await context.read('collections', collectionContext.collections.shells, {
    maxBytes: 65536,
  });
  const names = await readShellField(context, root, 'clusters');
  if (names.some((name) => typeof name !== 'string')) fail('Wrong signed OG cluster names');
  const matches = names.filter(
    (name) =>
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') === id,
  );
  if (matches.length > 1) fail('Ambiguous signed OG cluster');
  return matches[0];
}
export async function catalogOgSource({ kind, id, state, context }) {
  if (!context || !/^[a-f0-9]{64}$/.test(context.rootSHA256 ?? '') || !SLUG.test(id ?? ''))
    fail('Authenticated OG page state required');
  let title, canonicalPath, selected, metadata;
  if (kind === 'art' || kind === 'editor') {
    const item = state.item;
    if (item?.id !== id) fail('Wrong OG artwork');
    selected = [item];
    title = kind === 'art' ? displayCatalogTitle(item.title) : `Edit ${item.title}`;
    canonicalPath = kind === 'art' ? `/art/${item.publicSlug ?? item.id}/` : `/edit/${item.id}/`;
    metadata = { item };
  } else if (kind === 'topic') {
    const topic = state.topic;
    if (topic?.slug !== id) fail('Wrong OG topic');
    const first = state.copy?.[id]?.featured?.[0];
    const cover = state.art.find((a) => (first ? a.id === first : a.topic === id));
    if (!cover || cover.topic !== id) fail('Missing topic OG cover');
    selected = [cover];
    title = displayCatalogTitle(topic.keyword);
    canonicalPath = `/clipart/${id}/`;
    metadata = {
      topic,
      summary: state.summaries?.get(id),
      paragraphs: state.paragraphs?.get(id),
      cover,
    };
  } else if (kind === 'collection') {
    const group =
      state.curatedCollections?.find((g) => g.slug === id) ??
      state.categoryCollections?.find((g) => g.slug === id);
    if (!group) fail('Missing authenticated OG collection');
    selected = (group.previews ?? []).slice(0, 2);
    if (!selected.length) fail('Missing reviewed OG collection covers');
    title = collectionTitle(group.title ?? state.props?.cluster ?? state.cluster);
    canonicalPath = `/collection/${id}/`;
    metadata = {
      id,
      title: group.title,
      summary: group.summary ?? group.description,
      paragraphs: group.paragraphs,
      topics: group.topicSlugs ?? group.topics?.map((t) => t.slug),
      selected,
    };
  } else fail('Unsupported authenticated OG page family');
  const images = selected.map(originalOgThumbnail);
  const sourceSHA256 = await ogSHA256(
    new TextEncoder().encode(JSON.stringify(canonicalSource(metadata))),
  );
  return { kind, id, title, canonicalPath, sourceSHA256, sourceRoot: context.rootSHA256, images };
}
export async function readCatalogOgSource({ bucket, context, kind, id, allowFixture = false }) {
  if (!SLUG.test(id ?? '')) return undefined;
  let state;
  if (kind === 'art' || kind === 'editor') {
    const item = await readPublicArtwork(context, id);
    if (!item) return undefined;
    state = { item };
  } else {
    const cc = await openSevenFacetCollectionContext(bucket, {
      snapshot: context.snapshot,
      allowUnpublishableFixture: allowFixture,
    });
    if (kind === 'topic') {
      const entry = await cc.lookupCollection(id);
      if (!entry) return undefined;
      const record = await cc.read(entry, 256 * 1024);
      if (
        record.slug !== id ||
        record.path !== `/clipart/${id}/` ||
        !['collection-topic', 'collection-topic-references'].includes(record.type)
      )
        fail('Wrong signed OG topic record');
      const cover = await readPublicArtwork(context, record.coverArtworkId);
      if (!cover || cover.topic !== id) fail('Wrong signed OG topic cover');
      state = {
        topic: {
          slug: record.slug,
          keyword: record.keyword,
          cluster: record.primaryCluster,
          sourceCluster: record.sourceCluster,
        },
        art: [cover],
        copy: { [id]: { featured: [cover.id] } },
        summaries: new Map([[id, record.summary]]),
        paragraphs: new Map([[id, record.paragraphs]]),
      };
    } else if (kind === 'collection') {
      const cluster = await resolveOgCollectionCluster(context, cc, id);
      if (!cluster) return undefined;
      state = await readShellPageState(bucket, context, 'cluster', { cluster, allowFixture });
      if (!state) return undefined;
    } else return undefined;
  }
  return catalogOgSource({ kind, id, state, context });
}
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export function applyCatalogOgMetadata(html, descriptor) {
  const values = {
    'og:image': descriptor.url,
    'og:image:secure_url': descriptor.url,
    'og:image:type': descriptor.type,
    'og:image:width': descriptor.width,
    'og:image:height': descriptor.height,
    'og:image:alt': `${descriptor.title} — JotClipart`,
    'twitter:image': descriptor.url,
    'twitter:image:alt': `${descriptor.title} — JotClipart`,
  };
  for (const [key, value] of Object.entries(values)) {
    const attribute = key.startsWith('twitter:') ? 'name' : 'property';
    const pattern = new RegExp(`<meta\\b(?=[^>]*\\b${attribute}=["']${key}["'])[^>]*>`, 'gi');
    const matches = html.match(pattern) ?? [];
    if (matches.length > 1 || (!matches.length && ['og:image', 'twitter:image'].includes(key)))
      fail('Ambiguous catalog OG metadata');
    const tag = `<meta ${attribute}="${key}" content="${escape(value)}">`;
    html = matches.length
      ? html.replace(pattern, () => tag)
      : html.replace('</head>', tag + '</head>');
  }
  return html;
}
