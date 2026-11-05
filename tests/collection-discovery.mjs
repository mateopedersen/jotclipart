import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript } from './helpers/typescript.mjs';
const { latestSubjectCollections } = await loadTypescript('src/lib/collection-discovery.ts');
const subjects = [
  {
    slug: 'new-animal',
    name: 'New Animal',
    count: 2,
    sample: { thumb: '/a.webp', alt: 'Animal', title: 'Animal' },
  },
  {
    slug: 'flower',
    name: 'Flower',
    count: 1,
    sample: { thumb: '/b.webp', alt: 'Flower', title: 'Flower' },
  },
];
test('new subjects appear automatically with their existing canonical collection route', () => {
  const items = latestSubjectCollections(subjects, [
    { id: 'new', topic: 'new-animal', published: true, indexable: true },
    { id: 'older', topic: 'flower', published: true, indexable: true },
  ]);
  assert.equal(items[0].href, '/clipart/new-animal/');
  assert.equal(items[0].count, 2);
  assert.equal(items[1].href, '/clipart/flower/');
});
test('an addition to an existing subject updates one collection rather than making duplicates', () =>
  assert.equal(
    latestSubjectCollections(subjects, [
      { id: 'a', topic: 'flower' },
      { id: 'b', topic: 'flower' },
    ]).length,
    1,
  ));
test('draft and unknown content cannot generate empty collection cards', () =>
  assert.deepEqual(
    latestSubjectCollections(subjects, [
      { id: 'draft', topic: 'flower', published: false },
      { id: 'unknown', topic: 'missing' },
    ]),
    [],
  ));

test('updated collection cover uses the newest artwork and its own metadata', () => {
  const recent = {
    id: 'recent',
    topic: 'flower',
    published: true,
    indexable: true,
    thumb: '/new.webp',
    webp: '/new.webp',
    alt: 'A yellow flower.',
    title: 'Yellow Flower',
  };
  const [card] = latestSubjectCollections(subjects, [recent]);
  assert.equal(card.latestArtworkId, recent.id);
  assert.equal(card.sample.thumb, recent.webp);
  assert.equal(card.sample.alt, recent.alt);
  assert.equal(card.sample.title, recent.title);
  const [fallback] = latestSubjectCollections(subjects, [{ ...recent, alt: '' }]);
  assert.deepEqual(fallback.sample, subjects[1].sample);
});

test('collection limit is validated before returning any cards', () => {
  const items = [{ id: 'a', topic: 'flower' }];
  assert.deepEqual(latestSubjectCollections(subjects, items, 0), []);
  for (const limit of [-1, 1.5, NaN])
    assert.throws(() => latestSubjectCollections(subjects, items, limit));
});

test('recent covers expose a verified R2 thumbnail alongside the canonical original', () => {
  const artwork = {
    id: 'recent-r2',
    topic: 'flower',
    thumb: 'https://assets.ultraclipart.com/flower/original.webp',
    webp: 'https://assets.ultraclipart.com/flower/original.webp',
    originalThumb: 'https://assets.ultraclipart.com/flower/thumbnail.webp',
    alt: 'A yellow flower.',
    title: 'Yellow Flower',
    files: { webp: { sha256: 'a'.repeat(64) }, thumb: { sha256: 'b'.repeat(64) } },
  };
  const [card] = latestSubjectCollections(subjects, [artwork]);
  assert.equal(card.sample.webp, artwork.webp);
  assert.equal(card.sample.preview, artwork.originalThumb);

  const [unverified] = latestSubjectCollections(subjects, [{ ...artwork, files: undefined }]);
  assert.equal(unverified.sample.preview, undefined);
  assert.equal(unverified.sample.webp, artwork.webp);
});
