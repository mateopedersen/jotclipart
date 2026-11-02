import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadTypescript } from './helpers/typescript.mjs';
import { assertOwnerPdfColorCatalog } from '../src/lib/file-review-policy.mjs';

const registry = JSON.parse(readFileSync('data/editorial/owner-75-pdf-exceptions-20261101.json'));
const replacements = JSON.parse(readFileSync('data/editorial/owner-75-reviewed-pdf-replacements-20261101.json'));
const live = JSON.parse(readFileSync('data/art.json'));
const { hasUsableFileReview } = await loadTypescript('src/lib/file-review.ts');
const { downloadDetails } = await loadTypescript('src/lib/download-data.ts');
const { RelatedIndex, REGISTERED_TOPICS } = await loadTypescript('tests/helpers/related-owner-pdf-entry.ts');
const { buildSearchIndex } = await loadTypescript('src/lib/search-index.ts');
const { SearchRepository, SearchHttpError } = await loadTypescript('src/lib/search-remote.ts');
const { defaults } = await loadTypescript('src/lib/search.ts');
const examples = Object.entries(registry.records).filter(([, entry]) => entry.topic === 'jeep' && entry.ownerDirectionActive).slice(0, 3);
assert.equal(examples.length, 3);

test('the authorized source-bound registry is complete and has its exact checked bytes', () => {
  const bytes = readFileSync('data/editorial/owner-75-pdf-exceptions-20261101.json');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'a0b917b81182a55cc2326d0b8f448c00a3675dd556973150ec516013173ef5cf');
  assert.equal(registry.count, 781);
  assert.equal(Object.keys(registry.records).length, registry.count);
  assert.equal(Object.values(registry.records).filter((entry) => entry.ownerDirectionActive).length, 777);
  assert.equal(Object.values(registry.records).filter((entry) => !entry.ownerDirectionActive).length, 4);
  assert.equal(registry.ownerDirectionSha256, 'e26a250a96daa9b875b1353dc554834dbe73813d4198daa80d5ce7f19e5f2fc4');
  assert.equal(registry.scopeRevisionSha256, 'e462a63610ed7463a8a1bfd0cf0d0e13a58e53bdc5a1deeb587a8e2f8b3a5031');
  const replacementBytes = readFileSync('data/editorial/owner-75-reviewed-pdf-replacements-20261101.json');
  assert.equal(createHash('sha256').update(replacementBytes).digest('hex'), '288ee72810e1f98443612058468cbe7a18c4a79db57fce357065d90a8e1ebe86');
  assert.equal(replacements.count, 4);
  assert.equal(Object.keys(replacements.records).length, 4);
  for (const [identity, entry] of Object.entries(registry.records)) {
    assert.match(identity, /^(60|8):[a-z0-9-]+:[1-9][0-9]*$/);
    assert.match(entry.imageSha256, /^[a-f0-9]{64}$/);
    assert.match(entry.pdfSha256, /^[a-f0-9]{64}$/);
  }
});

function exceptionItem(index) {
  const [sourceOriginalId, entry] = examples[index];
  const id = `jeep-source-bound-test-${index}`;
  return {
    ...live[0], id, topic: entry.topic, title: `Jeep Car Illustration ${index}`,
    alt: 'A Jeep car illustration shown from the side.',
    description: 'A stylized car is shown from the side.',
    webp: `/catalog/jeep/${id}.webp`, pdf: `/catalog/jeep/${id}.pdf`,
    thumb: `/catalog/jeep/${id}-thumb.webp`, revision: 1,
    published: true, indexable: true, licenseStatus: 'OWNER_APPROVED_PERSONAL_EDUCATIONAL_ONLY',
    reviewStatus: 'FORMAT_OWNER_ORIGINAL_ADDITIONAL_PDF_REVIEW_SKIPPED',
    sourceCollection: registry.sourceCollection, sourceOriginalId, sourceOriginalSha256: entry.imageSha256,
    pdfColorReview: {
      status: registry.status, ownerDirectionSha256: registry.ownerDirectionSha256,
      scopeRevisionSha256: registry.scopeRevisionSha256,
      sourceImageSha256: entry.imageSha256, originalPdfSha256: entry.pdfSha256, visualColorApproved: false, visualPairApproved: false,
    },
    files: {
      webp: { bytes: 222, sha256: entry.imageSha256 },
      pdf: { bytes: 333, sha256: entry.pdfSha256 },
      thumb: { bytes: 100, sha256: entry.imageSha256 },
    },
  };
}

test('an exact owner-directed original can be downloaded without claiming visual color approval', () => {
  const item = exceptionItem(0);
  assert.equal(hasUsableFileReview(item), true);
  assert.equal(item.pdfColorReview.visualColorApproved, false);
  assert.equal(item.pdfColorReview.visualPairApproved, false);
  const result = downloadDetails(item);
  assert.equal(result.files.webp.sha256, item.files.webp.sha256);
  assert.equal(result.files.pdf.sha256, item.files.pdf.sha256);
  assert.equal(result.files.pdf.bytes, item.files.pdf.bytes);
});

test('source replacement, wrong collection, topic, owner decision or misleading status fail closed', () => {
  const item = exceptionItem(0);
  const invalid = [
    { ...item, sourceCollection: 'unrelated-import' },
    { ...item, sourceOriginalId: '60:kia:9999' },
    { ...item, sourceOriginalId: '__proto__' },
    { ...item, topic: 'other' },
    { ...item, sourceOriginalSha256: '0'.repeat(64) },
    { ...item, pdf: undefined },
    { ...item, files: { ...item.files, webp: { ...item.files.webp, sha256: '0'.repeat(64) } } },
    { ...item, files: { ...item.files, pdf: { ...item.files.pdf, sha256: 'f'.repeat(64) } } },
    { ...item, pdfColorReview: undefined },
    { ...item, pdfColorReview: { ...item.pdfColorReview, ownerDirectionSha256: '0'.repeat(64) } },
    { ...item, pdfColorReview: { ...item.pdfColorReview, scopeRevisionSha256: '0'.repeat(64) } },
    { ...item, pdfColorReview: { ...item.pdfColorReview, visualColorApproved: true } },
    { ...item, pdfColorReview: { ...item.pdfColorReview, visualPairApproved: true } },
    { ...item, reviewStatus: 'FAILED' },
  ];
  for (const bad of invalid) {
    assert.equal(hasUsableFileReview(bad), false);
    assert.equal(downloadDetails(bad), undefined);
  }
  for (const bad of [{ ...item, published: false }, { ...item, indexable: false }, { ...item, licenseStatus: 'UNKNOWN' }])
    assert.equal(downloadDetails(bad), undefined);
});

test('the latest direction permits exact 60-set originals while recording skipped visual reviews', () => {
  const [sourceOriginalId, entry] = Object.entries(registry.records).find(([id, record]) => id.startsWith('60:') && record.ownerDirectionActive);
  const item = exceptionItem(0);
  Object.assign(item, { sourceOriginalId, topic: entry.topic, sourceOriginalSha256: entry.imageSha256,
    files: { ...item.files, webp: { bytes: 222, sha256: entry.imageSha256 }, pdf: { bytes: 333, sha256: entry.pdfSha256 } },
    pdfColorReview: { ...item.pdfColorReview, sourceImageSha256: entry.imageSha256, originalPdfSha256: entry.pdfSha256 } });
  assert.equal(hasUsableFileReview(item), true);
  assert.equal(downloadDetails(item).files.pdf.sha256, entry.pdfSha256);
  assert.equal(item.pdfColorReview.visualPairApproved, false);
  assert.equal(item.pdfColorReview.visualColorApproved, false);
  assert.equal(hasUsableFileReview({ ...item, reviewStatus: 'FORMAT_AND_PAIR_REVIEW_PASSED' }), false);
});

test('a reviewed replacement must match its exact source, PDF and review registry', () => {
  const [sourceOriginalId, entry] = Object.entries(replacements.records)[0];
  const original = registry.records[sourceOriginalId];
  const id = 'reviewed-owner-replacement';
  const item = { ...live[0], id, topic: entry.topic, sourceCollection: registry.sourceCollection,
    sourceOriginalId, sourceOriginalSha256: entry.imageSha256, reviewStatus: 'FORMAT_AND_PAIR_REVIEW_PASSED',
    pdfColorReview: undefined, pdf: `/catalog/${entry.topic}/${id}.pdf`,
    files: { webp: { bytes: 222, sha256: entry.imageSha256 }, pdf: { bytes: 333, sha256: entry.reviewedPdfSha256 },
      thumb: { bytes: 100, sha256: entry.imageSha256 } } };
  assert.equal(hasUsableFileReview(item), true);
  assert.equal(downloadDetails(item).files.pdf.sha256, entry.reviewedPdfSha256);
  assert.doesNotThrow(() => assertOwnerPdfColorCatalog([item]));
  const invalid = [
    { ...item, sourceCollection: 'other' },
    { ...item, sourceOriginalId: '__proto__' },
    { ...item, sourceOriginalSha256: '0'.repeat(64) },
    { ...item, topic: 'other' },
    { ...item, files: { ...item.files, webp: { ...item.files.webp, sha256: '0'.repeat(64) } } },
    { ...item, files: { ...item.files, pdf: { ...item.files.pdf, sha256: 'f'.repeat(64) } } },
    { ...item, files: { ...item.files, pdf: { ...item.files.pdf, sha256: original.pdfSha256 } } },
    { ...item, pdfColorReview: { status: registry.status } },
  ];
  for (const bad of invalid) {
    assert.equal(hasUsableFileReview(bad), false);
    assert.equal(downloadDetails(bad), undefined);
    assert.throws(() => assertOwnerPdfColorCatalog([bad]), /requires an exact reviewed replacement/);
  }
});

test('the existing reviewed-pair behavior is preserved', () => {
  const prior = live.find((item) => item.reviewStatus === 'FORMAT_AND_PAIR_REVIEW_PASSED' && item.pdf);
  assert.ok(prior);
  assert.equal(hasUsableFileReview(prior), true);
  assert.equal(downloadDetails(prior).files.pdf.sha256, prior.files.pdf.sha256);
  assert.equal(hasUsableFileReview({ ...prior, reviewStatus: 'FAILED' }), false);
});

test('catalog preflight rejects stale, duplicate or falsely passed owner exceptions', () => {
  const a = exceptionItem(0), b = exceptionItem(1);
  assert.deepEqual(assertOwnerPdfColorCatalog([a, b]), {
    ownerDirectedOriginals: 2, visuallyApprovedByDirection: false,
  });
  assert.throws(() => assertOwnerPdfColorCatalog([a, { ...a, id: 'duplicate-source' }]), /Duplicate owner PDF/);
  assert.throws(() => assertOwnerPdfColorCatalog([{ ...a, reviewStatus: 'FORMAT_AND_PAIR_REVIEW_PASSED' }]), /requires an exact reviewed replacement/);
  assert.equal(hasUsableFileReview({ ...a, reviewStatus: 'FORMAT_AND_PAIR_REVIEW_PASSED', sourceCollection: 'other' }), false);
  assert.throws(() => assertOwnerPdfColorCatalog([{ ...a, reviewStatus: 'FORMAT_AND_PAIR_REVIEW_PASSED', sourceCollection: 'other' }]), /requires an exact reviewed replacement/);
  assert.throws(() => assertOwnerPdfColorCatalog([{ ...a, files: { ...a.files, pdf: { ...a.files.pdf, sha256: 'f'.repeat(64) } } }]), /Invalid owner PDF/);
  assert.throws(() => assertOwnerPdfColorCatalog([{ ...a, sourceCollection: 'other' }]), /Invalid owner PDF/);
  // The same gate must work before the atomic catalog promotion and after it.
  // Never treat an owner-directed original as a visually reviewed pair.
  const present = live.filter((item) => Object.hasOwn(registry.records, item.sourceOriginalId ?? ''));
  assert.ok([0, registry.count].includes(present.length), 'Owner PDF source catalog is only partially promoted');
  const seen = new Set();
  let originals = 0, reviewedReplacements = 0;
  for (const item of present) {
    assert.ok(!seen.has(item.sourceOriginalId), 'Duplicate source-bound owner record');
    seen.add(item.sourceOriginalId);
    const entry = registry.records[item.sourceOriginalId];
    assert.equal(item.sourceCollection, registry.sourceCollection);
    assert.equal(item.topic, entry.topic);
    assert.equal(item.sourceOriginalSha256, entry.imageSha256);
    assert.equal(item.files.webp.sha256, entry.imageSha256);
    assert.equal(hasUsableFileReview(item), true);
    if (entry.ownerDirectionActive) {
      originals++;
      assert.equal(item.reviewStatus, 'FORMAT_OWNER_ORIGINAL_ADDITIONAL_PDF_REVIEW_SKIPPED');
      assert.equal(item.files.pdf.sha256, entry.pdfSha256);
      assert.equal(item.pdfColorReview.visualColorApproved, false);
      assert.equal(item.pdfColorReview.visualPairApproved, false);
    } else {
      reviewedReplacements++;
      assert.equal(item.reviewStatus, 'FORMAT_AND_PAIR_REVIEW_PASSED');
      assert.equal(item.files.pdf.sha256, replacements.records[item.sourceOriginalId].reviewedPdfSha256);
    }
  }
  if (present.length) {
    assert.equal(originals, registry.activeOwnerDirectionCount);
    assert.equal(reviewedReplacements, replacements.count);
  }
  const summary = assertOwnerPdfColorCatalog(live);
  assert.equal(summary.ownerDirectedOriginals, originals);
  assert.equal(summary.visuallyApprovedByDirection, false);
  // Simulate the exact pre-promotion state without changing the catalog.
  const prior = live.filter((item) => !Object.hasOwn(registry.records, item.sourceOriginalId ?? ''));
  assert.equal(assertOwnerPdfColorCatalog(prior).ownerDirectedOriginals, 0);
});

test('related cards retain authorized PDFs and reject changed files across recommendation groups', () => {
  // A classified topic may rank a valid card as an alternative; an unclassified
  // one may rank it in the collection lane. Both preserve the file contract.
  const previouslyRegistered = REGISTERED_TOPICS.has('jeep');
  REGISTERED_TOPICS.add('jeep');
  try {
    for (const classified of [true, false]) {
      const a = exceptionItem(0), b = exceptionItem(1), changed = exceptionItem(2);
      if (!classified) for (const item of [a, b, changed]) {
        item.title = 'A vehicle illustration'; item.alt = 'A vehicle shown from the side.';
      }
      changed.files.pdf.sha256 = 'f'.repeat(64);
      const index = new RelatedIndex([a, b, changed]);
      assert.equal(index.profiles.get(a.id).publicationEligible, true);
      assert.equal(index.profiles.get(b.id).publicationEligible, true);
      assert.equal(index.profiles.get(changed.id).publicationEligible, false);
      const result = index.snapshot(a.id);
      const cards = [...result.alternatives, ...result.companions, ...result.collection];
      const selected = cards.filter((card) => card.id === b.id);
      assert.equal(selected.length, 1);
      assert.equal(selected[0].pdf, b.pdf);
      assert.equal(downloadDetails(b).files.pdf.sha256, registry.records[b.sourceOriginalId].pdfSha256);
      assert.ok(cards.every((card) => card.id !== changed.id));
      if (!classified) assert.equal(selected[0].group, 'collection');
      const invalid = [
        { ...b, files: { ...b.files, pdf: { ...b.files.pdf, sha256: 'f'.repeat(64) } } },
        { ...b, files: { ...b.files, webp: { ...b.files.webp, sha256: '0'.repeat(64) } } },
        { ...b, topic: 'other' },
        { ...b, reviewStatus: 'FORMAT_AND_PAIR_REVIEW_PASSED' },
        { ...b, pdfColorReview: { ...b.pdfColorReview, visualPairApproved: true } },
      ];
      for (const candidate of invalid) {
        const rejected = new RelatedIndex([a, candidate]);
        assert.equal(rejected.profiles.get(candidate.id).publicationEligible, false);
        const snapshot = rejected.snapshot(a.id);
        assert.ok([...snapshot.alternatives, ...snapshot.companions, ...snapshot.collection]
          .every((card) => card.id !== candidate.id));
        assert.equal(downloadDetails(candidate), undefined);
      }
    }
  } finally { if (!previouslyRegistered) REGISTERED_TOPICS.delete('jeep'); }
});

test('promoted owner source records retain their exact PDF in related results', () => {
  const present = examples.map(([sourceOriginalId]) => live.find((item) => item.sourceOriginalId === sourceOriginalId));
  if (present.every((item) => !item)) return; // The pre-promotion catalog has no such records.
  assert.ok(present.every(Boolean), 'Owner source records are only partially promoted');
  const [a, b, source] = present;
  const bad = { ...source, files: { ...source.files, pdf: { ...source.files.pdf, sha256: 'f'.repeat(64) } } };
  const index = new RelatedIndex([a, b, bad]);
  assert.equal(index.profiles.get(a.id).publicationEligible, true);
  assert.equal(index.profiles.get(b.id).publicationEligible, true);
  assert.equal(index.profiles.get(bad.id).publicationEligible, false);
  const result = index.snapshot(a.id);
  const cards = [...result.alternatives, ...result.companions, ...result.collection];
  const selected = cards.filter((card) => card.id === b.id);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].pdf, b.pdf);
  assert.equal(downloadDetails(b).files.pdf.sha256, registry.records[b.sourceOriginalId].pdfSha256);
  assert.ok(cards.every((card) => card.id !== bad.id));
  assert.equal(downloadDetails(bad), undefined);
  assert.equal(b.pdfColorReview.visualColorApproved, false);
  assert.equal(b.pdfColorReview.visualPairApproved, false);
});

test('search cards retain exact downloadable original hashes for the selected source', async () => {
  const items = [exceptionItem(0), exceptionItem(1)].map((item) => ({
    ...item, download: downloadDetails(item), cluster: 'Objects', topicLabel: 'Jeep clipart',
  }));
  const build = buildSearchIndex(items, [{ slug: 'jeep', keyword: 'Jeep clipart' }], 'owner-pdf-test');
  const loader = async (url) => {
    const key = url.replace(/^\/search-data\//, '').replace(/\.json$/, '');
    if (!build.files.has(key)) throw new SearchHttpError(404);
    return structuredClone(build.files.get(key));
  };
  const repo = new SearchRepository(loader);
  const result = await repo.search({ ...defaults, q: 'jeep' });
  assert.equal(result.total, 2);
  for (const card of result.items) {
    const source = items.find((item) => item.id === card.id);
    assert.ok(source);
    assert.equal(card.download.files.pdf.sha256, source.files.pdf.sha256);
    assert.equal(card.download.files.webp.sha256, source.files.webp.sha256);
  }
});
