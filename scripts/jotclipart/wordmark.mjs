import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

export const wordmarkSource = 'public/brand/jotclipart-logo-3d.webp';
export const wordmarkSourceSHA256 =
  '69d06e13609c6a23e0338c9a7761a7291a0d3fc4fed60151aaa9ff7824d2c530';
export const wordmarkWidths = [320, 480];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Presentation-only sizes of the reviewed logo; never touches catalog media. */
export async function buildWordmark(root = process.cwd(), { check = false } = {}) {
  const source = readFileSync(join(root, wordmarkSource));
  assert.equal(sha(source), wordmarkSourceSHA256, 'Reviewed wordmark changed');
  const info = await sharp(source).metadata();
  assert.equal(info.format, 'webp');
  assert.equal(info.width, 1200);
  assert.equal(info.height, 314);
  assert.equal(info.hasAlpha, true);
  const files = [];
  for (const width of wordmarkWidths) {
    const bytes = await sharp(source)
      .resize({ width })
      .webp({ lossless: true, effort: 6, exact: true })
      .toBuffer();
    const file = `public/brand/jotclipart-logo-3d-${width}.webp`;
    assert(bytes.length < source.length, 'Logo presentation size must save bytes');
    if (check) assert(readFileSync(join(root, file)).equals(bytes), 'Wordmark derivative changed');
    else writeFileSync(join(root, file), bytes);
    const meta = await sharp(bytes).metadata();
    files.push({
      file,
      width: meta.width,
      height: meta.height,
      bytes: bytes.length,
      sha256: sha(bytes),
    });
  }
  assert(
    readFileSync(join(root, wordmarkSource)).equals(source),
    'Original logo must remain unchanged',
  );
  return {
    source: wordmarkSource,
    sourceSHA256: sha(source),
    sourceBytes: source.length,
    files,
    catalogMediaChanged: 0,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(
    JSON.stringify(await buildWordmark(process.cwd(), { check: process.argv.includes('--check') })),
  );
