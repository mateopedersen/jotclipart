import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  readCollectionRegistries,
  validateCollectionParagraphs,
  requiredCollectionIntroductions,
  verifyCollectionEditorial,
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

test('shared renderer uses actual paragraphs and the automatic topic counter', () => {
  const component = readFileSync(root + 'src/components/CollectionIntroduction.astro', 'utf8');
  const page = readFileSync(root + 'src/pages/clipart/[slug].astro', 'utf8');
  assert.match(component, /paragraphs\.map/);
  assert.match(component, /CollectionCountCopy topic=\{topic\}/);
  assert.match(page, /<CollectionIntroduction topic=\{topic.slug\} paragraphs=\{paragraphs\}/);
  assert.doesNotMatch(page, /set:html=\{paragraphs/);
});
