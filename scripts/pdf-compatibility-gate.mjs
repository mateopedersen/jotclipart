// Portable admission guard for the confirmed native-reader failure. This is
// structural validation, not a claim that an unseen PDF has been visually read.
import { PDFDocument, PDFName, PDFArray, PDFRawStream, PDFDict } from 'pdf-lib';

export async function assertNoCMYKJPX(bytes) {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  if (!document.getPageCount()) throw Error('PDF contains no pages');
  const images = new Set(),
    seenResources = new Set(),
    lookup = (value) => document.context.lookup(value);
  const colorIn = (value, resources, depth = 0) => {
    const color = lookup(value);
    if (depth > 8) return color;
    if (
      color instanceof PDFName &&
      !['/DeviceRGB', '/DeviceCMYK', '/DeviceGray'].includes(color.toString())
    ) {
      const aliases = lookup(resources.get(PDFName.of('ColorSpace'))),
        next = aliases instanceof PDFDict ? aliases.get(color) : undefined;
      if (next) return colorIn(next, resources, depth + 1);
    }
    return color;
  };
  function visit(resources) {
    if (!(resources instanceof PDFDict) || seenResources.has(resources)) return;
    seenResources.add(resources);
    const objects = lookup(resources.get(PDFName.of('XObject')));
    if (!(objects instanceof PDFDict)) return;
    for (const [name, reference] of objects.entries()) {
      const object = lookup(reference);
      if (!(object instanceof PDFRawStream)) continue;
      const subtype = object.dict.get(PDFName.of('Subtype'))?.toString();
      if (subtype === '/Form') {
        visit(lookup(object.dict.get(PDFName.of('Resources'))) ?? resources);
        continue;
      }
      if (subtype !== '/Image') continue;
      images.add(object);
      const filter = document.context.lookup(object.dict.get(PDFName.of('Filter')));
      const filters =
        filter instanceof PDFArray
          ? filter.asArray().map((v) => document.context.lookup(v)?.toString())
          : [filter?.toString()];
      if (!filters.includes('/JPXDecode')) continue;
      const color = colorIn(object.dict.get(PDFName.of('ColorSpace')), resources);
      let fourComponentCMYK = color?.toString() === '/DeviceCMYK';
      if (
        color instanceof PDFArray &&
        document.context.lookup(color.get(0))?.toString() === '/ICCBased'
      ) {
        const profile = document.context.lookup(color.get(1));
        fourComponentCMYK =
          profile instanceof PDFRawStream &&
          document.context.lookup(profile.dict.get(PDFName.of('N')))?.toString() === '4';
      }
      if (fourComponentCMYK)
        throw Error(
          'CMYK JPX image ' +
            name.toString() +
            ' reproduces blank PDFs in macOS; retain the original and repair/verify a separately hashed compatible PDF before publication',
        );
    }
  }
  for (const page of document.getPages()) visit(page.node.Resources());
  return {
    status: 'PDF_SYNTAX_AND_KNOWN_CMYK_JPX_GUARD_PASSED',
    pages: document.getPageCount(),
    images: images.size,
    visualReview: false,
  };
}
