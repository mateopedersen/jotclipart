import { brand } from '../../src/lib/brand.mjs';
import { contactEmail, contactFormUrl, contactTopicField } from '../../src/lib/contact.ts';
import { publicRouteForId } from '../catalog-snapshot/public-artwork-routes.mjs';
import { mapFour } from './bounded-map.mjs';
import { readPages } from '../catalog-projections/pages.mjs';
// Source-derived public UI metadata. Not a source approver or production signer.
import { canonical, digest, makeStore, mapGet } from './store.mjs';
const encode = (x) => new TextEncoder().encode(JSON.stringify(canonical(x)));
export async function attachUiMetadata(store, dataDescriptor, source) {
  const data = await store.get(dataDescriptor);
  if (data.ui) throw Error('Attach only to a bare data root');
  const pack = async (type, values) => {
    const pages = [];
    let batch = [],
      offset = 0;
    for (const value of values) {
      if (
        encode({ schema: 1, type, offset, entries: [...batch, value] }).length > 48000 &&
        batch.length
      ) {
        pages.push({
          offset,
          count: batch.length,
          ...(await store.put({ type, offset, entries: batch })),
        });
        offset += batch.length;
        batch = [];
      }
      batch.push(value);
    }
    if (batch.length)
      pages.push({
        offset,
        count: batch.length,
        ...(await store.put({ type, offset, entries: batch })),
      });
    return pages;
  };
  const record = {
    type: 'source-bound-search-ui-v1',
    dataRoot: dataDescriptor,
    sourceSha256: await digest(encode(source)),
    site: await pack('public-site-search-entries', source.site),
    categories: await pack('studio-category-entries', source.categories),
    mono: await pack('monochrome-topic-entries', source.monochrome.topics),
    monoGlobal: {
      total: source.monochrome.total,
      collections: source.monochrome.collections,
      kinds: source.monochrome.kinds,
    },
    featuredIds: source.featuredIds,
  };
  const ui = await store.put(record),
    manifest = { ...data, ui };
  return { manifest, descriptor: await store.put(manifest), ui };
}
export async function readUi(ctx, data) {
  if (!data.manifest.ui)
    throw Object.assign(Error('Bound UI metadata unavailable'), { status: 501 });
  const ui = await data.store.get(data.manifest.ui);
  if (!['source-bound-search-ui-v1', 'source-bound-search-ui-v2'].includes(ui.type))
    throw Error('Wrong UI source protocol');
  const { ui: _, ...bare } = data.manifest,
    body = encode(bare);
  if (ui.dataRoot?.sha256 !== (await digest(body)) || ui.dataRoot.bytes !== body.length)
    throw Error('UI/search source snapshot differs');
  return ui;
}
async function legacyEntries(store, pages, type) {
  if (!Array.isArray(pages) || pages.length > 128) throw Error('UI page budget exceeded');
  const result = [],
    loaded = await mapFour(pages, (d) => store.get(d));
  let offset = 0;
  for (const [i, d] of pages.entries()) {
    const value = loaded[i];
    if (
      value.type !== type ||
      value.offset !== offset ||
      d.offset !== offset ||
      !Array.isArray(value.entries) ||
      value.entries.length !== d.count
    )
      throw Error('Invalid UI metadata page');
    result.push(...value.entries);
    offset += d.count;
    if (result.length > 10000) throw Error('UI entry budget exceeded');
  }
  return result;
}
export async function readUiEntries(store, ui, name, type) {
  return ui.type === 'source-bound-search-ui-v2'
    ? (await readPages(store, ui[name], type, { stable: true })).entries
    : legacyEntries(store, ui[name], type);
}
// The migration retained signed directory records from the former site. Apply
// the current public identity to those verified page descriptions at read time.
const legacyPages = new Set([
  '/about/',
  '/ai-clipart-generator/',
  '/collections/',
  '/contact/',
  '/cookies/',
  '/create/',
  '/for-teachers/',
  '/guides/',
  '/guides/make-a-classroom-label/',
  '/guides/webp-pdf-and-editable-projects/',
  '/library-index/',
  '/new/',
  '/license/',
  '/privacy/',
  '/terms/',
  '/copyright/',
  '/accessibility/',
  '/faq/',
  '/editorial-process/',
]);
const legacyForm =
  'https://docs.google.com/forms/d/e/1FAIpQLSc2fOKsmo2Ypr7EkTV9jqBO7BhyAX8HYBxcIHNybkD5fC5HRw/viewform';
function currentSiteEntry(entry) {
  if (
    !legacyPages.has(entry.href) ||
    !['page', 'tool', 'guide'].includes(entry.kind) ||
    ![`page:${entry.href}`, `info:${entry.href.slice(1, -1)}`].includes(entry.id)
  )
    return entry;
  const project = (value) =>
    value
      .replace(/\bultraclipart@gmail\.com\b/gi, contactEmail)
      .replaceAll(legacyForm, contactFormUrl)
      .replaceAll('entry.1751201779', contactTopicField)
      .replace(/\b(?:www\.)?ultraclipart\.com\b/gi, new URL(brand.origin).hostname)
      .replace(/\bultraclipart\b/gi, brand.name);
  return {
    ...entry,
    title: project(entry.title),
    description: project(entry.description),
    text: project(entry.text),
  };
}

export const uiProviders = {
  async readPublicRoutes(ctx, data) {
    return {
      snapshotSha256: ctx.snapshotSha256,
      value: await mapFour(data.ids, async (id) => ({
        id,
        slug: typeof ctx.getFacet === 'function' ? await publicRouteForId(ctx, id) : id,
      })),
    };
  },
  async readSuggestionThumbnails(ctx, data) {
    if (!Array.isArray(data.ids) || data.ids.length > 8)
      throw Error('Bounded suggestion identities required');
    const value = await mapFour(data.ids, async (id) => {
      const identity = await mapGet(data.store, data.manifest.ids, 'identities', id);
      if (!identity?.active) throw Error('Suggestion identity absent');
      const descriptor = await mapGet(
        data.store,
        data.manifest.ledger,
        'search-ledger',
        String(Math.floor(identity.n / 8)),
      );
      if (!descriptor) throw Error('Suggestion source absent');
      const page = await data.store.get(descriptor),
        doc = page.documents?.[identity.n % 8];
      if (
        page.type !== 'search-ledger' ||
        doc?.id !== id ||
        !doc.active ||
        doc.sourceSha256 !== identity.sourceSha256
      )
        throw Error('Suggestion source differs');
      return { id, thumb: doc.studio?.thumb ?? null, webp: doc.studio?.webp?.url ?? null };
    });
    return { snapshotSha256: ctx.snapshotSha256, value };
  },
  async readStudioInfo(ctx, data) {
    return { snapshotSha256: ctx.snapshotSha256, value: await studioInfo(ctx, data) };
  },
  async readSiteEntries(ctx, data) {
    const ui = await readUi(ctx, data);
    return {
      snapshotSha256: ctx.snapshotSha256,
      value: (await readUiEntries(data.store, ui, 'site', 'public-site-search-entries')).map(
        currentSiteEntry,
      ),
    };
  },
  async readMonochromeDirectory(ctx, data) {
    const ui = await readUi(ctx, data);
    return {
      snapshotSha256: ctx.snapshotSha256,
      value: {
        ...ui.monoGlobal,
        topics: await readUiEntries(data.store, ui, 'mono', 'monochrome-topic-entries'),
      },
    };
  },
  async readStudioItems(ctx, data) {
    if (
      !Array.isArray(data.ids) ||
      data.ids.length > 500 ||
      data.ids.some((id) => typeof id !== 'string' || !/^([a-z0-9]+(?:-[a-z0-9]+)*)$/.test(id))
    )
      throw Error('Bounded Studio identities required');
    const ui = await readUi(ctx, data),
      featured = new Set(ui.featuredIds),
      value = Array(data.ids.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, data.ids.length) }, async () => {
        while (next < data.ids.length) {
          const index = next++,
            id = data.ids[index],
            identity = await mapGet(data.store, data.manifest.ids, 'identities', id);
          if (!identity?.active) {
            value[index] = null;
            continue;
          }
          const d = await mapGet(
            data.store,
            data.manifest.ledger,
            'search-ledger',
            String(Math.floor(identity.n / 8)),
          );
          if (!d) throw Error('Studio ledger absent');
          const page = await data.store.get(d),
            doc = page.documents?.[identity.n % 8];
          if (page.type !== 'search-ledger' || doc?.id !== id || !doc.active || !doc.studio)
            throw Error('Studio source absent');
          value[index] = { ...doc.studio, featured: featured.has(id) };
        }
      }),
    );
    return { snapshotSha256: ctx.snapshotSha256, value };
  },
};
export async function studioInfo(ctx, data) {
  const ui = await readUi(ctx, data),
    provider = await uiProviders.readStudioItems(ctx, { ...data, ids: ui.featuredIds });
  return {
    items: provider.value,
    total: data.manifest.total,
    topics: data.manifest.topics.map((t) => t.slug),
    categories: await readUiEntries(data.store, ui, 'categories', 'studio-category-entries'),
    transport: {
      protocol: 'snapshot-search-v1',
      endpoint: '/catalog-search.json',
      snapshot: ctx.snapshotSha256,
    },
  };
}
