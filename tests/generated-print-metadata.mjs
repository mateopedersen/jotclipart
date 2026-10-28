import test from 'node:test';
import assert from 'node:assert/strict';
import { generatedPrintMetadata } from '../scripts/generated-print-metadata.mjs';
import { loadTypescript } from './helpers/typescript.mjs';
const { artworkDetails } = await loadTypescript('src/lib/artwork-details.ts');

const fixture = () => ({
  width: 1312,
  height: 1199,
  pdfWidth: 950,
  pdfHeight: 868,
  pdfAt300Ppi: true,
  image: { width: 950, height: 868, components: 4 },
});

test('public facts use the smaller verified PDF page while retaining native image dimensions', () => {
  const row = fixture();
  const metadata = generatedPrintMetadata(row);
  const facts = artworkDetails({ id: 'dinner-example', style: 'Cartoon', ...row, ...metadata });
  assert.equal(facts.printInches, '3.17 × 2.89 in');
  assert.equal(facts.printPixels, '950 × 868 px');
  assert.equal(facts.pdfPpi, 300);
  assert.equal(row.width, 1312);
  assert.equal(row.height, 1199);
});

test('native-size exports retain the verified portrait PDF dimensions', () => {
  const row = {
    width: 900,
    height: 1200,
    pdfAt300Ppi: true,
    image: { width: 900, height: 1200, components: 4 },
  };
  const metadata = generatedPrintMetadata(row);
  assert.equal(metadata.pdfPage, '3.000 × 4.000 in');
  assert.deepEqual(metadata.pdfPrint.pagePoints, [216, 288]);
});

test('unverified resolution, upscaled or mismatched PDF dimensions and RGB reports fail closed', () => {
  for (const change of [
    { pdfAt300Ppi: false },
    { pdfWidth: 1400 },
    { pdfHeight: 0 },
    { image: { width: 949, height: 868, components: 4 } },
    { image: { width: 950, height: 868, components: 3 } },
  ])
    assert.throws(() => generatedPrintMetadata({ ...fixture(), ...change }));
});
