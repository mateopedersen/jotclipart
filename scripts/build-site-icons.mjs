import sharp from 'sharp';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const siteIconFiles = [
  'favicon.svg',
  'favicon-96.png',
  'favicon-192.png',
  'apple-touch-icon.png',
  'favicon.ico',
];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const siteIconSource = 'public/brand/jotclipart-mark-3d-v2.png';
export async function buildSiteIcons(root = resolve(import.meta.dirname, '..')) {
  // One reviewed raster mark feeds every size; the legacy flat SVG is never an input.
  const source = readFileSync(join(root, siteIconSource));
  if (
    source.length > 8 * 1024 * 1024 ||
    !source.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw Error('The reviewed icon source must be a bounded PNG');
  const info = await sharp(source, { limitInputPixels: 4096 * 4096 }).metadata();
  if (
    info.format !== 'png' ||
    (info.pages ?? 1) !== 1 ||
    !info.hasAlpha ||
    info.width < 192 ||
    info.height < 192 ||
    info.width > 4096 ||
    info.height > 4096
  )
    throw Error('Review the transparent raster mark and its frame before rebuilding icons');
  const framed = await sharp(source)
    .toColourspace('srgb')
    .ensureAlpha()
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
  const alpha = (await sharp(framed).stats()).channels[3];
  if (!alpha || alpha.min !== 0 || alpha.max === 0)
    throw Error('The icon source must contain visible artwork and transparent background');
  const square = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><title>JotClipart</title><image width="48" height="48" href="data:image/png;base64,${framed.toString('base64')}"/></svg>\n`,
  );
  const outputs = new Map([['favicon.svg', square]]);
  for (const [file, size] of [
    ['favicon-96.png', 96],
    ['favicon-192.png', 192],
    ['apple-touch-icon.png', 180],
  ])
    outputs.set(file, await sharp(framed).resize(size, size).png().toBuffer());
  const icoImages = await Promise.all(
    [16, 32, 48].map((size) => sharp(framed).resize(size, size).png().toBuffer()),
  );
  const header = Buffer.alloc(6 + icoImages.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(icoImages.length, 4);
  let offset = header.length;
  icoImages.forEach((bytes, index) => {
    const size = [16, 32, 48][index],
      entry = 6 + index * 16;
    header[entry] = size;
    header[entry + 1] = size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(bytes.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += bytes.length;
  });
  outputs.set('favicon.ico', Buffer.concat([header, ...icoImages]));
  for (const [name, bytes] of outputs) {
    const file = join(root, 'public', name);
    if (!existsSync(file) || sha(readFileSync(file)) !== sha(bytes)) writeFileSync(file, bytes);
  }
  return {
    source: siteIconSource,
    sourceSha256: sha(source),
    sourceDimensions: { width: info.width, height: info.height },
    files: [...outputs].map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: sha(bytes) })),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(JSON.stringify(await buildSiteIcons(), null, 2));
