import assert from 'node:assert/strict';

/** Bind public print facts to the preflighted PDF raster, never the larger WebP. */
export function generatedPrintMetadata(row) {
  const width = row.pdfWidth ?? row.width;
  const height = row.pdfHeight ?? row.height;
  assert.equal(row.pdfAt300Ppi, true, 'An explicit verified print resolution is required');
  assert.ok(Number.isInteger(width) && width > 0 && width <= row.width, 'Invalid PDF width');
  assert.ok(Number.isInteger(height) && height > 0 && height <= row.height, 'Invalid PDF height');
  assert.equal(row.image?.width, width, 'PDF image width differs from preflight');
  assert.equal(row.image?.height, height, 'PDF image height differs from preflight');
  assert.equal(row.image?.components, 4, 'The preflighted print image must be CMYK');
  const ppi = 300;
  const pagePoints = [width, height].map((px) => (px * 72) / ppi);
  return {
    pdfPage: pagePoints.map((points) => (points / 72).toFixed(3)).join(' × ') + ' in',
    pdfPrint: { width, height, ppi, pagePoints },
  };
}
