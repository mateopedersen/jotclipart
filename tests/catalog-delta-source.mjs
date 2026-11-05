import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createReviewedDeltaValidators } from '../scripts/catalog-snapshot/validate-delta-source.mjs';
import { assertCollectionVisitorCopy } from '../scripts/catalog-snapshot/collection-visitor-copy.mjs';
const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/catalog-delta-source.json', import.meta.url)),
  ),
  canonical = (x) =>
    Array.isArray(x)
      ? x.map(canonical)
      : x && typeof x === 'object'
        ? Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((k) => [k, canonical(x[k])]),
          )
        : x,
  hash = (x) =>
    createHash('sha256')
      .update(JSON.stringify(canonical(x)))
      .digest('hex');
function inputs(old = fixture.record) {
  const f = structuredClone(fixture),
    row = {
      id: f.raw.id,
      raw: f.raw,
      review: f.review,
      expectedOldPublicSHA256: old ? hash(old) : null,
      monochromeReceipt: {
        sourceSHA256: f.raw.files.thumb.sha256,
        monochrome: f.record.monochrome,
        kind: f.record.monochromeKind,
        receiptSHA256: '1'.repeat(64),
      },
      pairReceipt: {
        status: 'MATCHED_SOURCE_PIXELS',
        imageSHA256: f.raw.files.webp.sha256,
        pdfSHA256: f.raw.files.pdf.sha256,
        receiptSHA256: '2'.repeat(64),
      },
    },
    options = {
      artworkRows: [row],
      topicRows: [],
      incomingMediaManifest: f.media,
      mediaReceiptSHA256: '3'.repeat(64),
    };
  return {
    ...f,
    row,
    options,
    change: { id: f.raw.id, expectedPublicSHA256: old ? hash(old) : null, record: f.record },
    oldRecord: old,
  };
}
test('canonical approved source preserves original URLs and all public fields', async () => {
  for (const old of [fixture.record, null]) {
    const f = inputs(old),
      v = createReviewedDeltaValidators(f.options),
      r = await v.validateSourceChange(f);
    assert.equal(r.newPublicSHA256, hash(f.record));
    assert.equal(r.imageSHA256, f.raw.files.webp.sha256);
    assert.equal(r.oldPublicSHA256, old ? hash(old) : null);
  }
});
test('topic imports reject editor notes and file instructions before reading artwork', async () => {
  const { options } = inputs();
  const slug = 'tupolev-aircraft';
  const good = {
    intro: 'Tupolev aircraft clipart includes Tu 144 delta wings and Tu 154 airliners.',
    paragraphs: [
      'Compare the pointed nose of the Tu 144 with the rear engines on the Tu 154.',
      'The {{artworkCount}} aircraft drawings include profiles for an aviation timeline.',
    ],
  };
  assert.doesNotThrow(() => assertCollectionVisitorCopy(slug, good));
  for (const addition of [
    'The copy highlights the cockpit glazing.',
    'Similar aircraft remain at family level.',
    'Download the transparent WebP for a digital layout.',
  ]) {
    const editorial = { ...good, paragraphs: [good.paragraphs[0], good.paragraphs[1] + ' ' + addition] };
    const validators = createReviewedDeltaValidators({ ...options, topicRows: [{ slug, editorial }] });
    await assert.rejects(
      () => validators.validateSourceTopic({ change: { slug, record: { editorial } } }),
      /replace editorial notes or download instructions/,
    );
  }
  for (const paragraphs of [
    [...good.paragraphs].reverse(),
    [good.paragraphs[0], good.paragraphs[1].repeat(2)],
  ]) {
    assert.throws(() => assertCollectionVisitorCopy(slug, { ...good, paragraphs }), /one live count/);
  }
});
test('copy, source pixels, product facts and media cannot change behind a retained review', async () => {
  for (const mutate of [
    (f) => (f.record.description += ' An unrelated addition.'),
    (f) => f.record.width++,
    (f) => (f.record.style = 'Watercolor'),
    (f) => (f.record.productIdentity = { model: 'invented' }),
    (f) => (f.record.originalThumb = f.record.webp),
    (f) => (f.raw.files.webp.sha256 = 'f'.repeat(64)),
    (f) => (f.row.review.observations = []),
    (f) => (f.row.monochromeReceipt.sourceSHA256 = 'f'.repeat(64)),
  ]) {
    const f = inputs();
    mutate(f);
    await assert.rejects(() => createReviewedDeltaValidators(f.options).validateSourceChange(f));
  }
});
test('new formats need actual full media and matching pair evidence; withdrawals need explicit scope', async () => {
  const f = inputs(null);
  f.row.pairReceipt.pdfSHA256 = 'f'.repeat(64);
  await assert.rejects(
    () => createReviewedDeltaValidators(f.options).validateSourceChange(f),
    /composition/,
  );
  const g = inputs(null);
  g.options.incomingMediaManifest.files = [];
  g.options.incomingMediaManifest.bytes = 0;
  await assert.rejects(
    () => createReviewedDeltaValidators(g.options).validateSourceChange(g),
    /media proof/,
  );
  const h = inputs();
  h.change.record = null;
  await assert.rejects(
    () => createReviewedDeltaValidators(h.options).validateSourceChange(h),
    /withdrawal/,
  );
  h.row.decision = 'OWNER_AUTHORIZED_WITHDRAWAL';
  h.row.reason = 'Specific owner withdrawal for this test fixture.';
  h.row.ownerApprovalReceiptSHA256 = '4'.repeat(64);
  assert.equal(
    (await createReviewedDeltaValidators(h.options).validateSourceChange(h)).newPublicSHA256,
    null,
  );
});
