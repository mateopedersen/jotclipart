import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName } from 'pdf-lib';
import { assertNoCMYKJPX } from '../scripts/pdf-compatibility-gate.mjs';
test('a real vector PDF passes structural admission without pretending to be a visual review', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([72, 72]).drawRectangle({ x: 10, y: 10, width: 20, height: 20 });
  const result = await assertNoCMYKJPX(await doc.save());
  assert.equal(result.pages, 1);
  assert.equal(result.visualReview, false);
});
test('direct and ICC four-component JPX images are rejected, including indirect and filter-array forms', async () => {
  for (const icc of [false, true])
    for (const filterArray of [false, true]) {
      const doc = await PDFDocument.create();
      const page = doc.addPage([72, 72]),
        context = doc.context;
      const profile = context.register(context.stream(new Uint8Array([0, 1, 2]), { N: 4 }));
      const color = icc ? context.obj([PDFName.of('ICCBased'), profile]) : PDFName.of('DeviceCMYK');
      // Private parser fixtures only, never purported artwork or JPEG2000 payloads.
      const ref = context.register(
        context.stream(new Uint8Array([255, 79, 255, 81]), {
          Type: 'XObject',
          Subtype: 'Image',
          Width: 1,
          Height: 1,
          BitsPerComponent: 8,
          ColorSpace: color,
          Filter: filterArray ? context.obj([PDFName.of('JPXDecode')]) : PDFName.of('JPXDecode'),
        }),
      );
      page.node.set(PDFName.of('Resources'), context.obj({ XObject: { Artwork: ref } }));
      const bytes = await doc.save();
      await assert.rejects(() => assertNoCMYKJPX(bytes), /CMYK JPX/);
    }
});
test('non-PDF bytes cannot enter as a PDF just because their byte hash matches', async () => {
  await assert.rejects(() => assertNoCMYKJPX(Buffer.from('not a PDF')));
});
