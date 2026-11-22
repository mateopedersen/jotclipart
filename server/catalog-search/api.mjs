import { queryTerms } from '../../src/lib/search-language.ts';
import { mapFour } from './bounded-map.mjs';
import { publicSiteDirectory } from './site-directory-cache.mjs';
// Serving adapter only. The canonical publisher must supply captured authorization.
import { openSearch } from './runtime.mjs';
import { makeStore, mapGet, SEARCH_MANIFEST_MAX_BYTES, SEARCH_OBJECT_MAX_BYTES } from './store.mjs';
const SHA = /^[a-f0-9]{64}$/,
  ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
class ApiFault extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new ApiFault(status, message);
};
const freeze = (x) => {
  if (x && typeof x === 'object' && !Object.isFrozen(x)) {
    for (const v of Object.values(x)) freeze(v);
    Object.freeze(x);
  }
  return x;
};
// Only public, source-bound UI metadata is reused. Never cache a visitor query or result.
const manifestCache = new Map();
const headers = {
  'Content-Type': 'application/json',
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers });
// Both search and directory providers share this connection/body-consumption budget.
function boundedBucket(
  source,
  searchManifestKey,
  { maxReadObjects = 8000, maxReadBytes = 128 * 1024 * 1024 } = {},
) {
  let reads = 0,
    bytes = 0,
    slots = 4,
    pending = 0,
    peakPending = 0;
  const queue = [];
  return {
    get: async (key) => {
      if (++reads > maxReadObjects) fail(503, 'Catalog read budget exceeded');
      if (slots) slots--;
      else await new Promise((resolve) => queue.push(resolve));
      pending++;
      peakPending = Math.max(peakPending, pending);
      try {
        const object = await source.get(key);
        if (!object) return null;
        const limit =
          key === searchManifestKey ? SEARCH_MANIFEST_MAX_BYTES : SEARCH_OBJECT_MAX_BYTES;
        if (object.size > limit || (bytes += object.size) > maxReadBytes) {
          await object.body?.cancel?.();
          fail(503, 'Catalog byte budget exceeded');
        }
        const body = await object.arrayBuffer();
        if (body.byteLength !== object.size) fail(503, 'Truncated catalog object');
        return { size: object.size, arrayBuffer: async () => body };
      } finally {
        pending--;
        const next = queue.shift();
        if (next) next();
        else slots++;
      }
    },
    metrics: () => ({ reads, bytes, peakPending }),
  };
}
function stateFrom(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(400, 'Invalid search state');
  const state = {};
  for (const key of [
    'q',
    'style',
    'color',
    'format',
    'orientation',
    'background',
    'sort',
    'type',
  ]) {
    const text = value[key] ?? '';
    if (
      typeof text !== 'string' ||
      text.length > (key === 'q' ? 320 : 64) ||
      /[\u0000-\u001f]/.test(text)
    )
      fail(400, 'Invalid search field');
    state[key] = key === 'q' ? text.trim() : text.toLowerCase();
  }
  if (!['relevance', 'title', 'newest'].includes(state.sort)) fail(400, 'Invalid search order');
  state.page = value.page;
  state.size = value.size;
  if (
    !Number.isSafeInteger(state.page) ||
    state.page < 1 ||
    state.page > 10000 ||
    !Number.isSafeInteger(state.size) ||
    state.size < 1 ||
    state.size > 32
  )
    fail(400, 'Invalid search page');
  return state;
}
async function bodyOf(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
    fail(415, 'JSON required');
  if (Number(request.headers.get('content-length') ?? 0) > 32768) fail(413, 'Request too large');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'Request body missing');
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 32768) {
      await reader.cancel();
      fail(413, 'Request too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
  } catch {
    fail(400, 'Invalid JSON');
  }
}
function validateIds(ids) {
  if (
    !Array.isArray(ids) ||
    ids.length > 128 ||
    ids.some((id) => typeof id !== 'string' || id.length > 200 || !ID.test(id))
  )
    fail(400, 'Invalid artwork IDs');
  return ids;
}
function validateSite(entries) {
  if (
    !Array.isArray(entries) ||
    entries.length > 10000 ||
    entries.some(
      (e) =>
        !e ||
        typeof e.id !== 'string' ||
        typeof e.title !== 'string' ||
        typeof e.description !== 'string' ||
        typeof e.text !== 'string' ||
        !['topic', 'collection', 'guide', 'tool', 'page', 'studio'].includes(e.kind) ||
        typeof e.href !== 'string' ||
        !/^\/(?!\/)[^\s\\]*$/.test(e.href),
    )
  )
    fail(503, 'Invalid public directory');
  return entries;
}
function validateMono(directory, total) {
  if (
    !directory ||
    !Number.isSafeInteger(directory.total) ||
    directory.total < 0 ||
    directory.total > total ||
    !Array.isArray(directory.topics) ||
    !Array.isArray(directory.collections) ||
    !Array.isArray(directory.kinds) ||
    directory.topics.length > 10000 ||
    [...directory.topics, ...directory.collections, ...directory.kinds].some(
      (e) =>
        !e ||
        typeof e.slug !== 'string' ||
        !ID.test(e.slug) ||
        typeof e.label !== 'string' ||
        !Number.isSafeInteger(e.count) ||
        e.count < 1 ||
        e.count > directory.total,
    )
  )
    fail(503, 'Invalid monochrome directory');
  return directory;
}
export function createSnapshotSearchApi({
  captureAuthorizedSnapshot,
  readSiteEntries,
  readMonochromeDirectory,
  readStudioItems,
  readStudioInfo,
  readSuggestionThumbnails,
  readPublicRoutes,
  bucket,
  allowPrivateFixture = false,
  directoryCache,
  defer,
}) {
  if (typeof captureAuthorizedSnapshot !== 'function')
    throw Error('Captured authorization provider required');
  async function context(request) {
    const captured = await captureAuthorizedSnapshot(request),
      snapshotSha256 = captured?.rootSHA256 ?? captured?.snapshotSha256,
      searchDescriptor = captured?.searchDescriptor ?? captured?.snapshot?.indexes?.search,
      fixture =
        captured?.fixture === true ||
        captured?.snapshot?.fixture === true ||
        captured?.snapshot?.status === 'PRIVATE_UNPUBLISHABLE';
    if (
      !captured ||
      !SHA.test(snapshotSha256 ?? '') ||
      !(captured.bucket ?? bucket) ||
      !searchDescriptor
    )
      fail(503, 'Catalog unavailable');
    if (fixture) {
      if (!allowPrivateFixture) fail(503, 'Private fixture rejected');
    } else if (captured.authorizationVerified !== true) fail(503, 'Catalog authorization absent');
    return Object.freeze({
      ...captured,
      ...(captured.snapshot ? { snapshot: freeze(structuredClone(captured.snapshot)) } : {}),
      snapshotSha256,
      searchDescriptor: Object.freeze({ ...searchDescriptor }),
      bucket: boundedBucket(captured.bucket ?? bucket, searchDescriptor.key),
      fixture,
    });
  }
  async function dataset(ctx) {
    const engine = await openSearch(ctx.bucket, ctx.searchDescriptor, {
      allowPrivateFixture: ctx.fixture,
    });
    return {
      engine,
      manifest: engine.manifest,
      store: makeStore(ctx.bucket, { cacheLimit: 64, maxReads: 4000, maxBytes: 64 * 1024 * 1024 }),
    };
  }
  async function bound(provider, ctx, data) {
    if (typeof provider !== 'function') fail(501, 'Catalog operation not configured');
    const result = await provider(ctx, data);
    if (result?.snapshotSha256 !== ctx.snapshotSha256 || !Object.hasOwn(result, 'value'))
      fail(503, 'Directory snapshot differs');
    return result.value;
  }
  async function manifestFor(ctx, data) {
    const key = ctx.snapshotSha256 + '/' + ctx.searchDescriptor.sha256;
    if (!ctx.fixture && manifestCache.has(key)) return manifestCache.get(key);
    const mono = readMonochromeDirectory
      ? validateMono(await bound(readMonochromeDirectory, ctx, data), data.manifest.total)
      : undefined;
    if (mono)
      for (const kind of mono.kinds)
        if (!data.manifest.facetNames.includes('monochrome-kind/' + kind.slug))
          fail(503, 'Monochrome index incomplete');
    const value = {
      schema: 1,
      version: ctx.snapshotSha256,
      ranking: 2,
      total: data.manifest.total,
      pageChunk: 256,
      tokenBuckets: 256,
      lexiconLengths: [],
      facets: data.manifest.facetNames,
      topics: data.manifest.topics,
      ...(mono ? { monochrome: mono } : {}),
      ...(readSiteEntries ? { site: 'site' } : {}),
      transport: {
        protocol: 'snapshot-search-v1',
        endpoint: '/catalog-search.json',
        snapshot: ctx.snapshotSha256,
        directory: 'source-bound-site-v1',
      },
    };
    if (!ctx.fixture) {
      manifestCache.set(key, freeze(value));
      while (manifestCache.size > 2) manifestCache.delete(manifestCache.keys().next().value);
    }
    return value;
  }
  async function itemsFor(data, ids) {
    return mapFour(ids, async (id) => {
      const identity = await mapGet(data.store, data.manifest.ids, 'identities', id);
      if (!identity?.active) return null;
      const descriptor = await mapGet(
        data.store,
        data.manifest.cards,
        'search-cards',
        String(Math.floor(identity.n / 8)),
      );
      if (!descriptor) fail(503, 'Artwork block absent');
      const block = await data.store.get(descriptor),
        item = block.cards?.[identity.n % 8];
      if (block.type !== 'search-cards' || item?.id !== id) fail(503, 'Artwork identity differs');
      return item;
    });
  }
  return {
    async siteDirectory(request, expectedRoot) {
      try {
        const ctx = await context(request);
        if (ctx.snapshotSha256 !== expectedRoot) fail(409, 'Catalog changed');
        return await publicSiteDirectory({
          request,
          root: ctx.snapshotSha256,
          cache: directoryCache,
          defer,
          validate: validateSite,
          read: async () => bound(readSiteEntries, ctx, await dataset(ctx)),
        });
      } catch (error) {
        return reply(
          { error: error.status === 409 ? 'catalog_changed' : 'catalog_unavailable' },
          error.status ?? 503,
        );
      }
    },
    async studioManifest(request) {
      try {
        const ctx = await context(request);
        return reply({
          schema: 1,
          transport: {
            protocol: 'snapshot-search-v1',
            endpoint: '/catalog-search.json',
            snapshot: ctx.snapshotSha256,
          },
        });
      } catch (error) {
        return reply({ error: 'catalog_unavailable' }, error.status ?? 503);
      }
    },
    async studioCatalog(request) {
      try {
        const ctx = await context(request),
          data = await dataset(ctx),
          info = await bound(readStudioInfo, ctx, data);
        if (
          !info ||
          !Array.isArray(info.items) ||
          info.items.length > 500 ||
          info.total !== data.manifest.total ||
          info.transport?.snapshot !== ctx.snapshotSha256
        )
          fail(503, 'Studio directory differs');
        return reply(info);
      } catch (error) {
        return reply(
          { error: error.status === 501 ? 'operation_unavailable' : 'catalog_unavailable' },
          error.status ?? 503,
        );
      }
    },
    async manifest(request) {
      try {
        const ctx = await context(request),
          data = await dataset(ctx);
        return reply(await manifestFor(ctx, data));
      } catch (error) {
        return reply(
          { error: error.status === 501 ? 'operation_unavailable' : 'catalog_unavailable' },
          error.status ?? 503,
        );
      }
    },
    async post(request) {
      const started = performance.now();
      try {
        if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
        const origin = request.headers.get('origin');
        if (origin && origin !== new URL(request.url).origin) fail(403, 'Foreign origin rejected');
        const body = await bodyOf(request);
        if (body?.schema !== 1 || !SHA.test(body.snapshot ?? ''))
          fail(400, 'Invalid snapshot request');
        const ctx = await context(request);
        if (ctx.snapshotSha256 !== body.snapshot) fail(409, 'Catalog changed');
        const data = await dataset(ctx);
        let result;
        if (body.operation === 'items') result = await itemsFor(data, validateIds(body.ids));
        else if (body.operation === 'site')
          result = validateSite(await bound(readSiteEntries, ctx, data));
        else if (
          body.operation === 'search' ||
          body.operation === 'suggest' ||
          body.operation === 'studio'
        ) {
          const state = stateFrom(body.state),
            scope = body.scope ?? [];
          if (
            !Array.isArray(scope) ||
            scope.length > 8 ||
            scope.some(
              (v) => typeof v !== 'string' || v.length > 220 || !/^([a-z-]+)\/[a-z0-9-]+$/.test(v),
            )
          )
            fail(400, 'Invalid search scope');
          if (body.operation === 'studio' && !readStudioItems)
            fail(501, 'Studio search not configured');
          if (body.operation === 'suggest' && (state.size > 8 || state.page !== 1))
            fail(400, 'Invalid suggestion window'); // A named subject in autocomplete should show that subject's own artwork,
          // rather than a different collection with an incidental mention in its scene.
          // Detailed queries and the full search page keep the complete corpus.
          let artworkScope = scope;
          if (body.operation === 'suggest' && !scope.length && state.sort === 'relevance') {
            const tokens = queryTerms(state.q).tokens;
            const subjects = data.manifest.topics.filter((topic) => {
              const words = queryTerms(topic.keyword).tokens;
              return (
                words.length > 0 &&
                words.length === tokens.length &&
                words.every((word) => tokens.includes(word))
              );
            });
            if (
              subjects.length === 1 &&
              data.manifest.facetNames.includes('topic/' + subjects[0].slug)
            )
              artworkScope = ['topic/' + subjects[0].slug];
          }
          let found = await data.engine.search(state, artworkScope);
          if (artworkScope !== scope && found.total === 0)
            found = await data.engine.search(state, scope);
          if (body.operation === 'suggest' && readSuggestionThumbnails && found.items.length) {
            const previews = await bound(readSuggestionThumbnails, ctx, {
              ...data,
              ids: found.items.map((item) => item.id),
            });
            if (!Array.isArray(previews) || previews.length !== found.items.length)
              fail(503, 'Suggestion sources differ');
            found = {
              ...found,
              items: found.items.map((item, i) => {
                const preview = previews[i];
                if (preview?.id !== item.id) fail(503, 'Suggestion source identity differs');
                if (preview.webp === null && preview.thumb === null) return item;
                if (preview.webp !== item.webp) fail(503, 'Suggestion original source differs');
                let url;
                try {
                  url = new URL(preview.thumb);
                } catch {
                  return item;
                }
                if (
                  url.protocol !== 'https:' ||
                  !['assets.ultraclipart.com', 'assets.jotclipart.com'].includes(url.hostname) ||
                  url.username ||
                  url.password ||
                  url.port ||
                  url.search ||
                  url.hash ||
                  url.href === item.webp
                )
                  return item;
                return { ...item, suggestionThumb: url.href };
              }),
            };
          }
          const manifest =
            body.operation === 'suggest'
              ? {
                  schema: 1,
                  version: ctx.snapshotSha256,
                  ranking: 2,
                  total: data.manifest.total,
                  pageChunk: 256,
                  tokenBuckets: 256,
                  lexiconLengths: [],
                  facets: [],
                  topics: [],
                  transport: {
                    protocol: 'snapshot-search-v1',
                    endpoint: '/catalog-search.json',
                    snapshot: ctx.snapshotSha256,
                    directory: 'source-bound-site-v1',
                  },
                }
              : await manifestFor(ctx, data);
          result = { ...found, manifest };
          if (body.operation === 'studio') {
            const assets = await bound(readStudioItems, ctx, {
              ...data,
              ids: found.items.map((i) => i.id),
            });
            if (
              !Array.isArray(assets) ||
              assets.length !== found.items.length ||
              assets.some((a, i) => a?.id !== found.items[i].id)
            )
              fail(503, 'Studio sources differ');
            result.studioItems = assets;
          }
        } else if (body.operation === 'studio-items') {
          const ids = validateIds(body.ids);
          result = await bound(readStudioItems, ctx, { ...data, ids });
          if (
            !Array.isArray(result) ||
            result.length !== ids.length ||
            result.some((a, i) => a !== null && a?.id !== ids[i])
          )
            fail(503, 'Studio sources differ');
        } else fail(400, 'Unknown catalog operation');
        if (readPublicRoutes && ['search', 'suggest', 'items'].includes(body.operation)) {
          const items = Array.isArray(result) ? result : result.items,
            present = items?.filter(Boolean);
          if (present?.length) {
            const routes = await bound(readPublicRoutes, ctx, {
              ...data,
              ids: present.map((i) => i.id),
            });
            if (!Array.isArray(routes) || routes.length !== present.length)
              fail(503, 'Public route source differs');
            let index = 0;
            const projected = items.map((item) => {
              if (item === null) return null;
              const r = routes[index++];
              if (r?.id !== item.id || !ID.test(r.slug ?? ''))
                fail(503, 'Invalid public artwork route');
              return { ...item, publicSlug: r.slug };
            });
            result = Array.isArray(result) ? projected : { ...result, items: projected };
          }
        }
        const response = reply({ schema: 1, snapshot: ctx.snapshotSha256, result });
        response.headers.set(
          'Server-Timing',
          'catalog_search;dur=' +
            (performance.now() - started).toFixed(1) +
            ', search_reads;desc="' +
            data.engine.metrics().totalKernelR2Reads +
            '"',
        );
        return response;
      } catch (error) {
        return reply(
          {
            error:
              error.status === 409
                ? 'catalog_changed'
                : error.status === 501
                  ? 'operation_unavailable'
                  : 'catalog_unavailable',
          },
          error.status ?? 503,
        );
      }
    },
  };
}
