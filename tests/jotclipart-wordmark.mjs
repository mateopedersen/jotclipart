import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { buildWordmark, wordmarkSource, wordmarkWidths } from '../scripts/jotclipart/wordmark.mjs';

test('smaller transparent logo files preserve the exact reviewed resized pixels and original source', async () => {
  const source = readFileSync(wordmarkSource),
    report = await buildWordmark(process.cwd(), { check: true });
  assert.equal(report.catalogMediaChanged, 0);
  assert.equal(report.files.length, 2);
  for (const [i, item] of report.files.entries()) {
    assert.equal(item.width, wordmarkWidths[i]);
    assert(item.bytes < report.sourceBytes * 0.75);
    const reference = await sharp(source)
      .resize({ width: item.width })
      .ensureAlpha()
      .raw()
      .toBuffer();
    const actual = await sharp(readFileSync(item.file)).ensureAlpha().raw().toBuffer();
    assert(actual.equals(reference), 'Lossless resized logo pixels changed');
    const m = await sharp(readFileSync(item.file)).metadata();
    assert.equal(m.hasAlpha, true);
  }
  assert(readFileSync(wordmarkSource).equals(source));
});
test('changed source or missing/mutated derivative cannot silently pass the build gate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jotclipart-wordmark-'));
  try {
    mkdirSync(join(root, 'public/brand'), { recursive: true });
    writeFileSync(join(root, wordmarkSource), readFileSync(wordmarkSource));
    await assert.rejects(buildWordmark(root, { check: true }));
    const report = await buildWordmark(root);
    writeFileSync(join(root, report.files[0].file), Buffer.from('not a logo'));
    await assert.rejects(buildWordmark(root, { check: true }), /derivative changed/);
    writeFileSync(join(root, wordmarkSource), Buffer.from('unreviewed replacement'));
    await assert.rejects(buildWordmark(root), /Reviewed wordmark changed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
