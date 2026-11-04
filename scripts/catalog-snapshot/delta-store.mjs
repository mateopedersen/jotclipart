// Publisher-only bounded overlay over a previously authenticated metadata graph.
// An old object is reusable only through a descriptor actually reached from that
// predecessor; knowing an unrelated content-addressed key does not admit it.
import { sha256 } from './stage-manifest.mjs';
const facets = '(?:artworks|collections|search|recent|related|counts|sitemaps)',
  keyPattern = new RegExp('^catalog/objects/' + facets + '/([a-f0-9]{64})\\.json$');
export function createDeltaStore(
  parentBucket,
  parentContext,
  { maxObjects = 20000, maxBytes = 128 * 1024 * 1024 } = {},
) {
  if (
    parentContext?.authorizationVerified !== true ||
    parentContext.snapshot?.fixture ||
    parentContext.snapshot?.status !== 'SOURCE_MEDIA_GRAPH_VERIFIED' ||
    !Number.isSafeInteger(maxObjects) ||
    maxObjects < 1 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1
  )
    throw Error('Authenticated production predecessor and bounded overlay required');
  const allowed = new Map(),
    created = new Map(),
    cached = new Map(),
    pending = new Map();
  let reads = 0,
    readBytes = 0,
    createdBytes = 0;
  function descriptor(d) {
    return (
      d &&
      typeof d === 'object' &&
      keyPattern.test(d.key ?? '') &&
      d.key.split('/').at(-1) === d.sha256 + '.json' &&
      Number.isSafeInteger(d.bytes) &&
      d.bytes > 0 &&
      d.bytes <= 1048576
    );
  }
  function discover(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.key === 'string' && value.key.startsWith('catalog/objects/')) {
      if (!descriptor(value)) throw Error('Invalid authenticated child descriptor');
      const old = allowed.get(value.key);
      if (old && old.bytes !== value.bytes) throw Error('Conflicting authenticated child bytes');
      allowed.set(value.key, { key: value.key, bytes: value.bytes, sha256: value.sha256 });
      return;
    }
    for (const v of Object.values(value)) discover(v);
  }
  discover(parentContext.snapshot.indexes);
  const object = (key, b) => ({
    size: b.length,
    etag: sha256(b),
    arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
    json: async () => JSON.parse(b),
  });
  async function get(key) {
    if (created.has(key)) return object(key, created.get(key));
    if (!allowed.has(key)) throw Error('Metadata is not reachable from authenticated predecessor');
    if (cached.has(key)) return object(key, cached.get(key));
    if (pending.has(key)) return pending.get(key);
    const d = allowed.get(key);
    if (++reads > maxObjects || (readBytes += d.bytes) > maxBytes)
      throw Error('Changed-batch parent read budget exceeded');
    const p = (async () => {
      const r = await parentBucket.get(key);
      if (!r || r.size !== d.bytes) throw Error('Missing predecessor metadata');
      const bytes = Buffer.from(await r.arrayBuffer());
      if (bytes.length !== d.bytes || sha256(bytes) !== d.sha256)
        throw Error('Corrupt predecessor metadata');
      const value = JSON.parse(bytes);
      if (value.fixture === true || value.status === 'PRIVATE_UNPUBLISHABLE')
        throw Error('Private predecessor metadata');
      discover(value);
      cached.set(key, bytes);
      return object(key, bytes);
    })();
    pending.set(key, p);
    try {
      return await p;
    } finally {
      pending.delete(key);
    }
  }
  async function put(key, body) {
    const b = Buffer.from(body);
    if (
      !keyPattern.test(key) ||
      sha256(b) !== key.split('/').at(-1).slice(0, -5) ||
      !b.length ||
      b.length > 1048576
    )
      throw Error('Invalid changed immutable metadata');
    if (allowed.has(key)) {
      const old = await get(key);
      if (!Buffer.from(await old.arrayBuffer()).equals(b))
        throw Error('Predecessor object differs');
      return { etag: sha256(b) };
    }
    const prior = created.get(key);
    if (prior) {
      if (!prior.equals(b)) throw Error('Changed object collision');
      return { etag: sha256(b) };
    }
    if (created.size >= maxObjects || createdBytes + b.length > maxBytes)
      throw Error('Changed-batch output budget exceeded');
    const value = JSON.parse(b);
    if (value.fixture === true || value.status === 'UNIMPLEMENTED_FIXTURE_FACET')
      throw Error('Unimplemented changed metadata');
    created.set(key, b);
    createdBytes += b.length;
    return { etag: sha256(b) };
  }
  function verifyChangedClosure(indexes) {
    const seen = new Map();
    function visit(d) {
      if (!descriptor(d)) throw Error('Invalid changed graph descriptor');
      if (allowed.has(d.key)) {
        const old = allowed.get(d.key);
        if (old.bytes !== d.bytes || old.sha256 !== d.sha256)
          throw Error('Substituted predecessor reference');
        return;
      }
      const b = created.get(d.key);
      if (!b || b.length !== d.bytes || sha256(b) !== d.sha256)
        throw Error('Changed graph reaches an unverified orphan');
      if (seen.has(d.key)) return;
      seen.set(d.key, { key: d.key, sha256: d.sha256, bytes: d.bytes });
      const v = JSON.parse(b);
      if (
        v.fixture === true ||
        v.status === 'PRIVATE_UNPUBLISHABLE' ||
        v.status === 'UNIMPLEMENTED_FIXTURE_FACET'
      )
        throw Error('Unapproved changed node');
      const scan = (x) => {
        if (!x || typeof x !== 'object') return;
        if (x.key?.startsWith?.('catalog/objects/')) {
          visit(x);
          return;
        }
        for (const c of Object.values(x)) scan(c);
      };
      scan(v);
    }
    for (const d of Object.values(indexes)) visit(d);
    return {
      status: 'CHANGED_GRAPH_REACHABILITY_ONLY_NOT_SOURCE_APPROVAL',
      newReachable: seen.size,
      newReachableDescriptors: [...seen.values()].sort((a, b) => a.key.localeCompare(b.key)),
      reusedReachedDescriptors: allowed.size,
      createdObjects: created.size,
      readObjects: reads,
      readBytes,
      catalogScans: 0,
    };
  }
  return {
    bucket: { get, put },
    created,
    allowed,
    verifyChangedClosure,
    metrics: () => ({
      readObjects: reads,
      readBytes,
      createdObjects: created.size,
      createdBytes,
      catalogScans: 0,
    }),
  };
}
