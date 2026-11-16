import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import sharp from 'sharp';
import {
  prepareOgDescriptor,
  encodeOgPNG,
  imageDimensions,
  ogFontSFNT,
  createOgRenderer,
  ogSHA256,
  ogImageResponse,
  wrapOgTitle,
} from '../server/jotclipart/og-image.mjs';

const a = 'a'.repeat(64),
  b = 'b'.repeat(64);
const identity = { rendererSHA256: a, logoSHA256: b, fontSHA256: [a, b] };
const pixels = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 128]);
const png = encodeOgPNG({ width: 2, height: 2, data: pixels });
const asset = {
  objectKey: 'source/specific-art.webp.png',
  mime: 'image/png',
  bytes: png.length,
  sha256: await ogSHA256(png),
};
const source = {
  kind: 'art',
  id: 'specific-art',
  title: 'Free Specific Art Clipart',
  canonicalPath: '/art/specific-art/',
  sourceSHA256: a,
  sourceRoot: b,
  images: [asset],
};

test('PNG conversion preserves exact RGBA including transparency and CRC-readable chunks', async () => {
  const decoded = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(decoded.info.width, 2);
  assert.equal(decoded.info.height, 2);
  assert.deepEqual(decoded.data, Buffer.from(pixels));
  assert.deepEqual(imageDimensions(png, 'image/png'), { width: 2, height: 2 });
});
test('descriptor binds source, title, object bytes/hash, font/logo/renderer and canonical identity', async () => {
  const first = await prepareOgDescriptor(source, identity),
    again = await prepareOgDescriptor(source, identity);
  assert.equal(first.url, again.url);
  assert.match(
    first.url,
    /^https:\/\/jotclipart.com\/og\/catalog\/art\/specific-art\/[a-f0-9]{64}\.png$/,
  );
  for (const changed of [
    { ...source, id: 'another-art' },
    { ...source, title: 'Free Changed Subject' },
    { ...source, sourceSHA256: b },
    { ...source, images: [{ ...asset, sha256: b }] },
    { ...source, canonicalPath: '/art/new-path/' },
  ])
    assert.notEqual((await prepareOgDescriptor(changed, identity)).digest, first.digest);
  for (const changed of [
    { ...identity, rendererSHA256: b },
    { ...identity, logoSHA256: a },
    { ...identity, fontSHA256: [b, a] },
  ])
    assert.notEqual((await prepareOgDescriptor(source, changed)).digest, first.digest);
  const unrelatedImport = await prepareOgDescriptor({ ...source, sourceRoot: a }, identity);
  assert.equal(unrelatedImport.digest, first.digest);
  assert.equal(unrelatedImport.sourceRoot, a);
  assert(Object.isFrozen(first.images) && Object.isFrozen(first.images[0]));
});
test('arbitrary source URL, foreign canonical, path escape and private-share kind are forbidden', async () => {
  for (const changed of [
    { ...source, images: [{ ...asset, url: 'https://attacker.invalid/pixel' }] },
    { ...source, images: [{ ...asset, objectKey: '../secret.png' }] },
    { ...source, images: [{ ...asset, objectKey: '/absolute.png' }] },
    { ...source, canonicalPath: 'https://attacker.invalid/' },
    { ...source, canonicalPath: '/art/specific-art/?private=secret' },
    { ...source, kind: 'share' },
  ])
    await assert.rejects(prepareOgDescriptor(changed, identity));
});
test('Free and subject-copy constraints are separate from utility labels', async () => {
  for (const title of [
    'Specific Art',
    'Free Free Specific Art',
    'Free Specific Clipart Clipart',
    'Free UltraClipart Subject',
  ])
    await assert.rejects(prepareOgDescriptor({ ...source, title }, identity));
  assert.equal(
    (
      await prepareOgDescriptor(
        {
          ...source,
          kind: 'page',
          id: 'privacy',
          title: 'Privacy Policy',
          canonicalPath: '/privacy/',
          images: [],
        },
        identity,
      )
    ).title,
    'Privacy Policy',
  );
});
test('oversize/missing/mismatched media declarations fail before any fetch', async () => {
  for (const changed of [
    { ...asset, bytes: 1024 * 1024 + 1 },
    { ...asset, bytes: 0 },
    { ...asset, mime: 'image/svg+xml' },
    { ...asset, sha256: 'not-a-checksum' },
  ])
    await assert.rejects(prepareOgDescriptor({ ...source, images: [changed] }, identity));
  await assert.rejects(prepareOgDescriptor({ ...source, images: [] }, identity));
  await assert.rejects(prepareOgDescriptor({ ...source, images: [asset, asset] }, identity));
});
test('pixel bomb and wrong PNG/WebP magic are rejected before decoding', () => {
  const bomb = png.slice();
  new DataView(bomb.buffer).setUint32(16, 0x7fffffff);
  assert.throws(() => imageDimensions(bomb, 'image/png'), /OG_PIXEL_BOUND/);
  assert.throws(
    () => imageDimensions(new TextEncoder().encode('<html>error</html>'), 'image/png'),
    /OG_IMAGE_MAGIC/,
  );
  assert.throws(() => imageDimensions(png, 'image/webp'));
});
test('font re-containerization preserves all outlines/metrics tables and full sfnt checksum', async () => {
  const woff = new Uint8Array(
    await readFile(
      new URL(
        '../node_modules/@fontsource/inter/files/inter-latin-700-normal.woff',
        import.meta.url,
      ),
    ),
  );
  const sfnt = ogFontSFNT(woff),
    a = new DataView(woff.buffer, woff.byteOffset, woff.byteLength),
    z = new DataView(sfnt.buffer);
  assert.equal(z.getUint32(0), 0x00010000);
  let sum = 0;
  for (let i = 0; i < sfnt.length; i += 4) sum = (sum + z.getUint32(i)) >>> 0;
  assert.equal(sum, 0xb1b0afba);
  for (let i = 0; i < a.getUint16(12); i++) {
    const at = 44 + i * 20,
      tag = Buffer.from(woff.subarray(at, at + 4)).toString(),
      raw = woff.subarray(a.getUint32(at + 4), a.getUint32(at + 4) + a.getUint32(at + 8));
    const original = a.getUint32(at + 8) === a.getUint32(at + 12) ? raw : inflateSync(raw);
    const offset = z.getUint32(12 + i * 16 + 8),
      length = z.getUint32(12 + i * 16 + 12),
      actual = sfnt.subarray(offset, offset + length);
    assert.equal(length, original.length);
    if (tag === 'head') {
      assert.deepEqual(Buffer.from(actual.subarray(0, 8)), Buffer.from(original.subarray(0, 8)));
      assert.deepEqual(Buffer.from(actual.subarray(12)), Buffer.from(original.subarray(12)));
    } else assert.deepEqual(Buffer.from(actual), Buffer.from(original));
  }
  const bad = woff.slice();
  bad[0] = 0;
  assert.throws(() => ogFontSFNT(bad), /INVALID_OG_FONT/);
});
test('title layout wraps long text without dropping or inventing a title', () => {
  const input =
    'Free Long Subject Name With Accurate Source Bound Details And Meaningful Model Numbers F-150';
  const result = wrapOgTitle(input, (s, size) => [...s].length * size * 0.55);
  assert.equal(result.lines.join(' '), input);
  assert(result.lines.every((s) => s.length * result.size * 0.55 <= 470));
  assert(result.lines.length * result.lineHeight <= 310);
});

let fixture;
async function setup() {
  if (fixture) return fixture;
  const fonts = await Promise.all(
    [400, 700].map(
      async (n) =>
        new Uint8Array(
          await readFile(
            new URL(
              `../node_modules/@fontsource/inter/files/inter-latin-${n}-normal.woff`,
              import.meta.url,
            ),
          ),
        ),
    ),
  );
  const logo = new Uint8Array(
    await readFile(new URL('../public/brand/jotclipart-mark-3d.png', import.meta.url)),
  );
  const pins = {
    rendererSHA256: await ogSHA256(
      await readFile(new URL('../server/jotclipart/og-image.mjs', import.meta.url)),
    ),
    logoSHA256: await ogSHA256(logo),
    fontSHA256: await Promise.all(fonts.map(ogSHA256)),
  };
  const resvgModule = await WebAssembly.compile(
    await readFile(new URL('../node_modules/@resvg/resvg-wasm/index_bg.wasm', import.meta.url)),
  );
  const webpModule = await WebAssembly.compile(
    await readFile(
      new URL('../node_modules/@jsquash/webp/codec/dec/webp_dec.wasm', import.meta.url),
    ),
  );
  const state = { mode: 'ok', calls: 0 };
  const renderer = await createOgRenderer({
    resvgModule,
    webpModule,
    fonts,
    logo,
    identity: pins,
    fetcher: async (url, options) => {
      state.calls++;
      assert.equal(url, 'https://assets.jotclipart.com/source/specific-art.webp.png');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers.Origin, 'https://jotclipart.com');
      if (state.mode === 'redirect')
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://assets.ultraclipart.com/old.png' },
        });
      if (state.mode === 'html')
        return new Response(png, { headers: { 'Content-Type': 'text/html' } });
      if (state.mode === 'wrongLength')
        return new Response(png, {
          headers: { 'Content-Type': 'image/png', 'Content-Length': '123456' },
        });
      const body =
        state.mode === 'sha'
          ? png.map((v, i) => (i === png.length - 1 ? v ^ 1 : v))
          : state.mode === 'truncated'
            ? png.subarray(0, -1)
            : png;
      return new Response(body, { headers: { 'Content-Type': 'image/png' } });
    },
  });
  fixture = { renderer, state, pins, fonts, logo, resvgModule, webpModule };
  return fixture;
}
test('real Wasm renders a nonempty deterministic new 1200x630 PNG with visible title/logo/art', async () => {
  const f = await setup();
  f.state.mode = 'ok';
  const first = await f.renderer.render(source),
    second = await f.renderer.render(source);
  assert.equal(first.sha256, second.sha256);
  assert.notEqual(first.sha256, asset.sha256);
  const decoded = await sharp(first.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(decoded.info.width, 1200);
  assert.equal(decoded.info.height, 630);
  assert.deepEqual([...decoded.data.subarray(0, 4)], [255, 255, 255, 255]);
  for (const box of [
    { left: 40, top: 20, width: 520, height: 120 },
    { left: 56, top: 220, width: 470, height: 180 },
    { left: 650, top: 90, width: 480, height: 440 },
  ]) {
    const stats = await sharp(first.png).extract(box).stats();
    assert(
      stats.channels.slice(0, 3).some((c) => c.min < 200),
      'silently empty logo, title or source-art panel',
    );
  }
  const response = ogImageResponse(first),
    head = ogImageResponse(first, { head: true });
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('etag'), first.etag);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(await head.text(), '');
});
test('multiple requests for one immutable identity share one render/fetch', async () => {
  const f = await setup();
  f.state.mode = 'ok';
  const before = f.state.calls;
  const results = await Promise.all([
    f.renderer.render(source),
    f.renderer.render(source),
    f.renderer.render(source),
  ]);
  assert.equal(f.state.calls - before, 1);
  assert.equal(new Set(results.map((r) => r.sha256)).size, 1);
});
for (const [mode, error] of [
  ['redirect', 'OG_MEDIA_RESPONSE'],
  ['html', 'OG_MEDIA_RESPONSE'],
  ['wrongLength', 'OG_MEDIA_BYTE_COUNT'],
  ['sha', 'OG_MEDIA_SHA256'],
  ['truncated', 'OG_MEDIA_BYTE_COUNT'],
])
  test(`media ${mode} fails closed without original-host fallback`, async () => {
    const f = await setup();
    f.state.mode = mode;
    await assert.rejects(f.renderer.render(source), new RegExp(error));
    f.state.mode = 'ok';
  });
test('changed font/logo bytes and runtime-compiled-Wasm inputs are rejected', async () => {
  const f = await setup();
  await assert.rejects(
    createOgRenderer({ ...f, identity: f.pins, logo: f.logo.map((v, i) => (i ? v : v ^ 1)) }),
    /OG_LOGO_SHA256/,
  );
  await assert.rejects(
    createOgRenderer({
      ...f,
      identity: f.pins,
      fonts: [f.fonts[0].map((v, i) => (i ? v : v ^ 1)), f.fonts[1]],
    }),
    /OG_FONT_SHA256/,
  );
  await assert.rejects(
    createOgRenderer({ ...f, identity: f.pins, resvgModule: new Uint8Array() }),
    /OG_PRECOMPILED_WASM_REQUIRED/,
  );
});
test('unsupported glyphs fail visibly instead of silently disappearing from OG', async () => {
  const f = await setup();
  await assert.rejects(
    f.renderer.render({ ...source, title: 'Free Source 🦋' }),
    /OG_FONT_GLYPH_UNAVAILABLE/,
  );
});
