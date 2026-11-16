import { deflate, inflate } from 'pako';
import { Resvg, initWasm } from '@resvg/resvg-wasm';
import decodeWebP, { init as initWebP } from '@jsquash/webp/decode.js';

// The caller resolves IDs against the authenticated catalog before constructing
// this descriptor. This module never accepts a caller-supplied image URL or SVG.
export const OG_VERSION = 'jotclipart-og-v1';
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;
export const OG_LIMITS = Object.freeze({
  imageBytes: 1024 * 1024,
  imageDimension: 1024,
  imagePixels: 1024 * 1024,
  imageCount: 2,
  rasterDimension: 640,
  outputBytes: 3 * 1024 * 1024,
  queue: 4,
});
const ORIGIN = 'https://jotclipart.com';
const ASSETS = 'https://assets.jotclipart.com';
const HEX = /^[a-f0-9]{64}$/;
const KINDS = new Set(['art', 'topic', 'collection', 'editor', 'page']);
const encoder = new TextEncoder();
export class OgError extends Error {
  constructor(code) {
    super(code);
    this.name = 'OgError';
    this.code = code;
  }
}
function must(ok, code) {
  if (!ok) throw new OgError(code);
}
export async function ogSHA256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');
}
const jsonSHA = (v) => ogSHA256(encoder.encode(JSON.stringify(v)));
const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
function joined(arrays) {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.byteLength, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.byteLength;
  }
  return out;
}
function ascii(bytes, at, length) {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}
function objectKey(value) {
  must(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 2048 &&
      !value.startsWith('/') &&
      !/[\x00-\x1f\\]/.test(value) &&
      !value.split('/').some((s) => !s || s === '.' || s === '..'),
    'UNSAFE_OG_OBJECT_KEY',
  );
  return value;
}
function assetSpec(value) {
  must(value && typeof value === 'object', 'MISSING_OG_IMAGE');
  must(
    HEX.test(value.sha256 ?? '') &&
      Number.isSafeInteger(value.bytes) &&
      value.bytes > 0 &&
      value.bytes <= OG_LIMITS.imageBytes &&
      ['image/webp', 'image/png'].includes(value.mime),
    'INVALID_OG_IMAGE_IDENTITY',
  );
  must(!Object.hasOwn(value, 'url') && !Object.hasOwn(value, 'src'), 'OG_URL_PROXY_FORBIDDEN');
  return {
    objectKey: objectKey(value.objectKey),
    mime: value.mime,
    bytes: value.bytes,
    sha256: value.sha256,
  };
}
function sourceSpec(value) {
  must(value && KINDS.has(value.kind), 'INVALID_OG_KIND');
  must(typeof value.id === 'string' && /^[a-zA-Z0-9._-]{1,180}$/.test(value.id), 'INVALID_OG_ID');
  must(
    typeof value.title === 'string' &&
      value.title.length > 0 &&
      value.title.length <= 256 &&
      !/[\x00-\x1f\x7f]/.test(value.title),
    'INVALID_OG_TITLE',
  );
  must(!/ultraclipart/i.test(value.title), 'OLD_BRAND_IN_OG_TITLE');
  if (['art', 'topic', 'collection'].includes(value.kind))
    must(/^Free\s+\S/.test(value.title) && !/^Free\s+Free\b/i.test(value.title), 'OG_FREE_PREFIX');
  must(!/\bClipart\s+Clipart\b/i.test(value.title), 'OG_CLIPART_DUPLICATION');
  const canonical = new URL(value.canonicalPath, ORIGIN);
  must(
    canonical.origin === ORIGIN &&
      canonical.pathname === value.canonicalPath &&
      canonical.pathname.startsWith('/') &&
      !canonical.search &&
      !canonical.hash &&
      !canonical.username &&
      !canonical.password &&
      !/[\\\s]/.test(value.canonicalPath),
    'INVALID_OG_CANONICAL_PATH',
  );
  must(HEX.test(value.sourceSHA256 ?? '') && HEX.test(value.sourceRoot ?? ''), 'UNBOUND_OG_SOURCE');
  must(
    Array.isArray(value.images) && value.images.length <= OG_LIMITS.imageCount,
    'OG_IMAGE_COUNT',
  );
  must(value.kind === 'page' || value.images.length > 0, 'OG_CATALOG_IMAGE_REQUIRED');
  const images = Object.freeze(value.images.map((image) => Object.freeze(assetSpec(image))));
  must(new Set(images.map((a) => a.objectKey)).size === images.length, 'DUPLICATE_OG_IMAGE');
  return {
    kind: value.kind,
    id: value.id,
    title: value.title,
    canonicalPath: value.canonicalPath,
    sourceSHA256: value.sourceSHA256,
    sourceRoot: value.sourceRoot,
    images,
  };
}
function renderIdentity(value) {
  must(
    value && HEX.test(value.rendererSHA256 ?? '') && HEX.test(value.logoSHA256 ?? ''),
    'UNBOUND_OG_RENDERER',
  );
  must(
    Array.isArray(value.fontSHA256) &&
      value.fontSHA256.length === 2 &&
      value.fontSHA256.every((s) => HEX.test(s)),
    'UNBOUND_OG_FONTS',
  );
  return Object.freeze({
    version: OG_VERSION,
    rendererSHA256: value.rendererSHA256,
    logoSHA256: value.logoSHA256,
    fontSHA256: Object.freeze([...value.fontSHA256]),
  });
}
export async function prepareOgDescriptor(source, renderer) {
  const input = sourceSpec(source),
    identity = renderIdentity(renderer);
  // Root is authenticated provenance, not content identity. A new unrelated
  // import must not invalidate every unchanged cover in the catalog.
  const { sourceRoot: _sourceRoot, ...content } = input;
  const digest = await jsonSHA({ ...identity, ...content });
  const path = `/og/catalog/${input.kind}/${encodeURIComponent(input.id)}/${digest}.png`;
  return Object.freeze({
    ...input,
    ...identity,
    digest,
    path,
    url: ORIGIN + path,
    width: OG_WIDTH,
    height: OG_HEIGHT,
    type: 'image/png',
  });
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let n = 0xffffffff;
  for (const v of bytes) n = crcTable[(n ^ v) & 255] ^ (n >>> 8);
  return (n ^ 0xffffffff) >>> 0;
}
function pngChunk(name, data) {
  const out = new Uint8Array(data.length + 12),
    d = view(out);
  d.setUint32(0, data.length);
  out.set(encoder.encode(name), 4);
  out.set(data, 8);
  d.setUint32(out.length - 4, crc32(out.subarray(4, -4)));
  return out;
}
export function encodeOgPNG(image) {
  must(
    Number.isSafeInteger(image.width) &&
      Number.isSafeInteger(image.height) &&
      image.width > 0 &&
      image.height > 0 &&
      image.width * image.height <= OG_LIMITS.imagePixels &&
      image.data?.length === image.width * image.height * 4,
    'INVALID_OG_RGBA',
  );
  const header = new Uint8Array(13),
    d = view(header);
  d.setUint32(0, image.width);
  d.setUint32(4, image.height);
  header[8] = 8;
  header[9] = 6;
  const stride = image.width * 4,
    scanlines = new Uint8Array((stride + 1) * image.height);
  for (let y = 0; y < image.height; y++)
    scanlines.set(image.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return joined([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflate(scanlines)),
    pngChunk('IEND', new Uint8Array()),
  ]);
}
export function imageDimensions(bytes, mime) {
  let width, height;
  const d = view(bytes);
  if (mime === 'image/png') {
    must(
      bytes.length >= 33 &&
        [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v) &&
        ascii(bytes, 12, 4) === 'IHDR',
      'OG_IMAGE_MAGIC',
    );
    width = d.getUint32(16);
    height = d.getUint32(20);
  } else {
    must(
      bytes.length >= 30 &&
        ascii(bytes, 0, 4) === 'RIFF' &&
        ascii(bytes, 8, 4) === 'WEBP' &&
        d.getUint32(4, true) + 8 === bytes.length,
      'OG_IMAGE_MAGIC',
    );
    const type = ascii(bytes, 12, 4);
    if (type === 'VP8X') {
      must(!(bytes[20] & 2), 'OG_ANIMATION_FORBIDDEN');
      width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    } else if (type === 'VP8L') {
      must(bytes[20] === 0x2f, 'OG_IMAGE_MAGIC');
      const n = d.getUint32(21, true);
      width = (n & 0x3fff) + 1;
      height = ((n >>> 14) & 0x3fff) + 1;
    } else {
      must(
        type === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a,
        'OG_IMAGE_MAGIC',
      );
      width = d.getUint16(26, true) & 0x3fff;
      height = d.getUint16(28, true) & 0x3fff;
    }
  }
  must(
    width > 0 &&
      height > 0 &&
      width <= OG_LIMITS.imageDimension &&
      height <= OG_LIMITS.imageDimension &&
      width * height <= OG_LIMITS.imagePixels,
    'OG_PIXEL_BOUND',
  );
  return { width, height };
}

// Re-containerize the existing Inter WOFF1 tables. Glyphs, metrics and outlines
// are unchanged; only the SFNT directory and whole-font checksum are rebuilt.
export function ogFontSFNT(woff) {
  must(
    woff instanceof Uint8Array && woff.length >= 44 && woff.length <= 256 * 1024,
    'INVALID_OG_FONT',
  );
  const d = view(woff);
  must(
    ascii(woff, 0, 4) === 'wOFF' && d.getUint32(4) === 0x00010000 && d.getUint32(8) === woff.length,
    'INVALID_OG_FONT',
  );
  const count = d.getUint16(12);
  must(count > 0 && count <= 64 && 44 + count * 20 <= woff.length, 'INVALID_OG_FONT');
  const tables = [];
  let size = 12 + count * 16;
  for (let i = 0; i < count; i++) {
    const at = 44 + i * 20,
      offset = d.getUint32(at + 4),
      compressed = d.getUint32(at + 8),
      original = d.getUint32(at + 12);
    must(
      compressed > 0 &&
        compressed <= original &&
        offset >= 44 + count * 20 &&
        offset + compressed <= woff.length &&
        original <= 256 * 1024,
      'INVALID_OG_FONT_TABLE',
    );
    const raw = woff.subarray(offset, offset + compressed),
      data = compressed === original ? raw : inflate(raw);
    must(data.length === original, 'OG_FONT_TABLE_LENGTH');
    tables.push({ tag: ascii(woff, at, 4), checksum: d.getUint32(at + 16), data, offset: size });
    size += Math.ceil(data.length / 4) * 4;
    must(size <= 512 * 1024, 'OG_FONT_EXPANSION_BOUND');
  }
  must(
    size === d.getUint32(16) && new Set(tables.map((t) => t.tag)).size === count,
    'OG_FONT_DIRECTORY',
  );
  const out = new Uint8Array(size),
    v = view(out),
    power = 2 ** Math.floor(Math.log2(count));
  v.setUint32(0, 0x00010000);
  v.setUint16(4, count);
  v.setUint16(6, power * 16);
  v.setUint16(8, Math.log2(power));
  v.setUint16(10, count * 16 - power * 16);
  let head;
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i],
      at = 12 + i * 16;
    out.set(encoder.encode(t.tag), at);
    v.setUint32(at + 4, t.checksum);
    v.setUint32(at + 8, t.offset);
    v.setUint32(at + 12, t.data.length);
    out.set(t.data, t.offset);
    if (t.tag === 'head') {
      head = t.offset;
      v.setUint32(head + 8, 0);
    }
  }
  must(head !== undefined, 'OG_FONT_HEAD_ABSENT');
  let sum = 0;
  for (let i = 0; i < out.length; i += 4) sum = (sum + v.getUint32(i)) >>> 0;
  v.setUint32(head + 8, (0xb1b0afba - sum) >>> 0);
  return out;
}
function fontMetrics(sfnt) {
  const d = view(sfnt),
    tables = new Map();
  for (let i = 0; i < d.getUint16(4); i++) {
    const at = 12 + i * 16;
    tables.set(ascii(sfnt, at, 4), d.getUint32(at + 8));
  }
  for (const name of ['head', 'hhea', 'hmtx', 'cmap']) must(tables.has(name), 'OG_FONT_METRICS');
  const units = d.getUint16(tables.get('head') + 18),
    metrics = d.getUint16(tables.get('hhea') + 34),
    cmap = tables.get('cmap');
  let mapping;
  for (let i = 0; i < d.getUint16(cmap + 2); i++) {
    const at = cmap + 4 + i * 8,
      table = cmap + d.getUint32(at + 4),
      format = d.getUint16(table);
    if (format === 4 && !mapping) mapping = { table, format };
    if (format === 12) mapping = { table, format };
  }
  must(mapping && units > 0 && metrics > 0, 'OG_FONT_UNICODE_METRICS');
  function glyph(code) {
    const t = mapping.table;
    if (mapping.format === 12) {
      for (let i = 0; i < d.getUint32(t + 12); i++) {
        const at = t + 16 + i * 12,
          start = d.getUint32(at),
          end = d.getUint32(at + 4);
        if (code >= start && code <= end) return d.getUint32(at + 8) + code - start;
      }
      return 0;
    }
    const count = d.getUint16(t + 6) / 2,
      ends = t + 14,
      starts = ends + count * 2 + 2,
      deltas = starts + count * 2,
      ranges = deltas + count * 2;
    for (let i = 0; i < count; i++) {
      if (code < d.getUint16(starts + i * 2) || code > d.getUint16(ends + i * 2)) continue;
      const delta = d.getInt16(deltas + i * 2),
        range = d.getUint16(ranges + i * 2);
      if (!range) return (code + delta) & 0xffff;
      const at = ranges + i * 2 + range + (code - d.getUint16(starts + i * 2)) * 2;
      must(at + 2 <= sfnt.length, 'OG_FONT_CMAP_BOUND');
      const g = d.getUint16(at);
      return g ? (g + delta) & 0xffff : 0;
    }
    return 0;
  }
  return (text, size) =>
    [...text].reduce((n, c) => {
      const g = glyph(c.codePointAt(0));
      must(g !== 0, 'OG_FONT_GLYPH_UNAVAILABLE');
      return n + (d.getUint16(tables.get('hmtx') + Math.min(g, metrics - 1) * 4) * size) / units;
    }, 0);
}
export function wrapOgTitle(title, measure) {
  for (const size of [48, 44, 40, 36, 32, 28, 24]) {
    const lines = [];
    let line = '';
    for (const word of title.split(/\s+/)) {
      if (line && measure(line + ' ' + word, size) > 470) {
        lines.push(line);
        line = '';
      }
      for (const letter of word) {
        if (line && measure(line + letter, size) > 470) {
          lines.push(line);
          line = '';
        }
        line += letter;
      }
      line += ' ';
    }
    if (line.trim()) lines.push(line.trim());
    const trimmed = lines.map((s) => s.trim());
    if (trimmed.length * size * 1.18 <= 310)
      return { lines: trimmed, size, lineHeight: size * 1.18 };
  }
  throw new OgError('OG_TITLE_LAYOUT_BOUND');
}
function rasterBound(image) {
  const scale = Math.min(1, OG_LIMITS.rasterDimension / Math.max(image.width, image.height));
  if (scale === 1) return image;
  const width = Math.max(1, Math.round(image.width * scale)),
    height = Math.max(1, Math.round(image.height * scale)),
    data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, (x + 0.5) / scale - 0.5),
        sy = Math.min(image.height - 1, (y + 0.5) / scale - 0.5),
        x0 = Math.max(0, Math.floor(sx)),
        y0 = Math.max(0, Math.floor(sy)),
        x1 = Math.min(image.width - 1, x0 + 1),
        y1 = Math.min(image.height - 1, y0 + 1),
        dx = sx - x0,
        dy = sy - y0;
      const samples = [
        [x0, y0, (1 - dx) * (1 - dy)],
        [x1, y0, dx * (1 - dy)],
        [x0, y1, (1 - dx) * dy],
        [x1, y1, dx * dy],
      ];
      const dest = (y * width + x) * 4;
      let alpha = 0;
      const colors = [0, 0, 0];
      for (const [xx, yy, weight] of samples) {
        const at = (yy * image.width + xx) * 4,
          a = image.data[at + 3] * weight;
        alpha += a;
        for (let c = 0; c < 3; c++) colors[c] += image.data[at + c] * a;
      }
      for (let c = 0; c < 3; c++) data[dest + c] = alpha ? Math.round(colors[c] / alpha) : 0;
      data[dest + 3] = Math.round(alpha);
    }
  return { width, height, data };
}
const xml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c],
  );
function composeSVG(spec, title) {
  const labels = {
    art: 'CLIPART',
    topic: 'CLIPART SUBJECT',
    collection: 'CLIPART COLLECTION',
    editor: 'CLIPART STUDIO',
    page: 'JOTCLIPART',
  };
  const images = spec.images
    .map((_, i) => {
      const n = spec.images.length,
        x = n === 1 ? 638 : 655 + (i % 2) * 218,
        y = n === 1 ? 80 : 160 + i * 94,
        width = n === 1 ? 500 : 305,
        height = n === 1 ? 470 : 305;
      return `<image x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" xlink:href="https://jotclipart.com/__og-resource/image-${i}.png"/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#FFFFFF"/><rect x="615" y="54" width="539" height="521" rx="30" fill="#FFFFFF" stroke="#D8F3DC" stroke-width="2"/><path d="M56 156H530" stroke="#52B788" stroke-width="4"/><image x="44" y="31" width="103" height="103" xlink:href="https://jotclipart.com/__og-resource/logo.png"/><text x="162" y="96" font-family="Inter" font-weight="700" font-size="48" fill="#123524">JotClipart</text><text x="56" y="204" font-family="Inter" font-size="17" letter-spacing="2" fill="#216E4E">${labels[spec.kind]}</text>${title.lines.map((line, i) => `<text x="56" y="${260 + i * title.lineHeight}" font-family="Inter" font-weight="700" font-size="${title.size}" fill="#123524">${xml(line)}</text>`).join('')}<text x="56" y="579" font-family="Inter" font-size="20" fill="#216E4E">jotclipart.com</text>${images}</svg>`;
}
async function boundedBody(response, expected) {
  must(
    response.status === 200 &&
      response.body &&
      response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === expected.mime,
    'OG_MEDIA_RESPONSE',
  );
  if (response.url) must(new URL(response.url).origin === ASSETS, 'OG_MEDIA_ORIGIN');
  const length = response.headers.get('content-length');
  if (length !== null) must(Number(length) === expected.bytes, 'OG_MEDIA_BYTE_COUNT');
  const reader = response.body.getReader(),
    chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      must(total <= expected.bytes && total <= OG_LIMITS.imageBytes, 'OG_MEDIA_BYTE_BOUND');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  must(total === expected.bytes, 'OG_MEDIA_BYTE_COUNT');
  const bytes = joined(chunks);
  must((await ogSHA256(bytes)) === expected.sha256, 'OG_MEDIA_SHA256');
  imageDimensions(bytes, expected.mime);
  return bytes;
}
let initialization;
async function initialize(resvgModule, webpModule) {
  must(
    resvgModule instanceof WebAssembly.Module && webpModule instanceof WebAssembly.Module,
    'OG_PRECOMPILED_WASM_REQUIRED',
  );
  if (!initialization) {
    if (!globalThis.ImageData)
      globalThis.ImageData = class ImageData {
        constructor(data, width, height) {
          this.data = data;
          this.width = width;
          this.height = height;
        }
      };
    initialization = Promise.all([initWasm(resvgModule), initWebP(webpModule)]);
  }
  await initialization;
}

/**
 * No R2 writes, arbitrary SVG, URL proxy, user-project reads or paid inference.
 * Resources are build-pinned bytes. The caller owns authenticated ID resolution,
 * selected snapshot consistency, HTTP path matching and the edge Cache API.
 */
export async function createOgRenderer({
  resvgModule,
  webpModule,
  fonts,
  logo,
  identity,
  fetcher = fetch,
  timeoutMs = 10000,
}) {
  const pins = renderIdentity(identity);
  must(
    Array.isArray(fonts) && fonts.length === 2 && logo instanceof Uint8Array,
    'OG_RESOURCES_REQUIRED',
  );
  must((await ogSHA256(logo)) === pins.logoSHA256, 'OG_LOGO_SHA256');
  imageDimensions(logo, 'image/png');
  for (let i = 0; i < fonts.length; i++)
    must((await ogSHA256(fonts[i])) === pins.fontSHA256[i], 'OG_FONT_SHA256');
  logo = logo.slice();
  const normalizedFonts = fonts.map(ogFontSFNT),
    measure = fontMetrics(normalizedFonts[1]);
  await initialize(resvgModule, webpModule);
  let tail = Promise.resolve(),
    queued = 0;
  const flights = new Map();
  async function renderOne(spec) {
    const title = wrapOgTitle(spec.title, measure),
      images = new Map([['https://jotclipart.com/__og-resource/logo.png', logo]]);
    for (let i = 0; i < spec.images.length; i++) {
      const asset = spec.images[i],
        url = ASSETS + '/' + asset.objectKey.split('/').map(encodeURIComponent).join('/');
      const response = await fetcher(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Origin: ORIGIN },
      });
      const source = await boundedBody(response, asset);
      let png = source;
      if (asset.mime === 'image/webp') {
        const expected = imageDimensions(source, asset.mime),
          rgba = await decodeWebP(
            source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength),
          );
        must(
          rgba.width === expected.width &&
            rgba.height === expected.height &&
            rgba.data.length === rgba.width * rgba.height * 4,
          'OG_DECODED_PIXEL_MISMATCH',
        );
        png = encodeOgPNG(rasterBound(rgba));
      }
      images.set(`https://jotclipart.com/__og-resource/image-${i}.png`, png);
    }
    const engine = new Resvg(composeSVG(spec, title), {
      font: { fontBuffers: normalizedFonts, defaultFontFamily: 'Inter' },
      fitTo: { mode: 'original' },
    });
    let rendered;
    try {
      const unresolved = engine.imagesToResolve();
      must(
        unresolved.length === images.size && new Set(unresolved).size === images.size,
        'OG_RENDER_IMAGE_SET',
      );
      for (const href of unresolved) {
        must(images.has(href), 'OG_RENDER_EXTERNAL_IMAGE');
        engine.resolveImage(href, images.get(href));
      }
      rendered = engine.render();
      must(rendered.width === OG_WIDTH && rendered.height === OG_HEIGHT, 'OG_OUTPUT_DIMENSIONS');
      const png = rendered.asPng().slice();
      must(png.length > 100 && png.length <= OG_LIMITS.outputBytes, 'OG_OUTPUT_BYTES');
      const sha256 = await ogSHA256(png);
      return {
        png,
        width: OG_WIDTH,
        height: OG_HEIGHT,
        sha256,
        etag: `"${sha256}"`,
        descriptor: spec,
        textLines: title.lines.length,
      };
    } finally {
      rendered?.free();
      engine.free();
    }
  }
  return Object.freeze({
    identity: pins,
    descriptor: (source) => prepareOgDescriptor(source, pins),
    async render(source) {
      const spec = await prepareOgDescriptor(source, pins);
      if (flights.has(spec.digest)) return flights.get(spec.digest);
      must(queued < OG_LIMITS.queue, 'OG_RENDER_QUEUE_FULL');
      queued++;
      const task = tail.then(() => renderOne(spec));
      tail = task.catch(() => {});
      flights.set(spec.digest, task);
      try {
        return await task;
      } finally {
        queued--;
        flights.delete(spec.digest);
      }
    },
  });
}
export function ogImageResponse(result, { head = false } = {}) {
  return new Response(head ? null : result.png, {
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(result.png.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: result.etag,
      'X-Content-Type-Options': 'nosniff',
      'X-JotClipart-OG': result.descriptor.digest,
    },
  });
}
