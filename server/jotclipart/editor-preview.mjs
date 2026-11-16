import manifestConfig from '../../config/jotclipart-editor-previews.json' with { type: 'json' };
import { canonical, digest } from '../catalog-search/store.mjs';
import { readPublicArtwork } from '../catalog-snapshot/public-artwork-routes.mjs';
import { lookupHashedRecord } from '../catalog-snapshot/hashed-record-directory.mjs';

const HEX = /^[a-f0-9]{64}$/;
const hex = (value) => typeof value === 'string' && HEX.test(value);
const PATH = /^\/previews\/p1\/([a-f0-9]{24})-960\.webp$/;
const MAX_BODY = 1024 * 1024;
const MAX_SHARD = 128 * 1024;
const shardCache = new Map(),
  pendingShards = new Map();
let shardBytes = 0;
const encoder = new TextEncoder(),
  decoder = new TextDecoder('utf8', { fatal: true });
const fault = (code) => {
  throw Error('EDITOR_PREVIEW_' + code);
};
const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
const exact = (object, fields) =>
  object &&
  typeof object === 'object' &&
  !Array.isArray(object) &&
  Object.keys(object).sort().join('|') === [...fields].sort().join('|');
export const isLegacyEditorPreviewPath = (path) => typeof path === 'string' && PATH.test(path);

async function validateManifest(value) {
  if (
    value?.schema !== 1 ||
    !hex(value.rootSHA256) ||
    value.source?.file !== 'data/jotclipart-editor-previews.jsonl.gz' ||
    !['sha256', 'catalogRoot', 'manifestRoot', 'manifestSHA256'].every((k) =>
      hex(value.source[k]),
    ) ||
    !integer(value.source.bytes, 1, 64 * 1024 * 1024) ||
    !integer(value.source.manifestBytes, 1, 128 * 1024 * 1024) ||
    !integer(value.records, 1, 1000000) ||
    !integer(value.maxPreviewBytes, 1, MAX_BODY) ||
    !integer(value.totalPreviewBytes, 1, value.records * value.maxPreviewBytes) ||
    !value.shards ||
    Array.isArray(value.shards) ||
    Object.keys(value.shards).length !== 256
  )
    fault('MANIFEST');
  let count = 0;
  for (let n = 0; n < 256; n++) {
    const row = value.shards[n.toString(16).padStart(2, '0')];
    if (
      !exact(row, ['sha256', 'bytes', 'records']) ||
      !hex(row.sha256) ||
      !integer(row.bytes, 1, MAX_SHARD) ||
      !integer(row.records, 0, 1024)
    )
      fault('SHARD_DESCRIPTOR');
    count += row.records;
  }
  if (
    count !== value.records ||
    (await digest(
      JSON.stringify(
        canonical({
          schema: 1,
          sourceSHA256: value.source.sha256,
          shards: value.shards,
        }),
      ),
    )) !== value.rootSHA256
  )
    fault('MANIFEST_ROOT');
  return value;
}
async function boundedBytes(value, expected) {
  const stream = value.body;
  if (!stream?.getReader) {
    const result = new Uint8Array(await value.arrayBuffer());
    if (result.length !== expected) fault('BODY_LENGTH');
    return result;
  }
  const reader = stream.getReader(),
    chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      length += chunk.length;
      if (length > expected) {
        await reader.cancel();
        fault('BODY_LENGTH');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  if (length !== expected) fault('BODY_LENGTH');
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
function parseShard(bytes, descriptor, prefix, manifest) {
  let value;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    fault('SHARD_JSON');
  }
  if (
    !exact(value, ['schema', 'files']) ||
    value.schema !== 1 ||
    !Array.isArray(value.files) ||
    value.files.length !== descriptor.records
  )
    fault('SHARD_RECORDS');
  let last = '';
  const ids = new Set();
  for (const row of value.files) {
    const match = PATH.exec(row?.path ?? '');
    if (
      !exact(row, ['id', 'sourceSHA256', 'path', 'sha256', 'bytes', 'width', 'height']) ||
      typeof row.id !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.id) ||
      row.id.length > 512 ||
      ids.has(row.id) ||
      !match ||
      match[1].slice(0, 2) !== prefix ||
      row.path <= last ||
      !hex(row.sourceSHA256) ||
      !hex(row.sha256) ||
      !integer(row.bytes, 1, manifest.maxPreviewBytes) ||
      !integer(row.width, 1, 960) ||
      !integer(row.height, 1, 960)
    )
      fault('SHARD_ROW');
    ids.add(row.id);
    last = row.path;
  }
  return value.files;
}
async function shardRows(assets, manifest, prefix) {
  const descriptor = manifest.shards[prefix],
    key = manifest.rootSHA256 + '/' + descriptor.sha256;
  let bytes = shardCache.get(key);
  if (bytes) {
    shardCache.delete(key);
    shardCache.set(key, bytes);
  } else {
    if (!pendingShards.has(key)) {
      if (pendingShards.size >= 16) fault('INDEX_BUSY');
      const loading = (async () => {
        const response = await assets.fetch(
          new Request(
            `https://jotclipart.com/__editor-preview-index/${manifest.rootSHA256}/${prefix}.json`,
            {
              method: 'GET',
              redirect: 'manual',
              headers: { Accept: 'application/json' },
              signal: AbortSignal.timeout(15000),
            },
          ),
        );
        if (
          response.status !== 200 ||
          response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
            'application/json'
        )
          fault('INDEX_UNAVAILABLE');
        const loaded = await boundedBytes(response, descriptor.bytes);
        if ((await digest(loaded)) !== descriptor.sha256) fault('SHARD_SHA');
        parseShard(loaded, descriptor, prefix, manifest);
        shardCache.set(key, loaded);
        shardBytes += loaded.length;
        while (shardCache.size > 32 || shardBytes > 4 * 1024 * 1024) {
          const oldest = shardCache.keys().next().value;
          shardBytes -= shardCache.get(oldest).length;
          shardCache.delete(oldest);
        }
        return loaded;
      })();
      pendingShards.set(key, loading);
    }
    const pending = pendingShards.get(key);
    try {
      bytes = await pending;
    } finally {
      if (pendingShards.get(key) === pending) pendingShards.delete(key);
    }
  }
  return parseShard(bytes, descriptor, prefix, manifest);
}
function webpDimensions(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    ascii = (at, n) => String.fromCharCode(...bytes.subarray(at, at + n));
  if (
    bytes.length < 26 ||
    ascii(0, 4) !== 'RIFF' ||
    ascii(8, 4) !== 'WEBP' ||
    view.getUint32(4, true) !== bytes.length - 8
  )
    fault('WEBP_MAGIC');
  let offset = 12,
    extended,
    raster;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) fault('WEBP_CHUNK');
    const type = ascii(offset, 4),
      length = view.getUint32(offset + 4, true),
      start = offset + 8,
      end = start + length;
    if (!length || end + (length % 2) > bytes.length) fault('WEBP_CHUNK');
    if (type === 'VP8X') {
      if (offset !== 12 || length !== 10 || extended || bytes[start] & 2) fault('WEBP_ANIMATION');
      extended = {
        width: 1 + bytes[start + 4] + (bytes[start + 5] << 8) + (bytes[start + 6] << 16),
        height: 1 + bytes[start + 7] + (bytes[start + 8] << 8) + (bytes[start + 9] << 16),
      };
    } else if (type === 'VP8L') {
      if (raster || length < 5 || bytes[start] !== 0x2f) fault('WEBP_RASTER');
      const bits = view.getUint32(start + 1, true);
      if (bits >>> 29) fault('WEBP_VERSION');
      raster = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    } else if (type === 'VP8 ') {
      if (raster || length < 10 || bytes[start] & 1 || ascii(start + 3, 3) !== '\x9d\x01\x2a')
        fault('WEBP_RASTER');
      raster = {
        width: view.getUint16(start + 6, true) & 0x3fff,
        height: view.getUint16(start + 8, true) & 0x3fff,
      };
    } else if (!['ALPH', 'ICCP', 'EXIF', 'XMP '].includes(type)) fault('WEBP_CHUNK');
    offset = end + (length % 2);
  }
  if (
    !raster ||
    (extended && (extended.width !== raster.width || extended.height !== raster.height))
  )
    fault('WEBP_DIMENSIONS');
  return raster;
}
async function verifiedImage(value, row) {
  const bytes = await boundedBytes(value, row.bytes);
  if ((await digest(bytes)) !== row.sha256) fault('BODY_SHA');
  const dimensions = webpDimensions(bytes);
  if (dimensions.width !== row.width || dimensions.height !== row.height) fault('WEBP_DIMENSIONS');
  return bytes;
}
const unavailable = (status) =>
  new Response(status === 405 ? 'Method not allowed' : 'Not found', {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex',
      'X-Content-Type-Options': 'nosniff',
      ...(status === 405 ? { Allow: 'GET, HEAD' } : {}),
    },
  });
function rangeFor(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value ?? '');
  if (!match || (!match[1] && !match[2])) return null;
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!integer(suffix, 1, Number.MAX_SAFE_INTEGER)) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!integer(start, 0, size - 1) || !integer(end, start, Number.MAX_SAFE_INTEGER)) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

export function createLegacyEditorPreviewService({
  assets,
  bucket,
  manifest,
  expectedRootSHA256,
  allowFixture = false,
}) {
  if (manifest !== undefined && !allowFixture) fault('FIXTURE_MANIFEST_FORBIDDEN');
  const frozen = structuredClone(manifest ?? manifestConfig);
  if (!hex(expectedRootSHA256) || expectedRootSHA256 !== frozen.rootSHA256) fault('EXPECTED_ROOT');
  let ready;
  return {
    async response(request, context, { cache, defer } = {}) {
      const url = new URL(request.url),
        match = PATH.exec(url.pathname);
      if (!match || url.search || url.hash) return unavailable(404);
      if (!['GET', 'HEAD'].includes(request.method)) return unavailable(405);
      if (
        !(
          context?.authorizationVerified === true &&
          context.authorizationKind === 'SIGNED_SOURCE_MEDIA_GRAPH_SNAPSHOT'
        ) &&
        !(allowFixture && context?.snapshot?.fixture === true)
      )
        fault('AUTHORIZATION_REQUIRED');
      const approved = await (ready ??= validateManifest(frozen)),
        prefix = match[1].slice(0, 2),
        rows = await shardRows(assets, approved, prefix),
        row = rows.find((item) => item.path === url.pathname);
      if (!row) return unavailable(404);
      // Never let immutable body caches bypass the current signed artwork decision.
      const artwork = await readPublicArtwork(context, row.id);
      if (
        !artwork ||
        artwork.published !== true ||
        artwork.indexable !== true ||
        artwork.files?.webp?.sha256 !== row.sourceSHA256
      )
        return unavailable(404);
      const artRoot = await context.getFacet('artworks'),
        decision = await lookupHashedRecord(context, 'artworks', artRoot.editorPreviews, row.id);
      if (
        !decision ||
        decision.schema !== 1 ||
        decision.type !== 'editor-source' ||
        decision.id !== row.id ||
        decision.sourceSHA256 !== row.sourceSHA256 ||
        decision.preview !== row.path ||
        decision.width !== row.width ||
        decision.height !== row.height
      )
        return unavailable(404);
      const etag = '"' + row.sha256 + '"',
        headers = new Headers({
          'Content-Type': 'image/webp',
          ETag: etag,
          'Content-Length': String(row.bytes),
          'Cache-Control': 'public, max-age=31536000, immutable, no-transform',
          'X-Content-Type-Options': 'nosniff',
          'X-Robots-Tag': 'noindex',
          'Accept-Ranges': 'bytes',
        }),
        key = new Request(
          `${url.origin}/__editor-preview-cache/${approved.rootSHA256}/${row.sha256}`,
        );
      let bytes,
        cached = cache ? await cache.match(key) : null;
      if (cached) {
        if (
          cached.status !== 200 ||
          cached.headers.get('content-type') !== 'image/webp' ||
          cached.headers.get('etag') !== etag ||
          cached.headers.has('content-encoding')
        )
          fault('CACHE_METADATA');
        bytes = await verifiedImage(cached, row);
      } else {
        const object = await bucket.get('delivery' + row.path);
        if (
          !object ||
          object.size !== row.bytes ||
          object.httpMetadata?.contentType?.split(';')[0].trim().toLowerCase() !== 'image/webp'
        )
          fault('BODY_UNAVAILABLE');
        bytes = await verifiedImage(object, row);
        if (cache) {
          const storing = cache.put(key, new Response(bytes, { headers })).catch(() => {});
          if (defer) defer(storing);
          else await storing;
        }
      }
      if (
        request.headers
          .get('If-None-Match')
          ?.split(',')
          .some((value) => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag)
      ) {
        headers.delete('Content-Length');
        return new Response(null, { status: 304, headers });
      }
      const range = request.method === 'GET' ? request.headers.get('Range') : null,
        ifRange = request.headers.get('If-Range');
      if (range && (!ifRange || ifRange === etag)) {
        const parsed = rangeFor(range, bytes.length);
        if (!parsed) {
          headers.set('Content-Range', 'bytes */' + bytes.length);
          headers.set('Content-Length', '0');
          headers.set('Cache-Control', 'private, no-store');
          return new Response(null, { status: 416, headers });
        }
        headers.set('Content-Range', `bytes ${parsed.start}-${parsed.end}/${bytes.length}`);
        headers.set('Content-Length', String(parsed.end - parsed.start + 1));
        return new Response(bytes.subarray(parsed.start, parsed.end + 1), { status: 206, headers });
      }
      return new Response(request.method === 'HEAD' ? null : bytes, { headers });
    },
  };
}
