// Immutable metadata primitives. No pointer update or publication authority.
export const canonical = (x) =>
  Array.isArray(x)
    ? x.map(canonical)
    : x && typeof x === 'object'
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, canonical(x[k])]),
        )
      : x;
export const bytesOf = (x) => new TextEncoder().encode(JSON.stringify(canonical(x)));
export const digest = async (b) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        typeof b === 'string' ? new TextEncoder().encode(b) : b,
      ),
    ),
  ]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
export const slugOK = (s) => typeof s === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s);
export class CollectionFault extends Error {
  status = 503;
}
export const fail = (m) => {
  throw new CollectionFault(m);
};
export function facetStore(
  bucket,
  { writable = false, maxReads = 100000, maxBytes = 256 * 1024 * 1024 } = {},
) {
  const cache = new Map(),
    written = new Map();
  let reads = 0,
    readBytes = 0,
    puts = 0,
    reused = 0;
  const descriptor = (facet, d) => {
    if (
      !['collections', 'counts', 'artworks'].includes(facet) ||
      !d ||
      !/^[a-f0-9]{64}$/.test(d.sha256 ?? '') ||
      d.key !== `catalog/objects/${facet}/${d.sha256}.json` ||
      !Number.isSafeInteger(d.bytes) ||
      d.bytes < 1 ||
      d.bytes > 262144
    )
      fail('Invalid facet descriptor');
  };
  const remember = (key, value) => {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > 256) cache.delete(cache.keys().next().value);
  };
  async function read(facet, d) {
    descriptor(facet, d);
    if (cache.has(d.key)) {
      const prior = cache.get(d.key);
      if (prior.bytes !== d.bytes) fail('Conflicting metadata size');
      return prior.value;
    }
    if (++reads > maxReads || (readBytes += d.bytes) > maxBytes)
      fail('Collection read budget exceeded');
    const o = await bucket.get(d.key);
    if (!o || o.size !== d.bytes) fail('Missing collection object');
    const b = await o.arrayBuffer();
    if (b.byteLength !== d.bytes || (await digest(b)) !== d.sha256)
      fail('Corrupt collection object');
    let value;
    try {
      value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(b));
    } catch {
      fail('Invalid metadata JSON');
    }
    if (value.schema !== 1) fail('Invalid metadata schema');
    remember(d.key, { bytes: d.bytes, value });
    return value;
  }
  async function put(facet, value) {
    if (!writable) fail('Read-only collection store');
    const body = bytesOf({ schema: 1, ...value }),
      sha256 = await digest(body),
      d = { key: `catalog/objects/${facet}/${sha256}.json`, sha256, bytes: body.length };
    descriptor(facet, d);
    if (!written.has(d.key)) {
      const old = await bucket.get(d.key);
      if (old) {
        if (old.size !== d.bytes || (await digest(await old.arrayBuffer())) !== sha256)
          fail('Immutable existing object differs');
        reused++;
      } else {
        const result = await bucket.put(d.key, body, {
          onlyIf: { etagDoesNotMatch: '*' },
          httpMetadata: {
            contentType: 'application/json',
            cacheControl: 'public,max-age=31536000,immutable',
          },
        });
        if (!result) fail('Concurrent immutable creation');
        puts++;
      }
      const back = await bucket.get(d.key);
      if (!back || back.size !== d.bytes || (await digest(await back.arrayBuffer())) !== sha256)
        fail('Immutable readback differs');
      written.set(d.key, d);
    }
    remember(d.key, { bytes: d.bytes, value: canonical({ schema: 1, ...value }) });
    return d;
  }
  return { read, put, written, metrics: () => ({ reads, readBytes, puts, reused }) };
}
const facetFor = (kind) => (kind === 'count' ? 'counts' : 'collections');
export async function lookupTopic(store, root, kind, slug) {
  if (!slugOK(slug)) fail('Invalid topic');
  const hash = await digest(slug);
  let prefix = '';
  for (let depth = 0; depth <= 64; depth++) {
    if (root.bytes > 65536) fail('Oversized directory');
    const node = await store.read(facetFor(kind), root);
    if (node.kind !== kind || node.prefix !== prefix) fail('Wrong topic directory context');
    if (node.type === 'hashed-topic-leaf') {
      if (
        !Array.isArray(node.entries) ||
        new Set(node.entries.map((e) => e.slug)).size !== node.entries.length ||
        node.entries.some((e) => !slugOK(e.slug))
      )
        fail('Invalid topic leaf');
      return node.entries.find((e) => e.slug === slug);
    }
    if (
      node.type !== 'hashed-topic-branch' ||
      !node.children ||
      Array.isArray(node.children) ||
      Object.keys(node.children).length > 16
    )
      fail('Invalid topic branch');
    prefix = hash.slice(0, prefix.length + 1);
    root = node.children[prefix];
    if (!root) return undefined;
  }
  fail('Topic directory depth exceeded');
}
export async function emitDirectory(store, entries, kind, prefix = '') {
  const facet = facetFor(kind),
    rows = [...entries].sort((a, b) => a.slug.localeCompare(b.slug, 'en'));
  if (new Set(rows.map((e) => e.slug)).size !== rows.length) fail('Duplicate topic entry');
  for (const e of rows)
    if (!slugOK(e.slug) || !(await digest(e.slug)).startsWith(prefix))
      fail('Wrong topic partition');
  const leaf = { schema: 1, type: 'hashed-topic-leaf', kind, prefix, entries: rows },
    limit = kind === 'count' ? 4096 : 64512;
  if (
    bytesOf({ type: 'leaf', prefix, entries: rows }).length <= limit &&
    bytesOf(leaf).length <= 65536
  )
    return store.put(facet, leaf);
  if (prefix.length >= 64) fail('Oversized topic entry');
  const groups = new Map();
  for (const e of rows) {
    const part = (await digest(e.slug)).slice(0, prefix.length + 1);
    if (!groups.has(part)) groups.set(part, []);
    groups.get(part).push(e);
  }
  const children = {};
  for (const [p, list] of [...groups].sort())
    children[p] = await emitDirectory(store, list, kind, p);
  return store.put(facet, { type: 'hashed-topic-branch', kind, prefix, children });
}
export async function patchTopic(store, root, kind, slug, entry) {
  if (!slugOK(slug) || (entry && entry.slug !== slug)) fail('Invalid directory update');
  const hash = await digest(slug),
    facet = facetFor(kind);
  async function patch(d, prefix = '') {
    if (!d) return emitDirectory(store, entry ? [entry] : [], kind, prefix);
    const node = await store.read(facet, d);
    if (node.kind !== kind || node.prefix !== prefix) fail('Wrong update directory');
    if (node.type === 'hashed-topic-leaf') {
      const rows = node.entries.filter((e) => e.slug !== slug);
      if (entry) rows.push(entry);
      return emitDirectory(store, rows, kind, prefix);
    }
    if (node.type !== 'hashed-topic-branch' || !node.children) fail('Invalid update branch');
    const key = hash.slice(0, prefix.length + 1),
      next = await patch(node.children[key], key),
      child = await store.read(facet, next),
      children = { ...node.children };
    if (child.type === 'hashed-topic-leaf' && child.entries.length === 0) delete children[key];
    else children[key] = next;
    return Object.keys(children).length
      ? store.put(facet, { ...node, children })
      : emitDirectory(store, [], kind, prefix);
  }
  return patch(root);
}
