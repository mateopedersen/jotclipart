// PRIVATE bounded streaming search experiment. Not a production endpoint.
import {
  queryTerms,
  termVariants,
  oneEditAway,
  relevanceScore,
  normalizeQuery,
  SEARCH_LANGUAGE_VERSION,
  EXACT_SUBJECT_BONUS,
  exactSubjectFacets,
} from '../../src/lib/search-language.ts';
import {
  makeStore,
  mapGet,
  mapEntries,
  wordsFrom,
  orderedValues,
  SEARCH_MANIFEST_MAX_BYTES,
  SEARCH_OBJECT_MAX_BYTES,
} from './store.mjs';
import { mapFour } from './bounded-map.mjs';
const hex = async (bytes) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
export class SearchBudgetError extends Error {
  status = 503;
}
const sharedBytes = new Map();
let sharedBytesUsed = 0;
const SHARED_BYTES_LIMIT = 2 * 1024 * 1024,
  SHARED_ENTRY_LIMIT = 512;
export const searchCacheMetrics = () => ({
  entries: sharedBytes.size,
  rawBytes: sharedBytesUsed,
  rawByteLimit: SHARED_BYTES_LIMIT,
  entryLimit: SHARED_ENTRY_LIMIT,
});
function sharedPut(key, body) {
  const copy = new Uint8Array(body).slice();
  if (copy.byteLength > SHARED_BYTES_LIMIT) return;
  if (sharedBytes.has(key)) {
    sharedBytesUsed -= sharedBytes.get(key).byteLength;
    sharedBytes.delete(key);
  }
  sharedBytes.set(key, copy);
  sharedBytesUsed += copy.byteLength;
  while (sharedBytesUsed > SHARED_BYTES_LIMIT || sharedBytes.size > SHARED_ENTRY_LIMIT) {
    const oldest = sharedBytes.keys().next().value;
    sharedBytesUsed -= sharedBytes.get(oldest).byteLength;
    sharedBytes.delete(oldest);
  }
}
export async function openSearch(
  bucket,
  descriptor,
  {
    maxReads = 8000,
    maxBytes = 256 * 1024 * 1024,
    maxCandidates = 100000,
    sharedCache = false,
    allowPrivateFixture = false,
  } = {},
) {
  let totalKernelR2Reads = 0,
    totalKernelR2Bytes = 0,
    pendingR2 = 0,
    peakPendingR2 = 0,
    availableR2 = 4;
  const requestQueue = [],
    originalBucket = bucket;
  bucket = {
    get: async (key) => {
      if (++totalKernelR2Reads > maxReads)
        throw new SearchBudgetError('Combined search read budget exceeded');
      if (availableR2 > 0) availableR2--;
      else await new Promise((resolve) => requestQueue.push(resolve));
      pendingR2++;
      peakPendingR2 = Math.max(peakPendingR2, pendingR2);
      try {
        const object = await originalBucket.get(key);
        if (!object) return null;
        const limit = key === descriptor?.key ? SEARCH_MANIFEST_MAX_BYTES : SEARCH_OBJECT_MAX_BYTES;
        if (object.size > limit || (totalKernelR2Bytes += object.size) > maxBytes) {
          await object.body?.cancel?.();
          throw new SearchBudgetError('Combined search byte budget exceeded');
        }
        const body = await object.arrayBuffer();
        if (body.byteLength !== object.size) throw new SearchBudgetError('Truncated search object');
        return { size: object.size, arrayBuffer: async () => body };
      } finally {
        pendingR2--;
        const next = requestQueue.shift();
        if (next) next();
        else availableR2++;
      }
    },
  };
  let reads = 0,
    bytesRead = 0,
    maxObject = 0,
    peakCandidates = 0,
    forwardBlocks = 0,
    peakScoredRows = 0,
    objectsAccessed = 0,
    bytesDecoded = 0,
    memoryCacheHits = 0;
  const cache = new Map();
  let slots = 4;
  const waiting = [],
    pending = new Map();
  const acquire = async () => {
    if (slots > 0) slots--;
    else await new Promise((r) => waiting.push(r));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else slots++;
  };
  async function read(d, cacheable = false) {
    if (
      !d ||
      !/^[a-f0-9]{64}$/.test(d.sha256 ?? '') ||
      d.key !== `catalog/objects/search/${d.sha256}.json` ||
      !Number.isInteger(d.bytes) ||
      d.bytes < 1 ||
      d.bytes > (d.key === descriptor?.key ? SEARCH_MANIFEST_MAX_BYTES : SEARCH_OBJECT_MAX_BYTES)
    )
      throw new SearchBudgetError('Invalid search object');
    const cached = cache.get(d.key);
    if (cached) {
      if (cached.bytes !== d.bytes) throw new SearchBudgetError('Conflicting object length');
      return cached.value;
    }
    let operation = pending.get(d.key);
    if (operation && operation.bytes !== d.bytes)
      throw new SearchBudgetError('Conflicting pending object length');
    if (!operation) {
      if (++objectsAccessed > maxReads || (bytesDecoded += d.bytes) > maxBytes)
        throw new SearchBudgetError('Search query budget exceeded');
      const promise = (async () => {
        await acquire();
        try {
          let b = sharedCache ? sharedBytes.get(d.key) : undefined;
          if (b) {
            if (b.byteLength !== d.bytes)
              throw new SearchBudgetError('Conflicting shared object length');
            memoryCacheHits++;
            sharedBytes.delete(d.key);
            sharedBytes.set(d.key, b);
          } else {
            reads++;
            bytesRead += d.bytes;
            const o = await bucket.get(d.key);
            if (!o || o.size !== d.bytes) throw new SearchBudgetError('Missing search object');
            b = await o.arrayBuffer();
          }
          if (b.byteLength !== d.bytes || (await hex(b)) !== d.sha256)
            throw new SearchBudgetError('Corrupt search object');
          if (sharedCache) sharedPut(d.key, b);
          maxObject = Math.max(maxObject, b.byteLength);
          const value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(b));
          if (value.schema !== 1) throw new SearchBudgetError('Invalid search schema');
          return value;
        } finally {
          release();
        }
      })();
      operation = { bytes: d.bytes, promise };
      pending.set(d.key, operation);
    }
    try {
      const value = await operation.promise;
      if (cacheable) {
        cache.set(d.key, { bytes: d.bytes, value });
        if (cache.size > 24) cache.delete(cache.keys().next().value);
      }
      return value;
    } finally {
      if (pending.get(d.key) === operation) pending.delete(d.key);
    }
  }

  const structureStore = makeStore(bucket, { cacheLimit: 64, maxReads: 8000, maxBytes });
  const pendingStructures = new Map();
  const structures = {
    async get(descriptor) {
      const key = descriptor?.key;
      const pending = pendingStructures.get(key);
      if (pending) {
        if (pending.sha256 !== descriptor?.sha256 || pending.bytes !== descriptor?.bytes)
          throw new SearchBudgetError('Conflicting ordered structure');
        return pending.result;
      }
      const result = structureStore.get(descriptor);
      pendingStructures.set(key, { sha256: descriptor?.sha256, bytes: descriptor?.bytes, result });
      try {
        return await result;
      } finally {
        pendingStructures.delete(key);
      }
    },
  };
  const manifest = await read(descriptor, true);
  const privateIndex =
      manifest.type === 'private-incremental-public-search-v1' &&
      manifest.status === 'PRIVATE_UNPUBLISHABLE',
    approvedIndex =
      manifest.type === 'catalog-search-v1' &&
      manifest.status === 'SOURCE_VERIFIED' &&
      /^[a-f0-9]{64}$/.test(manifest.sourceReceiptSHA256 ?? '');
  if (
    (!approvedIndex && !(allowPrivateFixture && privateIndex)) ||
    manifest.languageVersion !== SEARCH_LANGUAGE_VERSION ||
    manifest.forwardChunk !== 64 ||
    manifest.cardChunk !== 8 ||
    !Number.isSafeInteger(manifest.nextDoc) ||
    manifest.nextDoc < manifest.total
  )
    throw new SearchBudgetError('Invalid incremental manifest');
  async function lookup(root, kind, key) {
    return mapGet(structures, root, kind, key);
  }
  async function numericLookup(root, kind, index) {
    return mapGet(
      structures,
      root,
      kind === 'cards' ? 'search-cards' : kind === 'forward' ? 'search-forward' : kind,
      String(index),
    );
  }
  async function rangePages(root, kind) {
    const rows = [];
    for await (const e of mapEntries(structures, root, kind)) rows.push(e.value);
    return rows;
  }

  const metadata = new Map();
  const term = (word) => {
    if (!metadata.has(word)) {
      metadata.set(
        word,
        (async () => {
          const value = await lookup(manifest.terms, 'terms', word);
          if (value?.count)
            return { ...value, pages: await rangePages(value.ranges, 'term-ranges') };
        })(),
      );
    }
    return metadata.get(word);
  };
  async function idsFor(words, rangeLimit, minWeight = 0) {
    const ids = new Set();
    for (const word of [...new Set(words)]) {
      const t = await term(word);
      if (!t) continue;
      await mapFour(
        t.pages.filter((d) => !rangeLimit || rangeLimit.has(d.range)),
        async (d) => {
          const p = await read(d);
          const rows = p.postings?.[word];
          if (
            p.type !== 'search-posting-shard' ||
            p.range !== d.range ||
            !Array.isArray(rows) ||
            rows.length !== d.count ||
            rows.some(
              (code) =>
                !Number.isSafeInteger(code) ||
                code < 0 ||
                (code % 16) >> 1 < 1 ||
                Math.floor(code / 16) >= manifest.nextDoc ||
                Math.floor(Math.floor(code / 16) / 512) !== d.range,
            )
          )
            throw new SearchBudgetError('Invalid posting range');
          rows.forEach((code) => {
            if ((code % 16) >> 1 < minWeight) return;
            const n = Math.floor(code / 16);
            ids.add(n);
            if (ids.size > maxCandidates)
              throw new SearchBudgetError('Search candidate budget exceeded');
          });
        },
      );
    }
    return ids;
  }
  async function prefixesFor(tokens, variants) {
    const last = tokens.at(-1);
    if (!last || last.length < 3) return variants;
    const words = await wordsFrom(
      structures,
      await lookup(manifest.prefixes, 'prefixes', last),
      32,
    );
    const additions = words
      .filter((word) => word.startsWith(last) && !variants.at(-1).includes(word))
      .sort((a, b) => a.length - b.length || a.localeCompare(b))
      .slice(0, 16);
    return variants.map((words, index) =>
      index === variants.length - 1 ? [...words, ...additions] : words,
    );
  }
  async function expandedFor(tokens, variants) {
    return Promise.all(
      tokens.map(async (token, i) => {
        const candidates = new Set();
        if (token.length >= 4) {
          const signatures = new Set([
            token,
            ...Array.from(
              { length: token.length },
              (_, n) => token.slice(0, n) + token.slice(n + 1),
            ),
          ]);
          await mapFour([...signatures], async (sig) => {
            for (const word of await wordsFrom(
              structures,
              await lookup(manifest.edits, 'edits', sig),
            ))
              candidates.add(word);
          });
          const swaps = [
            ...new Set(
              Array.from(
                { length: token.length - 1 },
                (_, n) => token.slice(0, n) + token[n + 1] + token[n] + token.slice(n + 2),
              ),
            ),
          ];
          await mapFour(swaps, async (swap) => {
            if (await term(swap)) candidates.add(swap);
          });
        }
        if (i === tokens.length - 1 && token.length >= 3)
          for (const word of await wordsFrom(
            structures,
            await lookup(manifest.prefixes, 'prefixes', token),
            32,
          ))
            candidates.add(word);
        const chosen = [...candidates]
          .filter(
            (w) =>
              !variants[i].includes(w) &&
              (oneEditAway(token, w) ||
                (i === tokens.length - 1 && token.length >= 3 && w.startsWith(token))),
          )
          .sort(
            (a, b) =>
              Math.abs(a.length - token.length) - Math.abs(b.length - token.length) ||
              a.localeCompare(b),
          )
          .slice(0, 16);
        return [...variants[i], ...chosen];
      }),
    );
  }
  const comparator = (sort) => (a, b) =>
    sort === 'newest'
      ? b.time - a.time || b.n - a.n
      : sort === 'title'
        ? a.title.localeCompare(b.title, 'en') || a.n - b.n
        : b.score - a.score || a.title.localeCompare(b.title, 'en') || a.n - b.n;
  function topWindow(limit, compare) {
    const heap = [];
    let total = 0;
    const swap = (a, b) => {
      const v = heap[a];
      heap[a] = heap[b];
      heap[b] = v;
    };
    return {
      offer(row) {
        total++;
        if (heap.length < limit) {
          heap.push(row);
          let i = heap.length - 1;
          while (i > 0) {
            const p = Math.floor((i - 1) / 2);
            if (compare(heap[i], heap[p]) <= 0) break;
            swap(i, p);
            i = p;
          }
        } else if (compare(row, heap[0]) < 0) {
          heap[0] = row;
          let i = 0;
          for (;;) {
            const left = i * 2 + 1;
            if (left >= heap.length) break;
            const right = left + 1,
              child = right < heap.length && compare(heap[right], heap[left]) > 0 ? right : left;
            if (compare(heap[child], heap[i]) <= 0) break;
            swap(i, child);
            i = child;
          }
        }
      },
      finish() {
        const rows = heap.sort(compare);
        Object.defineProperty(rows, 'totalMatches', { value: total });
        return rows;
      },
    };
  }
  async function cardsFor(rows) {
    const indexes = [...new Set(rows.map((row) => Math.floor(row.n / manifest.cardChunk)))];
    const pages = new Map(
      await mapFour(indexes, async (index) => {
        const d = await numericLookup(manifest.cards, 'cards', index),
          page = await read(d, true);
        if (
          page.type !== 'search-cards' ||
          page.start !== index * manifest.cardChunk ||
          page.cards.length !== Math.min(manifest.cardChunk, manifest.nextDoc - page.start)
        )
          throw new SearchBudgetError('Invalid card block');
        return [index, page];
      }),
    );
    return rows.map((row) => {
      const card = pages.get(Math.floor(row.n / manifest.cardChunk)).cards[
        row.n % manifest.cardChunk
      ];
      if (!card || !/^([a-z0-9]+-)*[a-z0-9]+$/.test(card.id) || (row.id && card.id !== row.id))
        throw new SearchBudgetError('Card identity differs');
      return card;
    });
  }
  async function forwardPage(index) {
    forwardBlocks++;
    const d = await numericLookup(manifest.forward, 'forward', index),
      page = await read(d);
    if (
      page.type !== 'search-forward' ||
      page.start !== index * manifest.forwardChunk ||
      page.documents.length !== Math.min(manifest.forwardChunk, manifest.nextDoc - page.start) ||
      page.documents.some((d, i) => d && d.n !== page.start + i)
    )
      throw new SearchBudgetError('Invalid forward block');
    return page;
  }

  const ranges = (ids) => new Set([...ids].map((n) => Math.floor(n / 512)));
  const intersect = (a, b) => new Set([...a].filter((n) => b.has(n)));
  async function* scanOrder(kind) {
    const root = manifest.ranked[kind];
    const width = 128;
    for (let first = 0; first < root.count; first += width * 4) {
      const offsets = [0, 1, 2, 3].map((index) => first + index * width);
      const blocks = await mapFour(offsets, async (offset) => {
        const entries = [];
        for await (const entry of orderedValues(structures, root, kind, { offset, limit: width }))
          entries.push(entry);
        return entries;
      });
      for (const block of blocks) yield* block;
    }
  }
  async function readFacet(name, descriptor) {
    const page = await read(descriptor, true);
    if (
      page.type !== 'search-facet-ids' ||
      page.facet !== name ||
      page.range !== descriptor.range ||
      !Array.isArray(page.ids) ||
      page.ids.length !== descriptor.count ||
      page.ids.some(
        (n, i) =>
          !Number.isSafeInteger(n) ||
          n < 0 ||
          n >= manifest.nextDoc ||
          Math.floor(n / 512) !== page.range ||
          (i > 0 && n <= page.ids[i - 1]),
      )
    )
      throw new SearchBudgetError('Invalid facet');
    return page.ids;
  }
  async function firstFacetPage(kind, facet, size) {
    const descriptors = new Map(facet.pages.map((page) => [page.range, page]));
    const loaded = new Map();
    const rows = [];
    let batch = [];
    for await (const entry of orderedValues(structures, manifest.ranked[kind], kind, {
      limit: 192,
    })) {
      batch.push(entry);
      if (batch.length < 24) continue;
      const needed = [...ranges(batch.map(({ n }) => n))].filter(
        (range) => descriptors.has(range) && !loaded.has(range),
      );
      // Sparse facets keep using the full membership pass. Limit the extra
      // work before falling back to that exact path.
      if (loaded.size + needed.length > 24) return;
      await mapFour(needed, async (range) => {
        loaded.set(range, new Set(await readFacet(facet.name, descriptors.get(range))));
      });
      for (const row of batch) {
        if (loaded.get(Math.floor(row.n / 512))?.has(row.n)) rows.push(row);
        if (rows.length === size) return rows;
      }
      batch = [];
    }
  }

  async function search(state, scope = []) {
    const intent = queryTerms(state.q);
    const { tokens, excluded } = intent,
      variants = tokens.map(termVariants),
      excludedIds = new Set();
    for (const w of excluded.flatMap(termVariants)) {
      const t = await term(w);
      if (t) excludedIds.add(t.id);
    }
    const standard = {
      schema: 1,
      version: descriptor.sha256.slice(0, 16),
      ranking: 2,
      total: manifest.total,
      pageChunk: 256,
      tokenBuckets: 256,
      lexiconLengths: [],
      facets: manifest.facetNames,
      topics: manifest.topics,
    };
    const pageInfo = (total) => {
      const pages = Math.max(1, Math.ceil(total / state.size));
      return { total, pages, page: Math.min(pages, Math.max(1, state.page)) };
    };
    const facetNames = [...scope];
    for (const k of ['style', 'color', 'format', 'orientation', 'background'])
      if (state[k])
        facetNames.push(
          k === 'style' && state.style === 'black & white'
            ? 'print/monochrome'
            : k === 'style' && state.style === 'outline'
              ? 'print/outline'
              : k + '/' + state[k],
        );
    if (intent.wantsMonochrome) facetNames.push('print/monochrome');
    if (intent.wantsOutline) facetNames.push('print/outline');
    if (intent.wantsTransparent) facetNames.push('background/transparent');
    const empty = () => ({ ...pageInfo(0), items: [], hasFuzzyMatches: false, manifest: standard });
    const facets = await mapFour([...new Set(facetNames)], async (name) => {
      const facet = await lookup(manifest.facets, 'facets', name);
      if (!facet?.count) return null;
      if (!Number.isSafeInteger(facet.count) || facet.count < 0 || facet.count > manifest.total)
        throw new SearchBudgetError('Invalid facet total');
      const pages = await rangePages(facet.ranges, 'facet-ranges');
      if (
        pages.some(
          ({ range, count }) =>
            !Number.isSafeInteger(range) ||
            range < 0 ||
            range * 512 >= manifest.nextDoc ||
            !Number.isSafeInteger(count) ||
            count < 1 ||
            count > 512,
        ) ||
        new Set(pages.map(({ range }) => range)).size !== pages.length ||
        pages.reduce((total, page) => total + page.count, 0) !== facet.count
      )
        throw new SearchBudgetError('Invalid facet ranges');
      return { name, count: facet.count, pages };
    });
    if (facets.includes(null)) return empty();
    const kind = state.sort === 'newest' ? 'newest' : 'title';
    if (
      !tokens.length &&
      !excluded.length &&
      state.page === 1 &&
      facets.length === 1 &&
      facets[0].count <= maxCandidates
    ) {
      const [facet] = facets;
      const selected = await firstFacetPage(kind, facet, Math.min(facet.count, state.size));
      if (selected)
        return {
          ...pageInfo(facet.count),
          items: await cardsFor(selected),
          hasFuzzyMatches: false,
          manifest: standard,
        };
    }
    facets.sort((a, b) => a.count - b.count);
    async function facetMembers(firstRanges) {
      let allowed = null;
      for (const { name, pages } of facets) {
        const allowedRanges = allowed ? ranges(allowed) : firstRanges;
        const ids = new Set();
        await mapFour(
          pages.filter((page) => !allowedRanges || allowedRanges.has(page.range)),
          async (descriptor) => {
            for (const n of await readFacet(name, descriptor)) {
              ids.add(n);
              if (ids.size > maxCandidates)
                throw new SearchBudgetError('Search facet budget exceeded');
            }
          },
        );
        allowed = allowed ? intersect(allowed, ids) : ids;
        if (!allowed.size) break;
      }
      return allowed;
    }
    const exactRanges =
      facets.length && tokens.length === 1
        ? new Set(
            (await mapFour(variants[0], term)).flatMap((entry) =>
              entry ? entry.pages.map((page) => page.range) : [],
            ),
          )
        : null;
    let allowed = await facetMembers(exactRanges);
    if (allowed?.size === 0 && !exactRanges) return empty();
    if (!tokens.length) {
      const denied = excluded.length ? await idsFor(excluded.flatMap(termVariants)) : new Set();
      const count = allowed
          ? [...allowed].filter((n) => !denied.has(n)).length
          : manifest.total - denied.size,
        meta = pageInfo(count),
        start = (meta.page - 1) * state.size,
        selected = [];
      let eligible = 0;
      const ordered =
        allowed || denied.size
          ? scanOrder(kind)
          : orderedValues(structures, manifest.ranked[kind], kind, { offset: start });
      for await (const entry of ordered) {
        const n = entry.n;
        if ((allowed && !allowed.has(n)) || denied.has(n)) continue;
        if ((!allowed && !denied.size) || eligible++ >= start) selected.push({ n });
        if (selected.length === state.size) break;
      }
      return {
        ...meta,
        items: await cardsFor(selected),
        hasFuzzyMatches: false,
        manifest: standard,
      };
    }
    const preferred = new Set();
    let preferScope = false;
    if (state.sort === 'relevance') {
      await mapFour(
        exactSubjectFacets(tokens, manifest.topics, manifest.facetNames),
        async (name) => {
          if (scope.includes(name)) {
            preferScope = true;
            return;
          }
          const facet = await lookup(manifest.facets, 'facets', name);
          if (!facet?.count) return;
          await mapFour(await rangePages(facet.ranges, 'facet-ranges'), async (d) => {
            for (const n of await readFacet(name, d)) {
              preferred.add(n);
              if (preferred.size > maxCandidates)
                throw new SearchBudgetError('Subject candidate budget exceeded');
            }
          });
        },
      );
    }
    const rankedMetadata = new Map();
    async function loadRankedMetadata(eligible) {
      const missing = new Set([...eligible].filter((n) => !rankedMetadata.has(n))),
        indexes = [...new Set([...missing].map((n) => Math.floor(n / manifest.forwardChunk)))];
      await mapFour(indexes, async (index) => {
        const page = await forwardPage(index);
        for (const doc of page.documents)
          if (doc && missing.has(doc.n)) {
            if (typeof doc.title !== 'string' || !Number.isFinite(doc.time))
              throw new SearchBudgetError('Invalid ranked document');
            rankedMetadata.set(doc.n, { n: doc.n, title: doc.title, time: doc.time });
          }
      });
      if ([...missing].some((n) => !rankedMetadata.has(n)))
        throw new SearchBudgetError('Ranked candidate missing');
    }
    async function rankedWindow(kind, eligible, start, size) {
      // A narrow query must not walk the global alphabet merely to sort its few
      // matches. Read only the already-selected candidates' verified forward blocks.
      // Broad queries retain the bounded streaming ordered index.
      if (eligible.size <= 512) {
        await loadRankedMetadata(eligible);
        return [...eligible]
          .map((n) => rankedMetadata.get(n))
          .sort(comparator(kind))
          .slice(start, start + size)
          .map(({ n }) => ({ n }));
      }
      let count = 0;
      const chosen = [];
      for await (const entry of scanOrder(kind)) {
        const n = entry.n;
        if (eligible.has(n)) {
          if (count++ >= start) chosen.push({ n });
          if (chosen.length === size) return chosen;
        }
      }
      return chosen;
    }
    if (tokens.length === 1) {
      const denied = excluded.length ? await idsFor(excluded.flatMap(termVariants)) : new Set(),
        scores = new Map();
      for (const word of variants[0]) {
        const meta = await term(word);
        if (!meta) continue;
        await mapFour(meta.pages, async (d) => {
          const page = await read(d),
            codes = page.postings?.[word];
          if (
            page.type !== 'search-posting-shard' ||
            page.range !== d.range ||
            !Array.isArray(codes) ||
            codes.length !== d.count
          )
            throw new SearchBudgetError('Invalid packed posting');
          for (const code of codes) {
            const n = Math.floor(code / 16),
              weight = (code % 16) >> 1,
              title = code % 2 === 1;
            if (
              !Number.isSafeInteger(code) ||
              n < 0 ||
              n >= manifest.nextDoc ||
              Math.floor(n / 512) !== d.range ||
              weight < 1 ||
              weight > 7
            )
              throw new SearchBudgetError('Invalid packed score');
            if ((allowed && !allowed.has(n)) || denied.has(n)) continue;
            const previous = scores.get(n);
            scores.set(n, {
              weight: Math.max(previous?.weight ?? -1, weight - (word === tokens[0] ? 0 : 0.5)),
              title: title || previous?.title === true,
            });
            if (scores.size > maxCandidates)
              throw new SearchBudgetError('Single-term candidate budget exceeded');
          }
        });
      }
      if (scores.size) {
        peakCandidates = Math.max(peakCandidates, scores.size);
        const meta = pageInfo(scores.size);
        let start = (meta.page - 1) * state.size,
          selected = [];
        if (state.sort === 'title' || state.sort === 'newest')
          selected = await rankedWindow(state.sort, new Set(scores.keys()), start, state.size);
        else {
          const groups = new Map();
          for (const [n, value] of scores) {
            const score =
              value.weight +
              (value.title ? 5 : 0) +
              (preferScope || preferred.has(n) ? EXACT_SUBJECT_BONUS : 0);
            if (!groups.has(score)) groups.set(score, new Set());
            groups.get(score).add(n);
          }
          for (const [score, ids] of [...groups].sort(([a], [b]) => b - a)) {
            if (start >= ids.size) {
              start -= ids.size;
              continue;
            }
            const part = await rankedWindow('title', ids, start, state.size - selected.length);
            selected.push(...part);
            start = 0;
            if (selected.length === state.size) break;
          }
        }
        return {
          ...meta,
          items: await cardsFor(selected),
          hasFuzzyMatches: false,
          manifest: standard,
          relatedItems: [],
          relatedMissing: {},
        };
      }
    }
    // Prefix and spelling alternatives can occur outside the exact word's ranges.
    if (exactRanges) {
      allowed = await facetMembers();
      if (allowed?.size === 0) return empty();
    }
    async function candidateIds(groups, related = false) {
      if (!groups.length)
        return allowed ?? new Set(Array.from({ length: manifest.nextDoc }, (_, n) => n));
      const sizes = await Promise.all(
        groups.map(async (g) =>
          (await Promise.all(g.map(term))).reduce((sum, t) => sum + (t?.count ?? 0), 0),
        ),
      );
      const ordered = groups.map((_, i) => i).sort((a, b) => sizes[a] - sizes[b]);
      if (!related) {
        let candidates = null;
        for (const index of ordered) {
          if (!sizes[index]) return new Set();
          const candidateRanges = candidates || allowed ? ranges(candidates ?? allowed) : undefined;
          if (candidates && groups.length > 1) {
            const forwardCount = new Set(
              [...candidates].map((n) => Math.floor(n / manifest.forwardChunk)),
            ).size;
            const postingCount = (await Promise.all(groups[index].map(term))).reduce(
              (sum, entry) =>
                sum + (entry?.pages.filter((page) => candidateRanges.has(page.range)).length ?? 0),
              0,
            );
            // The forward records recheck all words and term weights when scoring.
            if (forwardCount <= postingCount) return candidates;
          }
          const ids = await idsFor(groups[index], candidateRanges, tokens.length > 1 ? 3 : 0);
          candidates = candidates
            ? intersect(candidates, ids)
            : allowed
              ? intersect(ids, allowed)
              : ids;
          if (!candidates.size) return candidates;
        }
        return candidates;
      }
      const queryWords = new Set(tokens),
        presentWords = new Set(
          manifest.topics.flatMap((t) => {
            const words = normalizeQuery(t.keyword);
            return words.length && words.every((w) => queryWords.has(w)) ? words : [];
          }),
        ),
        anchors = ordered.filter((i) => presentWords.has(tokens[i]));
      let universe = allowed;
      const anchorSets = new Map();
      for (const index of anchors) {
        const ids = await idsFor(
          groups[index],
          universe ? ranges(universe) : undefined,
          tokens.length > 1 ? 3 : 0,
        );
        anchorSets.set(index, ids);
        universe = universe ? intersect(universe, ids) : ids;
        if (!universe.size) return universe;
      }
      const counts = new Map();
      for (const index of ordered) {
        const ids =
          anchorSets.get(index) ??
          (await idsFor(
            groups[index],
            universe ? ranges(universe) : undefined,
            tokens.length > 1 ? 3 : 0,
          ));
        for (const n of ids) {
          if (universe && !universe.has(n)) continue;
          counts.set(n, (counts.get(n) ?? 0) + 1);
          if (counts.size > maxCandidates)
            throw new SearchBudgetError('Related candidate budget exceeded');
        }
      }
      return new Set(
        [...counts]
          .filter(([n, count]) => count >= Math.max(2, Math.ceil(tokens.length * 0.65)))
          .map(([n]) => n),
      );
    }

    async function evaluate(groups, { fuzzy = false, related = false } = {}) {
      const ids = await candidateIds(groups, related),
        blocks = new Map();
      peakCandidates = Math.max(peakCandidates, ids.size);
      for (const n of ids) {
        if (allowed && !allowed.has(n)) continue;
        const p = Math.floor(n / manifest.forwardChunk);
        if (!blocks.has(p)) blocks.set(p, new Set());
        blocks.get(p).add(n);
      }
      const termGroups = await Promise.all(
          groups.map((g) => Promise.all(g.map(async (w) => ({ word: w, term: await term(w) })))),
        ),
        window = topWindow(
          related ? 8 : Math.min(maxCandidates, state.page * state.size),
          comparator(related ? 'relevance' : state.sort),
        );
      const queryWords = new Set(tokens),
        presentWords = new Set(
          manifest.topics.flatMap((t) => {
            const w = normalizeQuery(t.keyword);
            return w.length && w.every((x) => queryWords.has(x)) ? w : [];
          }),
        ),
        anchors = tokens.flatMap((t, i) => (presentWords.has(t) ? [i] : []));
      await mapFour(
        [...blocks].sort(([a], [b]) => a - b),
        async ([index, wanted]) => {
          const page = await forwardPage(index);
          for (const doc of page.documents) {
            if (!doc || !wanted.has(doc.n)) continue;
            if (
              doc.n < index * manifest.forwardChunk ||
              doc.n >= index * manifest.forwardChunk + manifest.forwardChunk
            )
              throw new SearchBudgetError('Invalid document location');
            const weights = new Map();
            for (let i = 0; i < doc.weights.length; i += 2)
              weights.set(doc.weights[i], doc.weights[i + 1]);
            if ([...excludedIds].some((n) => weights.has(n))) continue;
            const matches = termGroups.map((g, index) => {
              let matching = g.filter(
                (x) =>
                  x.term &&
                  weights.has(x.term.id) &&
                  (tokens.length === 1 || weights.get(x.term.id) >= 3),
              );
              if (fuzzy) {
                const exact = matching.filter((x) => variants[index].includes(x.word));
                if (exact.length) matching = exact;
              }
              if (!matching.length) return null;
              return {
                weight: Math.max(
                  ...matching.map(
                    (x) => weights.get(x.term.id) - (x.word === tokens[index] ? 0 : 0.5),
                  ),
                ),
                positions: doc.titleTerms.flatMap((id, i) =>
                  matching.some((x) => x.term.id === id) ? [i] : [],
                ),
                fuzzy: fuzzy && matching.every((x) => !variants[index].includes(x.word)),
              };
            });
            const found = matches.filter(Boolean);
            if (related) {
              if (
                found.length < Math.max(2, Math.ceil(tokens.length * 0.65)) ||
                !anchors.every((i) => matches[i])
              )
                continue;
            } else if (found.length !== tokens.length) continue;
            window.offer({
              n: doc.n,
              title: doc.title,
              time: doc.time,
              score:
                (related ? found.length * 20 : 0) +
                relevanceScore(found) +
                (preferScope || preferred.has(doc.n) ? EXACT_SUBJECT_BONUS : 0),
              fuzzy: found.some((x) => x.fuzzy),
              missing: related ? tokens.filter((_, i) => !matches[i]) : [],
            });
          }
        },
      );
      const results = window.finish();
      peakScoredRows = Math.max(peakScoredRows, results.length);
      return results;
    }
    let results = await evaluate(variants),
      expanded = variants;
    if (!results.length && tokens.length) {
      expanded = await prefixesFor(tokens, variants);
      if (expanded.some((words, index) => words.length > variants[index].length))
        results = await evaluate(expanded);
    }
    if (!results.length && tokens.length) {
      expanded = await expandedFor(tokens, variants);
      results = await evaluate(expanded, { fuzzy: true });
    }
    const related =
      !results.length && tokens.length >= 3
        ? (await evaluate(expanded, { fuzzy: true, related: true })).slice(0, 8)
        : [];
    const meta = pageInfo(results.totalMatches ?? results.length),
      selected = results.slice((meta.page - 1) * state.size, meta.page * state.size),
      items = await cardsFor(selected),
      relatedItems = await cardsFor(related);
    return {
      ...meta,
      items,
      hasFuzzyMatches: selected.some((x) => x.fuzzy),
      manifest: standard,
      relatedItems,
      relatedMissing: Object.fromEntries(related.map((x, i) => [relatedItems[i].id, x.missing])),
    };
  }
  return {
    manifest,
    search,
    metrics: () => ({
      totalKernelR2Reads,
      totalKernelR2Bytes,
      peakPendingR2,
      reads,
      bytesRead,
      maxObjectBytes: maxObject,
      metadataCacheEntries: cache.size,
      objectsAccessed,
      bytesDecoded,
      memoryCacheHits,
      sharedCache: searchCacheMetrics(),
      peakCandidates,
      forwardBlocks,
      peakScoredRows,
      structures: structureStore.metrics(),
    }),
  };
}
