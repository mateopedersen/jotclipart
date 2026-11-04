import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  readCollectionRegistries,
  validateCollectionParagraphs,
  requiredCollectionIntroductions,
  verifyCollectionEditorial,
  collectionParagraphReviewSignature,
} from '../scripts/collection-editorial.mjs';
import { readReviewedImportCatalog } from '../scripts/reviewed-imports.mjs';
import { draftCollectionParagraphs } from '../scripts/collection-introduction-draft.mjs';

const root = new URL('../', import.meta.url).pathname;
const raw = JSON.parse(readFileSync(root + 'data/art.json'));
const publicCatalog = readReviewedImportCatalog(root);
const registry = readCollectionRegistries(root);
const items = publicCatalog.filter(
  (item) => item.topic === 'qatar-flag' && item.published && item.indexable,
);
const record = registry.topics['qatar-flag'];

test('every published topic has distinct, source-bound two or three paragraph copy', () => {
  const audit = verifyCollectionEditorial(raw, registry, publicCatalog);
  assert.equal(
    audit.expandedIntroductions,
    new Set(raw.filter((a) => a.published && a.indexable).map((a) => a.topic)).size,
  );
  const paragraphs = new Set();
  for (const [topic, entry] of Object.entries(registry.topics)) {
    assert.ok(entry.paragraphs.length >= 2 && entry.paragraphs.length <= 3, topic);
    for (const paragraph of entry.paragraphs) {
      assert.ok(!paragraphs.has(paragraph), `Repeated paragraph: ${topic}`);
      paragraphs.add(paragraph);
    }
  }
});

test('new and changed subjects cannot publish a missing, one-paragraph or stale expansion', () => {
  assert.equal(validateCollectionParagraphs('qatar-flag', items, record).length, 2);
  const edited = structuredClone(record);
  edited.paragraphs[1] += ' Changed wording.';
  assert.throws(
    () => validateCollectionParagraphs('qatar-flag', items, edited),
    /renewed catalog check/,
  );
  assert.throws(
    () =>
      validateCollectionParagraphs('qatar-flag', items, {
        ...record,
        paragraphs: [record.paragraphs.join(' ')],
      }),
    /two or three/,
  );
  assert.throws(
    () =>
      validateCollectionParagraphs('qatar-flag', items, {
        ...record,
        paragraphs: record.paragraphs.map((p) => p.replace('{{artworkCount}}', '100')),
      }),
    /live artwork count/,
  );
  const changed = structuredClone(items);
  changed[0].files.webp.sha256 = 'f'.repeat(64);
  assert.throws(
    () => validateCollectionParagraphs('qatar-flag', changed, record),
    /stale expanded/,
  );
  const retitled = structuredClone(items);
  retitled[0].title += ' changed';
  assert.throws(
    () => validateCollectionParagraphs('qatar-flag', retitled, record),
    /stale expanded/,
  );
  assert.throws(
    () =>
      validateCollectionParagraphs('qatar-flag', items, {
        ...record,
        intro: record.intro + ' Changed.',
      }),
    /stale expanded/,
  );
  const missing = structuredClone(registry);
  delete missing.topics['qatar-flag'].paragraphSourceSha256;
  assert.throws(
    () => requiredCollectionIntroductions(raw, missing, publicCatalog),
    /stale expanded/,
  );
});

test('draft assistance never manufactures a checked approval or visual inspection', () => {
  const draft = draftCollectionParagraphs(
    { slug: 'qatar-flag', keyword: 'Qatar flag clipart', cluster: 'Flags & countries' },
    items,
    record,
  );
  assert.equal(draft.status, 'draft-for-catalog-review');
  assert.equal(draft.paragraphs.length, 2);
  assert.equal(draft.paragraphsCheckedAt, undefined);
  assert.equal(draft.paragraphSourceSha256, undefined);
  assert.equal(draft.evidence.length, 2);
});

test('numeric-looking non-number topics and fungi cannot inherit contradictory learning copy', () => {
  for (const slug of ['007', '911', '1st']) {
    const source = publicCatalog.filter(
      (item) => item.topic === slug && item.published && item.indexable,
    );
    const good = registry.topics[slug];
    assert.equal(validateCollectionParagraphs(slug, source, good).length, 2);
    const bad = structuredClone(good);
    bad.paragraphs[1] += ' Choose a numeral treatment for a counting activity.';
    bad.paragraphReviewSha256 = collectionParagraphReviewSignature(bad);
    assert.throws(
      () => validateCollectionParagraphs(slug, source, bad),
      /number-learning use case/,
    );
  }
  const source = publicCatalog.filter(
    (item) => item.topic === 'mushroom' && item.published && item.indexable,
  );
  const bad = structuredClone(registry.topics.mushroom);
  bad.paragraphs[1] += ' Build a plant observation page with your own labels.';
  bad.paragraphReviewSha256 = collectionParagraphReviewSignature(bad);
  assert.throws(() => validateCollectionParagraphs('mushroom', source, bad), /fungi-specific/);
});

test('drafts use reviewed subject meaning rather than a numeric slug and still require review', () => {
  for (const [slug, expected] of [
    ['007', /spy story/],
    ['911', /emergency services/],
    ['mushroom', /fungi observation/],
    ['unicorn', /fantasy story/],
  ]) {
    const source = publicCatalog.filter(
      (item) => item.topic === slug && item.published && item.indexable,
    );
    const draft = draftCollectionParagraphs(
      { slug, keyword: slug + ' clipart', cluster: 'People & activities' },
      source,
      registry.topics[slug],
    );
    assert.match(draft.paragraphs[1], expected);
    assert.doesNotMatch(
      draft.paragraphs[1],
      /numeral treatment|counting activity|plant observation|animal study/,
    );
    assert.equal(draft.status, 'draft-for-catalog-review');
    assert.equal(draft.paragraphReviewSha256, undefined);
  }
  const future = draftCollectionParagraphs(
    { slug: '112', keyword: 'Emergency services clipart', cluster: 'People & activities' },
    publicCatalog.filter((item) => item.topic === '911'),
    registry.topics['911'],
  );
  assert.doesNotMatch(future.paragraphs[1], /numeral treatment|counting activity/);
  const number = draftCollectionParagraphs(
    { slug: '10', keyword: '10 clipart', cluster: 'School & learning' },
    publicCatalog.filter((item) => item.topic === '10'),
    registry.topics['10'],
  );
  assert.match(number.paragraphs[1], /counting activity/);
});

test('shared renderer uses actual paragraphs and the automatic topic counter', () => {
  const component = readFileSync(root + 'src/components/CollectionIntroduction.astro', 'utf8');
  const page = readFileSync(root + 'src/pages/clipart/[slug].astro', 'utf8');
  assert.match(component, /paragraphs\.map/);
  assert.match(component, /CollectionCountCopy topic=\{topic\}/);
  assert.match(page, /<CollectionIntroduction topic=\{topic.slug\} paragraphs=\{paragraphs\}/);
  assert.doesNotMatch(page, /set:html=\{paragraphs/);
});
