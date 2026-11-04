import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewedImportCatalog, readReviewedImportCatalog } from '../scripts/reviewed-imports.mjs';
import {
  collectionSourceSignature,
  requiredCollectionIntroductions,
  readRequiredCollectionIntroductions,
  readCollectionAudit,
  collectionParagraphSignature,
  collectionParagraphReviewSignature,
} from '../scripts/collection-editorial.mjs';
const read = (p) => JSON.parse(readFileSync(new URL('../' + p, import.meta.url)));
const catalog = read('data/art.json'),
  ledger = read('data/editorial/legacy-baseline.json');
const reviews = read('data/editorial/reviews.json');

test('the finite legacy ledger is unchanged and never approves incoming image IDs', () => {
  const bytes = readFileSync(new URL('../data/editorial/legacy-baseline.json', import.meta.url));
  const proof = read('data/editorial/legacy-baseline-provenance.json');
  assert.equal(Object.keys(ledger.records).length, 13004);
  assert.equal(proof.records, 13004);
  assert.equal(proof.allowNewIds, false);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '8a913cb086b2cc44883d7cdb235228ce13dfe5fa579bcb69a7dca40889795089',
  );
  for (const item of catalog.filter(
    (x) => x.sourceCollection === 'owner-tesla-commerce-550-2026-10-27',
  ))
    assert(!ledger.records[item.id]);
  assert.equal(reviewedImportCatalog(catalog, reviews).length, catalog.length);
});

test('new images in any future collection and changed legacy copy need source-bound reviews', () => {
  const old = catalog.find((x) => ledger.records[x.id]);
  assert.equal(reviewedImportCatalog([old], { schema: 1, artworks: [] }).length, 1);
  assert.throws(
    () =>
      reviewedImportCatalog(
        [{ ...old, id: 'future-unreviewed-artwork', sourceCollection: 'a-new-collection' }],
        { schema: 1, artworks: [] },
      ),
    /review required/i,
  );
  assert.throws(
    () =>
      reviewedImportCatalog([{ ...old, description: old.description + ' Changed text.' }], {
        schema: 1,
        artworks: [],
      }),
    /review required/i,
  );
});

test('future subjects need an inventory-bound short introduction and replacements invalidate it', () => {
  const fixture = { ...catalog[0], id: 'future-subject-example', topic: 'future-subject' };
  assert.throws(
    () => requiredCollectionIntroductions([fixture], { schema: 1, topics: {} }),
    /missing or stale/,
  );
  const record = {
    status: 'checked-against-catalog',
    sourceSha256: collectionSourceSignature([fixture]),
    intro: 'A white volleyball with curved panels.',
    checkedAt: '2026-10-27T00:00:00Z',
    evidence: [{ id: fixture.id, imageSha256: fixture.files.webp.sha256 }],
    // Synthetic evidence tests the same expanded-copy binding required by real
    // imports. It is never written into a production source registry.
    paragraphs: [
      'This test collection contains {{artworkCount}} example of a white volleyball with curved panels. Its short caption identifies the depicted ball rather than assigning an unrelated sport or character.',
      'Use the visible seams and rounded outline to distinguish this example from other sporting equipment. The test binds this expanded text to the same source inventory and summary as the public collection reader.',
    ],
    paragraphEvidence: [{ id: fixture.id, imageSha256: fixture.files.webp.sha256 }],
    paragraphsCheckedAt: '2026-10-27T00:00:00Z',
  };
  record.paragraphSourceSha256 = collectionParagraphSignature([fixture], record.intro);
  record.paragraphReviewSha256 = collectionParagraphReviewSignature(record);
  const registry = { schema: 1, topics: { 'future-subject': record } };
  assert.equal(
    requiredCollectionIntroductions([fixture], registry).get('future-subject'),
    record.intro,
  );
  assert.throws(
    () =>
      requiredCollectionIntroductions(
        [{ ...fixture, title: fixture.title + ' Changed' }],
        registry,
      ),
    /missing or stale/,
  );
  assert(
    readRequiredCollectionIntroductions(
      catalog,
      process.cwd(),
      readReviewedImportCatalog(process.cwd()),
    ).size >= 13,
  );
});

test('the audit reads the split collection registries used by the public catalog', () => {
  const root = new URL('..', import.meta.url).pathname;
  const report = readCollectionAudit(root);
  const expected = readRequiredCollectionIntroductions(
    catalog,
    root,
    readReviewedImportCatalog(root),
  );
  assert.equal(report.checkedIntroductions, expected.size);
  assert.equal(report.uniqueIntroductions, expected.size);
  assert.equal(
    report.checkedIntroductions + report.legacyTopicsAwaitingIntroductionReview,
    new Set(catalog.filter((item) => item.published && item.indexable).map((item) => item.topic))
      .size,
  );
});
